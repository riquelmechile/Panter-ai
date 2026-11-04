/** GitHub for the workforce: Panter holds one operator token server-side and lets workers use it only
 * through narrow, audited operations, scoped to one delegated work and to the grant the leader attached.
 *
 * - The token never leaves the server: it is not in packets, results, logs or the repository.
 * - Every request is pinned to https://api.github.com/repos/<granted repo>/... and checked AFTER URL
 *   parsing, so encoded traversal can never reach another repository or the rest of the API.
 * - Reads: an allowlist of repository resources (code, git objects, PRs, issues, commits, branches, tags,
 *   releases, checks). No secrets, variables, logs, artifacts, alerts, settings or admin data.
 * - Writes need the matching grant operation and a live lease, re-checked right before each mutation:
 *   commits only to the grant's own panter/ branch, which Panter creates (never an existing, protected or
 *   default branch; never CI, CODEOWNERS or git config files; never forced); pull requests only from that
 *   branch; comments only on issues/PRs the leader listed or this grant opened, without bot commands.
 * - There is no merge, approve, delete, label, release, settings or secrets operation at all.
 */
import {SqliteLedger} from './sqlite-ledger.js';

export const GITHUB_WRITE_OPS=['commit','pr','comment','issue'] as const;
export type GitHubWriteOp=typeof GITHUB_WRITE_OPS[number];
export type GitHubGrant={workId:string;host:string;repository:string;ops:GitHubWriteOp[];branch:string|null;
  base:string|null;numbers:number[];branchCreated:boolean;createdAt:string;revokedAt:string|null;writes:number;reads:number};
type Audit={at:string;workId:string;host:string;repository:string;op:string;ref:string;outcome:string};
type Data={version:1;grants:GitHubGrant[];audit:Audit[]};
const seed:Data={version:1,grants:[],audit:[]};
type Claim={workId:string;attemptId:string;leaseGeneration:number};

export type WorkforceMesh={
  liveWork(caller:string,id:string,attemptId:string,generation:number):Promise<{id:string;target:string;role:string}>;
  workTarget(caller:string,id:string):Promise<{id:string;target:string;role:string;state:string}>;
};
export type FileChange={path:string;content?:string;delete?:boolean};
export type GrantInput={repository:string;ops:GitHubWriteOp[];branch?:string;base?:string;numbers?:number[]};
export class GitHubWorkforceError extends Error{}

const API='https://api.github.com';
const REPO=/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const SEGMENT=/^[A-Za-z0-9._~@:+=,-]{1,200}$/;
const PROTECTED=/^(main|master|develop|dev|trunk|production|prod|staging|gh-pages|release(\/.*)?|hotfix(\/.*)?)$/i;
const MAX_WRITES_PER_WORK=200;
const MAX_READS_PER_WORK=1500;
const MAX_FILES=50;
const MAX_FILE_BYTES=1_000_000;
const MAX_READ_BYTES=400_000;
const MAX_RESPONSE_BYTES=2_000_000;
const TERMINAL=new Set(['COMPLETED','FAILED','ABORTED_NO_EFFECTS']);
const iso=()=>new Date().toISOString();
const fail=(m:string):never=>{throw new GitHubWorkforceError(m);};
function check(v:unknown,m:string):asserts v{if(!v)fail(m);}

