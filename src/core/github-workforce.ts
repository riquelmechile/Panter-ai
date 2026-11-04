/** GitHub for the workforce: Panter holds one operator token server-side and lets workers use it only
 * through narrow, audited operations, scoped to one delegated work and to the grant the leader attached.
 *
 * - The token never leaves the server: it is not in packets, results, logs or the repository.
 * - Reads: any worker with a live claim on a work that has a grant, in that grant's repository.
 * - Writes need the matching grant operation and a live lease: commits only to the grant's own working
 *   branch (never the default or a protected branch, never workflows, never forced), pull requests only
 *   from that branch, comments and issues in that repository.
 * - There is no merge, approve, delete, label, release, settings or secrets operation at all: those stay
 *   with the leader and the human, as AGENTS.md requires.
 */
import {SqliteLedger} from './sqlite-ledger.js';

export const GITHUB_WRITE_OPS=['commit','pr','comment','issue'] as const;
export type GitHubWriteOp=typeof GITHUB_WRITE_OPS[number];
export type GitHubGrant={workId:string;host:string;repository:string;ops:GitHubWriteOp[];branch:string|null;
  base:string|null;createdAt:string;revokedAt:string|null;writes:number};
type Audit={at:string;workId:string;host:string;repository:string;op:string;ref:string;outcome:string};
type Data={version:1;grants:GitHubGrant[];audit:Audit[]};
const seed:Data={version:1,grants:[],audit:[]};

export type WorkforceMesh={
  liveWork(caller:string,id:string,attemptId:string,generation:number):Promise<{id:string;target:string;role:string}>;
  workTarget(caller:string,id:string):Promise<{id:string;target:string;role:string;state:string}>;
};
export type FileChange={path:string;content?:string;delete?:boolean};
export class GitHubWorkforceError extends Error{}

const REPO=/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const BRANCH=/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const PROTECTED=/^(main|master|develop|dev|trunk|production|prod|staging|gh-pages|release(\/.*)?|hotfix(\/.*)?)$/i;
const MAX_WRITES_PER_WORK=200;
const MAX_FILES=50;
const MAX_FILE_BYTES=1_000_000;
const MAX_READ_BYTES=400_000;
const TERMINAL=new Set(['COMPLETED','FAILED','ABORTED_NO_EFFECTS']);
const iso=()=>new Date().toISOString();
const fail=(m:string):never=>{throw new GitHubWorkforceError(m);};
function check(v:unknown,m:string):asserts v{if(!v)fail(m);}