/** Repository allowlist entries: "owner/repo" or "owner/*". */
export function repoAllowed(allow:readonly string[],repository:string){
  if(!REPO.test(repository)||repository.split('/').some(p=>p==='.'||p==='..'))return false;
  const [owner]=repository.toLowerCase().split('/');
  return allow.some(a=>{const x=a.toLowerCase();return x===repository.toLowerCase()||x===`${owner}/*`;});
}
/** A git branch name per git check-ref-format, without anything a URL parser could reinterpret. */
export function validRefName(name:string){
  if(typeof name!=='string'||!name||name.length>200||name.endsWith('/')||name.startsWith('/')||name.includes('//')||
    name.includes('@{')||name==='@')return false;
  return name.split('/').every(c=>SEGMENT.test(c)&&!c.startsWith('.')&&!c.endsWith('.')&&!c.endsWith('.lock')&&!c.includes('..'));
}
const refPath=(name:string)=>name.split('/').map(encodeURIComponent).join('/');
/** A file path a worker may change: relative, no traversal, never CI, ownership or git configuration. */
export function safeRepoPath(path:string){
  if(typeof path!=='string'||!path||path.length>400||path.startsWith('/')||path.endsWith('/')||path.includes('\\')||path.includes('\0'))return false;
  const parts=path.split('/');
  if(parts.some(p=>!p||p==='.'||p==='..'))return false;
  const lower=parts.map(p=>p.toLowerCase());
  if(lower[0]==='.github'||lower[0]==='.circleci'||lower[0]==='.buildkite'||lower[0]==='.gitlab'||lower.includes('.git'))return false;
  const name=lower.at(-1)!;
  const denied=new Set(['codeowners','.gitmodules','.gitattributes','.gitlab-ci.yml','.travis.yml','jenkinsfile',
    'azure-pipelines.yml','bitbucket-pipelines.yml','.drone.yml','appveyor.yml','cloudbuild.yaml','cloudbuild.yml']);
  return !denied.has(name);
}
/** Repository resources workers may GET (path below repos/{owner}/{repo}/), checked segment by segment. */
export function safeReadPath(path:string){
  if(typeof path!=='string'||!path||path.length>500||/[\s#\\%]/.test(path))return false;
  const [rawPath,query='']=path.split('?',2) as [string,string?];
  const segs=rawPath!.split('/');
  if(segs.some(s=>!SEGMENT.test(s)||s==='.'||s==='..'))return false;
  if(query&&!/^[A-Za-z0-9._~:+=,&\/-]{1,300}$/.test(query))return false;
  const lower=segs.map(s=>s.toLowerCase());
  if(lower.some(s=>['secrets','variables','logs','artifacts','protection','keys','hooks','collaborators','invitations',
    'environments','deployments','alerts','attempts','caches','permissions','runners','pending_deployments','timing'].includes(s)))return false;
  const [a,b]=lower;
  switch(a){
    case 'contents': case 'readme': case 'commits': case 'compare': case 'pulls': case 'issues': case 'branches':
    case 'tags': case 'releases': case 'languages': case 'check-runs': case 'check-suites': return true;
    case 'git': return ['trees','blobs','commits','ref','refs','tags'].includes(b??'');
    case 'actions': return b==='runs'||b==='workflows';
    default: return false;
  }
}
/** Drop fields that carry temporary credentials (raw download tokens) before handing data to a worker. */
function sanitize(value:unknown):unknown{
  return JSON.parse(JSON.stringify(value,(k,v)=>
    k==='download_url'||k==='git_url'||k==='archive_url'?undefined:
    typeof v==='string'&&/[?&](token|X-Amz-Signature|sig)=/i.test(v)?'[redacted temporary link]':v));
}
/** Lines that could drive merge/ChatOps bots when posted under the owner's identity. */
const BOT_COMMAND=/^\s*(\/[A-Za-z]|@[A-Za-z0-9-]+(\[bot\])?\s+(merge|squash|rebase|recreate|approve|deploy|ship|r\+)|bors\s|@?mergify|@?kodiak)/im;

export class GitHubWorkforce{
  readonly configured:boolean;
  private readonly allow:string[];
  private readonly token:string;
  private readonly db:SqliteLedger|null;
  private readonly chains=new Map<string,Promise<unknown>>();
  constructor(dir:string,private readonly mesh:WorkforceMesh,private readonly leader:()=>string,
    env:Record<string,string|undefined>=process.env,private readonly fetcher:typeof fetch=fetch){
    this.token=(env.PANTER_GITHUB_WORKFORCE_TOKEN??'').trim();
    this.allow=(env.PANTER_GITHUB_WORKFORCE_REPOS??'').split(',').map(x=>x.trim()).filter(Boolean);
    for(const a of this.allow)check(/^[A-Za-z0-9_.-]{1,100}\/([A-Za-z0-9_.-]{1,100}|\*)$/.test(a)&&!a.split('/').some(p=>p==='.'||p==='..'),
      `Invalid PANTER_GITHUB_WORKFORCE_REPOS entry: ${a}`);
    this.configured=Boolean(this.token)&&this.allow.length>0;
    this.db=this.configured?SqliteLedger.open(dir):null;
  }
  describe(){return {configured:this.configured,repositories:this.allow,
    operations:{read:'repository resources of a granted work',write:[...GITHUB_WRITE_OPS]},
    never:['merge','approve','delete','force-push','existing/protected/default branches','CI/CODEOWNERS/git config files','secrets','settings']};}

  private ensure(){check(this.configured,'GitHub workforce is not configured (PANTER_GITHUB_WORKFORCE_TOKEN and PANTER_GITHUB_WORKFORCE_REPOS)');}
  /** Mutations of one repository branch run one at a time; other branches and repositories are not blocked. */
  private serial<T>(key:string,fn:()=>Promise<T>):Promise<T>{
    const prev=this.chains.get(key)??Promise.resolve();
    const p=prev.then(fn,fn);
    const tail=p.then(()=>{},()=>{});
    this.chains.set(key,tail);
    void tail.then(()=>{if(this.chains.get(key)===tail)this.chains.delete(key);});
    return p;
  }

  // ---- leader ----
  /** Pure validation, usable before creating the work. */
  validateGrant(input:GrantInput){
    this.ensure();
    check(repoAllowed(this.allow,input.repository),'Repository is not in PANTER_GITHUB_WORKFORCE_REPOS');
    const ops=[...new Set(input.ops)];
    check(ops.every(o=>(GITHUB_WRITE_OPS as readonly string[]).includes(o)),'Unknown GitHub operation');
    if(input.branch!==undefined)check(validRefName(input.branch)&&input.branch.startsWith('panter/')&&!PROTECTED.test(input.branch),
      'Working branch must be a valid new branch name under panter/');
    if(input.base!==undefined)check(validRefName(input.base),'Invalid base branch');
    const numbers=[...new Set(input.numbers??[])];
    check(numbers.length<=20&&numbers.every(n=>Number.isInteger(n)&&n>0),'Invalid issue/PR numbers');
    return {ops,numbers};
  }
  async grant(caller:string,input:{workId:string}&GrantInput){
    this.ensure();
    check(caller===this.leader(),'Only the leader grants GitHub access');
    const {ops,numbers}=this.validateGrant(input);
    const existing=this.db!.read('github_workforce',seed).grants.find(x=>x.workId===input.workId);
    check(!existing?.revokedAt,'This work\'s GitHub grant was revoked; delegate a new work');
    const work=await this.mesh.workTarget(caller,input.workId);
    check(work.target!==this.leader(),'Leader work cannot hold a GitHub grant');
    const needsBranch=ops.includes('commit')||ops.includes('pr');
    const branch=needsBranch?(input.branch??`panter/${work.target}-${work.id.slice(0,8)}`):null;
    const base=input.base??null;
    // An identical replay (e.g. an idempotent delegate retry) returns the grant untouched, even after completion.
    if(existing&&existing.repository===input.repository&&JSON.stringify(existing.ops)===JSON.stringify(ops)&&
      existing.branch===branch&&existing.base===base&&JSON.stringify(existing.numbers)===JSON.stringify(numbers))return existing;
    check(!TERMINAL.has(work.state),'Work is finished');
    check(!existing||!existing.branchCreated||existing.branch===branch,'The working branch cannot change after it was created');
    const g:GitHubGrant={workId:work.id,host:work.target,repository:input.repository,ops,branch,base,numbers,
      branchCreated:existing?.branchCreated??false,createdAt:iso(),revokedAt:null,writes:existing?.writes??0,reads:existing?.reads??0};
    this.db!.mutate('github_workforce',seed,d=>{
      const i=d.grants.findIndex(x=>x.workId===g.workId);
      if(i>=0)d.grants[i]=g;else d.grants.push(g);
      d.grants=d.grants.slice(-5000);
    });
    return g;
  }
  async revoke(caller:string,workId:string){
    this.ensure();
    check(caller===this.leader(),'Only the leader revokes GitHub access');
    let found=false;
    this.db!.mutate('github_workforce',seed,d=>{const g=d.grants.find(x=>x.workId===workId);if(g&&!g.revokedAt){g.revokedAt=iso();found=true;}});
    return {workId,revoked:found};
  }
  audit(caller:string,workId?:string){
    this.ensure();
    check(caller===this.leader(),'Only the leader reads the GitHub audit');
    const d=this.db!.read('github_workforce',seed);
    return {grants:d.grants.filter(g=>!workId||g.workId===workId).slice(-50),
      audit:d.audit.filter(a=>!workId||a.workId===workId).slice(-100)};
  }

  // ---- worker ----
  private current(workId:string){return this.db!.read('github_workforce',seed).grants.find(x=>x.workId===workId);}
  /** Live claim + live grant (+ operation). Called on entry AND again right before every mutation. */
  private async authorize(caller:string,claim:Claim,op:'read'|GitHubWriteOp){
    this.ensure();
    await this.mesh.liveWork(caller,claim.workId,claim.attemptId,claim.leaseGeneration);
    const g=this.current(claim.workId);
    check(g&&!g.revokedAt&&g.host===caller,'No GitHub grant for this work: ask the leader');
    check(repoAllowed(this.allow,g.repository),'Repository no longer allowed');
    if(op!=='read')check(g.ops.includes(op),`This work's GitHub grant does not include "${op}"`);
    return g;
  }
  /** Atomically reserve one unit of the work's budget before calling GitHub. */
  private reserve(g:GitHubGrant,kind:'writes'|'reads'){
    const max=kind==='writes'?MAX_WRITES_PER_WORK:MAX_READS_PER_WORK;
    let ok=false;
    this.db!.mutate('github_workforce',seed,d=>{const x=d.grants.find(y=>y.workId===g.workId);if(x&&x[kind]<max){x[kind]++;ok=true;}});
    check(ok,`GitHub ${kind==='writes'?'write':'read'} budget for this work is used up`);
  }
  private record(g:GitHubGrant,op:string,ref:string,outcome:string,patch?:(x:GitHubGrant)=>void){
    this.db!.mutate('github_workforce',seed,d=>{
      if(patch){const x=d.grants.find(y=>y.workId===g.workId);if(x)patch(x);}
      d.audit.push({at:iso(),workId:g.workId,host:g.host,repository:g.repository,op,ref:ref.slice(0,300),outcome:outcome.slice(0,300)});
      d.audit=d.audit.slice(-5000);
    });
  }
  private async api(method:string,repository:string,path:string,body?:unknown):Promise<{status:number;data:any}>{
    const url=new URL(`${API}/repos/${repository}${path?'/'+path:''}`);
    // Pinned after parsing: no encoded or dotted segment can leave this repository.
    const root=`/repos/${repository}`.toLowerCase();
    const at=url.pathname.toLowerCase();
    check(url.origin===API&&(at===root||at.startsWith(root+'/'))&&!url.username&&!url.password,'GitHub path escapes the granted repository');
    const r=await this.fetcher(url.toString(),{method,redirect:'error',signal:AbortSignal.timeout(20_000),
      headers:{Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'Panter-ai-workforce',
        Authorization:`Bearer ${this.token}`,...(body!==undefined?{'Content-Type':'application/json'}:{})},
      ...(body!==undefined?{body:JSON.stringify(body)}:{})});
    // Stream with a cap instead of buffering an unbounded body.
    const chunks:Uint8Array[]=[];let size=0;
    if(r.body){
      const reader=r.body.getReader();
      for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;
        if(size>MAX_RESPONSE_BYTES){await reader.cancel().catch(()=>{});fail('GitHub response too large');}chunks.push(value);}
    }
    const raw=Buffer.concat(chunks).toString('utf8');
    let data:any=null;try{data=raw?JSON.parse(raw):null;}catch{data=raw;}
    return {status:r.status,data};
  }
  private ok(r:{status:number;data:any},what:string){
    if(r.status>=200&&r.status<300)return r.data;
    const msg=typeof r.data?.message==='string'?r.data.message.slice(0,200):'';
    return fail(`GitHub ${what} failed (HTTP ${r.status})${msg?': '+msg:''}`);
  }

  async read(caller:string,claim:Claim,path:string){
    const g=await this.authorize(caller,claim,'read');
    if(path==='grant')return {grant:{repository:g.repository,ops:g.ops,branch:g.branch,base:g.base,numbers:g.numbers,
      writesUsed:g.writes,writesMax:MAX_WRITES_PER_WORK}};
    check(safeReadPath(path),'This GitHub path is not readable by workers');
    this.reserve(g,'reads');
    const data=sanitize(this.ok(await this.api('GET',g.repository,path),'read')) as any;
    let text=JSON.stringify(data);
    // File contents: hand back decoded text so workers do not need to decode base64.
    if(data&&typeof data==='object'&&!Array.isArray(data)&&data.encoding==='base64'&&typeof data.content==='string')
      text=JSON.stringify({path:data.path,sha:data.sha,size:data.size,text:Buffer.from(data.content,'base64').toString('utf8')});
    if(text.length>MAX_READ_BYTES)text=text.slice(0,MAX_READ_BYTES)+'…[truncated]';
    return {repository:g.repository,path,body:text};
  }

  async commit(caller:string,claim:Claim,message:string,files:FileChange[]){
    const g0=await this.authorize(caller,claim,'commit');
    check(typeof message==='string'&&message.trim().length>0&&message.length<=5000,'Invalid commit message');
    check(Array.isArray(files)&&files.length>0&&files.length<=MAX_FILES,`Commit 1-${MAX_FILES} files`);
    for(const f of files){
      check(safeRepoPath(f.path),`Path not allowed: ${String(f.path).slice(0,100)}`);
      check(f.delete===true?f.content===undefined:typeof f.content==='string'&&Buffer.byteLength(f.content)<=MAX_FILE_BYTES,
        `Give either text content (≤1 MB) or delete:true for ${f.path}`);
    }
    check(new Set(files.map(f=>f.path)).size===files.length,'Each path once per commit');
    const branch=g0.branch!;
    return this.serial(`${g0.repository}#${branch}`,async()=>{
      const g=await this.authorize(caller,claim,'commit');
      check(g.branch===branch&&validRefName(branch)&&branch.startsWith('panter/'),'Grant branch changed');
      this.reserve(g,'writes');
      try{
        const repo=this.ok(await this.api('GET',g.repository,''),'repository lookup');
        check(branch!==repo.default_branch,'Refusing to write the default branch');
        const ref=await this.api('GET',g.repository,`git/ref/heads/${refPath(branch)}`);
        let head:string;
        if(ref.status===404){
          const base=g.base??repo.default_branch;
          check(validRefName(base),'Invalid base branch');
          head=this.ok(await this.api('GET',g.repository,`git/ref/heads/${refPath(base)}`),'base branch lookup').object.sha;
          await this.authorize(caller,claim,'commit');
          this.ok(await this.api('POST',g.repository,'git/refs',{ref:`refs/heads/${branch}`,sha:head}),'branch creation');
          this.record(g,'branch',branch,`created from ${base}@${head}`,x=>{x.branchCreated=true;});
        }else{
          const found=this.ok(ref,'branch lookup');
          // Only the branch this grant created: never an existing branch that merely matches the name.
          check(this.current(g.workId)?.branchCreated===true&&found.ref===`refs/heads/${branch}`,'That branch already exists and was not created for this work');
          head=found.object.sha;
        }
        const info=this.ok(await this.api('GET',g.repository,`branches/${refPath(branch)}`),'branch check');
        check(info.protected!==true,'Refusing to write a protected branch');
        const parent=this.ok(await this.api('GET',g.repository,`git/commits/${head}`),'head commit lookup');
        const tree=this.ok(await this.api('POST',g.repository,'git/trees',{base_tree:parent.tree.sha,
          tree:files.map(f=>f.delete?{path:f.path,mode:'100644',type:'blob',sha:null}:{path:f.path,mode:'100644',type:'blob',content:f.content})}),'tree creation');
        const full=`${message.trim()}\n\nPanter-Work: ${g.workId}\nPanter-Host: ${g.host}`;
        const commit=this.ok(await this.api('POST',g.repository,'git/commits',{message:full,tree:tree.sha,parents:[head]}),'commit creation');
        await this.authorize(caller,claim,'commit'); // lease and grant still live right before moving the branch
        // force:false: a concurrent push to the branch makes this fail instead of being overwritten.
        this.ok(await this.api('PATCH',g.repository,`git/refs/heads/${refPath(branch)}`,{sha:commit.sha,force:false}),'branch update');
        this.record(g,'commit',`${branch}@${commit.sha}`,`${files.length} file(s)`);
        return {repository:g.repository,branch,commit:commit.sha,parent:head,files:files.length};
      }catch(e){this.record(g,'commit',branch,'error: '+(e instanceof Error?e.message:'error'));throw e;}
    });
  }

  async openPr(caller:string,claim:Claim,title:string,body:string,draft:boolean){
    const g0=await this.authorize(caller,claim,'pr');
    check(typeof title==='string'&&title.trim().length>0&&title.length<=250,'Invalid PR title');
    check(typeof body==='string'&&body.length<=60_000,'PR body too long');
    return this.serial(`${g0.repository}#${g0.branch}`,async()=>{
      const g=await this.authorize(caller,claim,'pr');
      check(this.current(g.workId)?.branchCreated===true,'Commit to the work branch before opening a PR');
      const repo=this.ok(await this.api('GET',g.repository,''),'repository lookup');
      const base=g.base??repo.default_branch;
      const owner=g.repository.split('/')[0];
      const existing=this.ok(await this.api('GET',g.repository,`pulls?state=open&head=${owner}:${g.branch}`),'PR lookup');
      if(Array.isArray(existing)&&existing[0]){
        this.record(g,'pr',`#${existing[0].number}`,'already open',x=>{if(!x.numbers.includes(existing[0].number))x.numbers.push(existing[0].number);});
        return {repository:g.repository,number:existing[0].number,url:existing[0].html_url,created:false};
      }
      this.reserve(g,'writes');
      await this.authorize(caller,claim,'pr');
      const pr=this.ok(await this.api('POST',g.repository,'pulls',{title:title.trim(),head:g.branch,base,draft:Boolean(draft),
        body:`${body}\n\n---\nOpened by Panter worker \`${g.host}\` for work \`${g.workId}\`. Merge and review stay with the leader and the reviewer account.`}),'PR creation');
      this.record(g,'pr',`#${pr.number}`,'opened',x=>{x.numbers.push(pr.number);});
      return {repository:g.repository,number:pr.number,url:pr.html_url,created:true};
    });
  }

  async comment(caller:string,claim:Claim,number:number,body:string){
    const g=await this.authorize(caller,claim,'comment');
    check(Number.isInteger(number)&&number>0,'Invalid issue/PR number');
    check(g.numbers.includes(number),'Comment only on the issues/PRs the leader listed or this work opened');
    check(typeof body==='string'&&body.trim().length>0&&body.length<=20_000,'Invalid comment');
    check(!BOT_COMMAND.test(body),'Comments cannot contain bot or slash commands');
    this.reserve(g,'writes');
    await this.authorize(caller,claim,'comment');
    const c=this.ok(await this.api('POST',g.repository,`issues/${number}/comments`,{body:`${body}\n\n_(Panter worker ${g.host}, work ${g.workId.slice(0,8)})_`}),'comment');
    this.record(g,'comment',`#${number}`,String(c.id));
    return {repository:g.repository,number,url:c.html_url};
  }

  async issue(caller:string,claim:Claim,title:string,body:string){
    const g=await this.authorize(caller,claim,'issue');
    check(typeof title==='string'&&title.trim().length>0&&title.length<=250,'Invalid issue title');
    check(typeof body==='string'&&body.length<=60_000,'Issue body too long');
    check(!BOT_COMMAND.test(body)&&!BOT_COMMAND.test(title),'Issues cannot contain bot or slash commands');
    this.reserve(g,'writes');
    await this.authorize(caller,claim,'issue');
    const i=this.ok(await this.api('POST',g.repository,'issues',{title:title.trim(),body:`${body}\n\n_(Panter worker ${g.host}, work ${g.workId.slice(0,8)})_`}),'issue creation');
    this.record(g,'issue',`#${i.number}`,'opened',x=>{x.numbers.push(i.number);});
    return {repository:g.repository,number:i.number,url:i.html_url};
  }
}