/** Repository allowlist entries: "owner/repo" or "owner/*". */
export function repoAllowed(allow:readonly string[],repository:string){
  if(!REPO.test(repository)||repository.includes('..'))return false;
  const [owner]=repository.toLowerCase().split('/');
  return allow.some(a=>{const x=a.toLowerCase();return x===repository.toLowerCase()||x===`${owner}/*`;});
}
/** A file path a worker may change: relative, no traversal, never CI workflows or git internals. */
export function safeRepoPath(path:string){
  if(typeof path!=='string'||!path||path.length>400||path.startsWith('/')||path.endsWith('/')||path.includes('\\')||path.includes('\0'))return false;
  const parts=path.split('/');
  if(parts.some(p=>!p||p==='.'||p==='..'||p.toLowerCase()==='.git'))return false;
  const lower=path.toLowerCase();
  return !lower.startsWith('.github/workflows/')&&!lower.startsWith('.github/actions/');
}
/** GET paths below repos/{owner}/{repo}/ that a worker may read (no secrets, keys, hooks or admin data). */
export function safeReadPath(path:string){
  if(typeof path!=='string'||path.length>500||/[\s#\\]|\.\.|\/\//.test(path)||path.startsWith('/'))return false;
  const segments=path.split('?')[0]!.split('/').map(s=>s.toLowerCase());
  const denied=new Set(['secrets','variables','keys','hooks','invitations','collaborators','environments','deployments',
    'security-advisories','dependabot','codespaces','actions-cache','installation','interaction-limits','rulesets']);
  return !segments.some(s=>denied.has(s));
}

export class GitHubWorkforce{
  readonly configured:boolean;
  private readonly allow:string[];
  private readonly db:SqliteLedger|null;
  private chain:Promise<unknown>=Promise.resolve();
  constructor(dir:string,private readonly mesh:WorkforceMesh,private readonly leader:()=>string,
    env:Record<string,string|undefined>=process.env,private readonly fetcher:typeof fetch=fetch){
    this.token=(env.PANTER_GITHUB_WORKFORCE_TOKEN??'').trim();
    this.allow=(env.PANTER_GITHUB_WORKFORCE_REPOS??env.PANTER_GITHUB_ALLOWED_REPOS??'').split(',').map(x=>x.trim()).filter(Boolean);
    for(const a of this.allow)check(/^[A-Za-z0-9_.-]{1,100}\/([A-Za-z0-9_.-]{1,100}|\*)$/.test(a)&&!a.includes('..'),
      `Invalid PANTER_GITHUB_WORKFORCE_REPOS entry: ${a}`);
    this.configured=Boolean(this.token)&&this.allow.length>0;
    this.db=this.configured?SqliteLedger.open(dir):null;
  }
  private readonly token:string;
  describe(){return {configured:this.configured,repositories:this.allow,
    operations:{read:'any granted work',write:[...GITHUB_WRITE_OPS]},never:['merge','approve','delete','force-push','workflows','secrets','settings']};}

  private ensure(){check(this.configured,'GitHub workforce is not configured (PANTER_GITHUB_WORKFORCE_TOKEN / PANTER_GITHUB_WORKFORCE_REPOS)');}
  private serial<T>(fn:()=>Promise<T>):Promise<T>{const p=this.chain.then(fn,fn);this.chain=p.then(()=>{},()=>{});return p;}

  // ---- leader ----
  async grant(caller:string,input:{workId:string;repository:string;ops:GitHubWriteOp[];branch?:string;base?:string}){
    this.ensure();
    check(caller===this.leader(),'Only the leader grants GitHub access');
    check(repoAllowed(this.allow,input.repository),'Repository is not in PANTER_GITHUB_WORKFORCE_REPOS');
    const ops=[...new Set(input.ops)];
    check(ops.every(o=>(GITHUB_WRITE_OPS as readonly string[]).includes(o)),'Unknown GitHub operation');
    const work=await this.mesh.workTarget(caller,input.workId);
    check(work.target!==this.leader()&&!TERMINAL.has(work.state),'Work is finished or belongs to the leader');
    const needsBranch=ops.includes('commit')||ops.includes('pr');
    const branch=needsBranch?(input.branch?.trim()||`panter/${work.target}-${work.id.slice(0,8)}`):null;
    if(branch)check(BRANCH.test(branch)&&!branch.includes('..')&&!branch.endsWith('/')&&!branch.endsWith('.lock')&&!PROTECTED.test(branch),
      'Working branch must be a new, non-protected branch name');
    const base=input.base?.trim()||null;
    if(base)check(BRANCH.test(base)&&!base.includes('..'),'Invalid base branch');
    const g:GitHubGrant={workId:work.id,host:work.target,repository:input.repository,ops,branch,base,createdAt:iso(),revokedAt:null,writes:0};
    this.db!.mutate('github_workforce',seed,d=>{
      const old=d.grants.find(x=>x.workId===g.workId);
      if(old){g.writes=old.writes;Object.assign(old,g);}else d.grants.push(g);
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
  private async authorize(caller:string,claim:{workId:string;attemptId:string;leaseGeneration:number},op:'read'|GitHubWriteOp){
    this.ensure();
    await this.mesh.liveWork(caller,claim.workId,claim.attemptId,claim.leaseGeneration);
    const g=this.db!.read('github_workforce',seed).grants.find(x=>x.workId===claim.workId);
    check(g&&!g.revokedAt&&g.host===caller,'No GitHub grant for this work: ask the leader');
    check(repoAllowed(this.allow,g.repository),'Repository no longer allowed');
    if(op!=='read'){
      check(g.ops.includes(op),`This work's GitHub grant does not include "${op}"`);
      check(g.writes<MAX_WRITES_PER_WORK,'GitHub write budget for this work is used up');
    }
    return g;
  }
  private record(g:GitHubGrant,op:string,ref:string,outcome:string,write:boolean){
    this.db!.mutate('github_workforce',seed,d=>{
      if(write){const x=d.grants.find(y=>y.workId===g.workId);if(x)x.writes++;}
      d.audit.push({at:iso(),workId:g.workId,host:g.host,repository:g.repository,op,ref:ref.slice(0,300),outcome:outcome.slice(0,300)});
      d.audit=d.audit.slice(-5000);
    });
  }
  private async api(method:string,repository:string,path:string,body?:unknown):Promise<{status:number;data:any}>{
    const url=`https://api.github.com/repos/${repository}${path?'/'+path:''}`;
    const r=await this.fetcher(url,{method,redirect:'error',signal:AbortSignal.timeout(20_000),
      headers:{Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'Panter-ai-workforce',
        Authorization:`Bearer ${this.token}`,...(body!==undefined?{'Content-Type':'application/json'}:{})},
      ...(body!==undefined?{body:JSON.stringify(body)}:{})});
    const raw=await r.text();
    check(raw.length<=MAX_READ_BYTES*4,'GitHub response too large');
    let data:any=null;try{data=raw?JSON.parse(raw):null;}catch{data=raw;}
    return {status:r.status,data};
  }
  private ok(r:{status:number;data:any},what:string){
    if(r.status>=200&&r.status<300)return r.data;
    const msg=typeof r.data?.message==='string'?r.data.message.slice(0,200):'';
    return fail(`GitHub ${what} failed (HTTP ${r.status})${msg?': '+msg:''}`);
  }

  async read(caller:string,claim:{workId:string;attemptId:string;leaseGeneration:number},path:string){
    const g=await this.authorize(caller,claim,'read');
    if(path==='grant')return {grant:{repository:g.repository,ops:g.ops,branch:g.branch,base:g.base,writesUsed:g.writes,writesMax:MAX_WRITES_PER_WORK}};
    check(safeReadPath(path),'This GitHub path is not readable by workers');
    const data=this.ok(await this.api('GET',g.repository,path),'read');
    let text=JSON.stringify(data);
    // File contents: hand back decoded text so workers do not need to decode base64.
    if(data&&typeof data==='object'&&!Array.isArray(data)&&data.encoding==='base64'&&typeof data.content==='string'){
      const decoded=Buffer.from(data.content,'base64').toString('utf8');
      text=JSON.stringify({path:data.path,sha:data.sha,size:data.size,text:decoded});
    }
    if(text.length>MAX_READ_BYTES)text=text.slice(0,MAX_READ_BYTES)+'…[truncated]';
    return {repository:g.repository,path,body:text};
  }

  async commit(caller:string,claim:{workId:string;attemptId:string;leaseGeneration:number},message:string,files:FileChange[]){
    const g=await this.authorize(caller,claim,'commit');
    check(typeof message==='string'&&message.trim().length>0&&message.length<=5000,'Invalid commit message');
    check(Array.isArray(files)&&files.length>0&&files.length<=MAX_FILES,`Commit 1-${MAX_FILES} files`);
    for(const f of files){
      check(safeRepoPath(f.path),`Path not allowed: ${String(f.path).slice(0,100)}`);
      check(f.delete===true?f.content===undefined:typeof f.content==='string'&&Buffer.byteLength(f.content)<=MAX_FILE_BYTES,
        `Give either text content (≤1 MB) or delete:true for ${f.path}`);
    }
    check(new Set(files.map(f=>f.path)).size===files.length,'Each path once per commit');
    return this.serial(async()=>{
      const branch=g.branch!;
      const repo=this.ok(await this.api('GET',g.repository,''),'repository lookup');
      check(branch!==repo.default_branch,'Refusing to write the default branch');
      let ref=await this.api('GET',g.repository,`git/ref/heads/${encodeURI(branch)}`);
      let head:string;
      if(ref.status===404){
        const base=g.base||repo.default_branch;
        const baseRef=this.ok(await this.api('GET',g.repository,`git/ref/heads/${encodeURI(base)}`),'base branch lookup');
        head=baseRef.object.sha;
        this.ok(await this.api('POST',g.repository,'git/refs',{ref:`refs/heads/${branch}`,sha:head}),'branch creation');
      }else head=this.ok(ref,'branch lookup').object.sha;
      const parent=this.ok(await this.api('GET',g.repository,`git/commits/${head}`),'head commit lookup');
      const tree=this.ok(await this.api('POST',g.repository,'git/trees',{base_tree:parent.tree.sha,
        tree:files.map(f=>f.delete?{path:f.path,mode:'100644',type:'blob',sha:null}:{path:f.path,mode:'100644',type:'blob',content:f.content})}),'tree creation');
      const full=`${message.trim()}\n\nPanter-Work: ${g.workId}\nPanter-Host: ${g.host}`;
      const commit=this.ok(await this.api('POST',g.repository,'git/commits',{message:full,tree:tree.sha,parents:[head]}),'commit creation');
      // force:false: a concurrent push to the branch makes this fail instead of being overwritten.
      this.ok(await this.api('PATCH',g.repository,`git/refs/heads/${encodeURI(branch)}`,{sha:commit.sha,force:false}),'branch update');
      this.record(g,'commit',`${branch}@${commit.sha}`,`${files.length} file(s)`,true);
      return {repository:g.repository,branch,commit:commit.sha,parent:head,files:files.length};
    }).catch(e=>{this.record(g,'commit',g.branch??'','error: '+(e instanceof Error?e.message:'error'),true);throw e;});
  }

  async openPr(caller:string,claim:{workId:string;attemptId:string;leaseGeneration:number},title:string,body:string,draft:boolean){
    const g=await this.authorize(caller,claim,'pr');
    check(typeof title==='string'&&title.trim().length>0&&title.length<=250,'Invalid PR title');
    check(typeof body==='string'&&body.length<=60_000,'PR body too long');
    const repo=this.ok(await this.api('GET',g.repository,''),'repository lookup');
    const base=g.base||repo.default_branch;
    const owner=g.repository.split('/')[0];
    const existing=this.ok(await this.api('GET',g.repository,`pulls?state=open&head=${encodeURIComponent(`${owner}:${g.branch}`)}`),'PR lookup');
    if(Array.isArray(existing)&&existing[0]){
      this.record(g,'pr',`#${existing[0].number}`,'already open',false);
      return {repository:g.repository,number:existing[0].number,url:existing[0].html_url,created:false};
    }
    const pr=this.ok(await this.api('POST',g.repository,'pulls',{title:title.trim(),head:g.branch,base,draft:Boolean(draft),
      body:`${body}\n\n---\nOpened by Panter worker \`${g.host}\` for work \`${g.workId}\`. Merge and review stay with the leader and the reviewer account.`}),'PR creation');
    this.record(g,'pr',`#${pr.number}`,'opened',true);
    return {repository:g.repository,number:pr.number,url:pr.html_url,created:true};
  }

  async comment(caller:string,claim:{workId:string;attemptId:string;leaseGeneration:number},number:number,body:string){
    const g=await this.authorize(caller,claim,'comment');
    check(Number.isInteger(number)&&number>0,'Invalid issue/PR number');
    check(typeof body==='string'&&body.trim().length>0&&body.length<=20_000,'Invalid comment');
    const c=this.ok(await this.api('POST',g.repository,`issues/${number}/comments`,{body:`${body}\n\n_(Panter worker ${g.host}, work ${g.workId.slice(0,8)})_`}),'comment');
    this.record(g,'comment',`#${number}`,String(c.id),true);
    return {repository:g.repository,number,url:c.html_url};
  }

  async issue(caller:string,claim:{workId:string;attemptId:string;leaseGeneration:number},title:string,body:string){
    const g=await this.authorize(caller,claim,'issue');
    check(typeof title==='string'&&title.trim().length>0&&title.length<=250,'Invalid issue title');
    check(typeof body==='string'&&body.length<=60_000,'Issue body too long');
    const i=this.ok(await this.api('POST',g.repository,'issues',{title:title.trim(),body:`${body}\n\n_(Panter worker ${g.host}, work ${g.workId.slice(0,8)})_`}),'issue creation');
    this.record(g,'issue',`#${i.number}`,'opened',true);
    return {repository:g.repository,number:i.number,url:i.html_url};
  }
}
