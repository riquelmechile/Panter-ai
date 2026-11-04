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
  base:string|null;numbers:number[];paths?:string[];auto?:boolean;own?:number[];branchCreated:boolean;createdBranch?:{repository:string;branch:string;lastSha?:string};createdAt:string;revokedAt:string|null;writes:number;reads:number};
type Audit={at:string;workId:string;host:string;repository:string;op:string;ref:string;outcome:string};
type Data={version:1;grants:GitHubGrant[];audit:Audit[]};
const seed:Data={version:1,grants:[],audit:[]};
type Claim={workId:string;attemptId:string;leaseGeneration:number};

export type WorkforceMesh={
  liveWork(caller:string,id:string,attemptId:string,generation:number):Promise<{id:string;target:string;role:string}>;
  workTarget(caller:string,id:string):Promise<{id:string;target:string;role:string;state:string}>;
};
export type FileChange={path:string;content?:string;delete?:boolean};
export type GrantInput={repository:string;ops:GitHubWriteOp[];branch?:string;base?:string;numbers?:number[];
  /** When set, commits may only touch these files or folders (the run's approved edit surfaces). */paths?:string[];
  /** Issued by the harness on its own; never overrides a grant the leader set by hand. */auto?:boolean};
export class GitHubWorkforceError extends Error{}

const API='https://api.github.com';
const REPO=/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const SEGMENT=/^[A-Za-z0-9._~@:+=,-]{1,200}$/;
const REF_SEGMENT=/^[A-Za-z0-9._@+=,-]{1,200}$/; // git forbids ~ ^ : ? * [ and backslash in refs
const GLOBAL_CALLS_PER_HOUR=3000;
const PER_WORK_CALLS_PER_HOUR=500;
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
  return name.split('/').every(c=>REF_SEGMENT.test(c)&&!c.startsWith('.')&&!c.endsWith('.')&&!c.endsWith('.lock')&&!c.includes('..'));
}
const refPath=(name:string)=>name.split('/').map(encodeURIComponent).join('/');
/** A file path a worker may change: relative, no traversal, never CI, ownership or git configuration. */
export function safeRepoPath(path:string){
  if(typeof path!=='string'||!path||path.length>400||path.startsWith('/')||path.endsWith('/')||path.includes('\\')||path.includes('\0'))return false;
  const parts=path.split('/');
  if(parts.some(p=>!p||p==='.'||p==='..'))return false;
  const lower=parts.map(p=>p.toLowerCase());
  // CI/deploy configs and anything an operator's or leader's tools execute or obey when the branch is checked out.
  if(['.github','.circleci','.buildkite','.gitlab','.woodpecker','.husky','.devcontainer','.claude','.vscode','.gemini',
    '.cursor','.codex','.idea','.yarn'].includes(lower[0]!)||lower.includes('.git'))return false;
  const name=lower.at(-1)!;
  const denied=new Set(['codeowners','.gitmodules','.gitattributes','.lfsconfig','.gitlab-ci.yml','.travis.yml','jenkinsfile',
    'azure-pipelines.yml','bitbucket-pipelines.yml','.drone.yml','appveyor.yml','cloudbuild.yaml','cloudbuild.yml',
    '.mergify.yml','netlify.toml','vercel.json','railway.json','railway.toml','.pre-commit-config.yaml','buildspec.yml',
    '.woodpecker.yml','.cirrus.yml','.readthedocs.yaml','.readthedocs.yml','action.yml','action.yaml','codemagic.yaml',
    'render.yaml','fly.toml','app.yaml','.gitpod.yml','wrangler.toml','wrangler.json','wrangler.jsonc',
    '.mcp.json','.envrc','.yarnrc','.yarnrc.yml','.pnpmfile.cjs','.npmrc','claude.md','agents.md','gemini.md']);
  return !denied.has(name);
}
/** Repository resources workers may GET (path below repos/{owner}/{repo}/), checked segment by segment. */
export function safeReadPath(path:string){
  if(typeof path!=='string'||!path||path.length>500||/[\s#\\%]/.test(path))return false;
  const q=path.indexOf('?');
  const rawPath=q<0?path:path.slice(0,q), query=q<0?'':path.slice(q+1);
  const segs=rawPath.split('/');
  if(segs.some(s=>!SEGMENT.test(s)||s==='.'||s==='..'))return false;
  if(q>=0&&!/^[A-Za-z0-9._~:+=,&\/-]{1,300}$/.test(query))return false;
  const lower=segs.map(s=>s.toLowerCase());
  const [a,b]=lower;
  // File paths under contents/ are just names; elsewhere these segments reach sensitive sub-resources.
  if(a!=='contents'&&lower.some(s=>['secrets','variables','logs','artifacts','protection','keys','hooks','collaborators','invitations',
    'environments','deployments','alerts','attempts','caches','permissions','runners','pending_deployments','timing','annotations',
    'jobs','approvals','usage','deployment_protection_rules','tarball','zipball','assets'].includes(s)))return false;
  switch(a){
    // compare/a...owner:branch would reach other forks of the network: same-repository refs only.
    case 'compare': return !rawPath.includes(':');
    case 'contents': case 'readme': case 'commits': case 'pulls': case 'issues': case 'branches':
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
/** Text posted under the owner's identity must not drive bots or AI agents installed in the repository:
 * no @mentions at all and no slash/bors commands, judged after removing invisible characters and HTML comments. */
export function botCommand(text:string){
  // Invisible characters become spaces (never glue text together); check both the raw and the NFKC form.
  const raw=text.replace(/\p{Cf}/gu,' ');
  for(const t of [raw,raw.normalize('NFKC')]){
    if(/<!--|<!\s*-\s*-/.test(t))return true;                        // hidden HTML, even split by invisibles
    if(/&(#0*64|#x0*40|commat);/i.test(t))return true;                  // encoded @
    // @mention after any non-alphanumeric (GitHub links "_@x_" too); @scope/pkg and @ts-* directives are not mentions.
    if(/(^|[^A-Za-z0-9])@(?!ts-(ignore|expect-error|nocheck|check)\b)[A-Za-z0-9][A-Za-z0-9_-]*(?![A-Za-z0-9_/-])/.test(t))return true;
    if(/^\s*\/[A-Za-z][\w-]*(\s|$)/m.test(t)||/^\s*bors\b/im.test(t))return true;
  }
  return false;
}

export class GitHubWorkforce{
  readonly configured:boolean;
  private readonly allow:string[];
  private readonly token:string;
  private readonly db:SqliteLedger|null;
  private readonly chains=new Map<string,Promise<unknown>>();
  private calls:number[]=[];
  private perWork=new Map<string,number[]>();
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
    const paths=input.paths===undefined?undefined:[...new Set(input.paths)].sort();
    if(paths)check(paths.length>0&&paths.length<=100&&paths.every(p=>typeof p==='string'&&p.length>0&&p.length<=400&&!p.startsWith('/')&&
      !p.includes('\0')&&!p.split('/').some(x=>x==='..')),'Invalid allowed paths');
    return {ops,numbers,paths};
  }
  async grant(caller:string,input:{workId:string}&GrantInput){
    this.ensure();
    check(caller===this.leader(),'Only the leader grants GitHub access');
    const {ops,numbers,paths}=this.validateGrant(input);
    const work=await this.mesh.workTarget(caller,input.workId);
    check(work.target!==this.leader(),'Leader work cannot hold a GitHub grant');
    const needsBranch=ops.includes('commit')||ops.includes('pr');
    const branch=needsBranch?(input.branch??`panter/${work.target}-${work.id.slice(0,8)}`):null;
    const base=input.base??null;
    // Everything is decided inside one transaction, so a concurrent revoke can never be undone.
    let out!:GitHubGrant;
    this.db!.mutate('github_workforce',seed,d=>{
      const existing=d.grants.find(x=>x.workId===work.id);
      check(!existing?.revokedAt,'This work\'s GitHub grant was revoked; delegate a new work');
      // A grant the leader set by hand is never widened back by the harness's automatic re-issue.
      if(existing&&input.auto===true&&!existing.auto){out=existing;return;}
      // A path limit only narrows: a later grant without paths keeps it, and new paths must fit inside it.
      if(existing?.paths&&paths)check(paths.every(p=>existing.paths!.some(q=>p===q||p.startsWith(q+'/'))),'Allowed paths can only narrow');
      const effPaths=paths??existing?.paths;
      // An identical replay (e.g. an idempotent delegate retry) returns the grant untouched, even after completion.
      if(existing&&existing.repository===input.repository&&JSON.stringify(existing.ops)===JSON.stringify(ops)&&
        existing.branch===branch&&existing.base===base&&JSON.stringify(existing.numbers)===JSON.stringify(numbers)&&
        JSON.stringify(existing.paths??null)===JSON.stringify(effPaths??null)&&Boolean(existing.auto)===(input.auto===true)){out=existing;return;}
      check(!TERMINAL.has(work.state),'Work is finished');
      check(!existing||existing.repository===input.repository,'A grant cannot move to another repository; delegate a new work');
      check(!existing?.createdBranch||existing.branch===branch,'The working branch cannot change after it was created');
      // One work per branch name in a repository (case-insensitive): two grants never share a working branch.
      if(branch)check(!d.grants.some(x=>x.workId!==work.id&&x.repository.toLowerCase()===input.repository.toLowerCase()&&
        (x.branch??'').toLowerCase()===branch.toLowerCase()),'Another work already uses that branch in this repository');
      out={workId:work.id,host:work.target,repository:input.repository,ops,branch,base,numbers,...(effPaths?{paths:effPaths}:{}),...(input.auto===true?{auto:true}:{}),own:existing?.own??[],
        branchCreated:existing?.branchCreated??false,...(existing?.createdBranch?{createdBranch:existing.createdBranch}:{}),
        createdAt:iso(),revokedAt:null,writes:existing?.writes??0,reads:existing?.reads??0};
      const i=d.grants.findIndex(x=>x.workId===out.workId);
      if(i>=0)d.grants[i]=out;else d.grants.push(out);
      // Revoked grants are never evicted: "revoked stays revoked".
      const live=d.grants.filter(g=>!g.revokedAt);
      if(live.length>5000){const drop=new Set(live.slice(0,live.length-5000).map(g=>g.workId));d.grants=d.grants.filter(g=>g.revokedAt||!drop.has(g.workId));}
    });
    return out;
  }
  async revoke(caller:string,workId:string){
    this.ensure();
    check(caller===this.leader(),'Only the leader revokes GitHub access');
    let found=false;
    this.db!.mutate('github_workforce',seed,d=>{
      const g=d.grants.find(x=>x.workId===workId);
      if(g){if(!g.revokedAt){g.revokedAt=iso();found=true;}return;}
      // Revoking before any grant leaves a tombstone, so a later grant for this work is refused.
      d.grants.push({workId,host:'',repository:'',ops:[],branch:null,base:null,numbers:[],branchCreated:false,
        createdAt:iso(),revokedAt:iso(),writes:0,reads:0});found=true;
    });
    return {workId,revoked:found};
  }
  /** Leader-side, read-only: the diff of a frozen candidate against its base, as text material for hosts that
   * cannot reach the repository (e.g. Gemini by e-mail). Pinned to an allowed repository like every call. */
  async candidateMaterial(repository:string,base:string|null,head:string,max=26_000){
    this.ensure();
    check(repoAllowed(this.allow,repository),'Repository is not in PANTER_GITHUB_WORKFORCE_REPOS');
    check(/^[a-f0-9]{40}$/.test(head),'Invalid candidate SHA');
    const repo=base?null:this.ok(await this.api('GET',repository,''),'repository lookup');
    const from=base??repo.default_branch;
    check(validRefName(from)||/^[a-f0-9]{40}$/.test(from),'Invalid base');
    const cmp=this.ok(await this.api('GET',repository,`compare/${refPath(from)}...${head}`),'compare');
    const files:any[]=Array.isArray(cmp?.files)?cmp.files:[];
    const out=[`Repository: ${repository}`,`Diff ${from}...${head} (${files.length} file(s), ${cmp?.ahead_by??'?'} commit(s) ahead)`];
    let used=out.join('\n').length,omitted=0;
    const oneLine=(v:unknown)=>String(v).replace(/[\r\n\u2028\u2029]+/g,' ').slice(0,400);
    for(const f of files){
      const patch=typeof f.patch==='string'?f.patch:'(no textual patch: binary or too large)';
      // A fence longer than any backtick run in the patch, so diff text can never close it.
      const fence='`'.repeat(Math.max(3,...[...patch.matchAll(/`+/g)].map(m=>m[0].length+1)));
      const block=`\n### ${oneLine(f.filename)} (${oneLine(f.status)}, +${Number(f.additions)||0} -${Number(f.deletions)||0})\n${fence}diff\n${patch}\n${fence}`;
      if(used+block.length>max){omitted++;continue;}
      out.push(block);used+=block.length;
    }
    if(omitted)out.push(`\n[${omitted} file(s) omitted to fit the size limit; judge only what is shown and say so.]`);
    return out.join('\n');
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
  /** This grant created exactly this branch in exactly this repository. */
  private ownsBranch(g:GitHubGrant,headSha?:string){
    const c=this.current(g.workId)?.createdBranch;
    // Same repository, same name, AND the tip is the commit this work last wrote: a branch deleted and recreated
    // by someone else (or another work) under the same name is never written.
    return Boolean(c&&c.repository===g.repository&&c.branch===g.branch&&(headSha===undefined||c.lastSha===headSha));
  }
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
    // One operator token serves every worker: keep a global hourly ceiling well under GitHub's 5000/h.
    const now=Date.now();
    this.calls=this.calls.filter(t=>now-t<3600_000);
    check(this.calls.length<GLOBAL_CALLS_PER_HOUR,'GitHub workforce hourly budget reached; try later');
    this.calls.push(now);
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
  /** Every GitHub call made for a work: at most PER_WORK_CALLS_PER_HOUR, so one worker cannot starve the others. */
  private call(g:GitHubGrant,method:string,path:string,body?:unknown){
    const now=Date.now();
    const recent=(this.perWork.get(g.workId)??[]).filter(t=>now-t<3600_000);
    check(recent.length<PER_WORK_CALLS_PER_HOUR,'GitHub call budget for this work is used up for this hour');
    recent.push(now);this.perWork.set(g.workId,recent);
    if(this.perWork.size>2000)for(const k of this.perWork.keys()){this.perWork.delete(k);if(this.perWork.size<=1000)break;}
    return this.api(method,g.repository,path,body);
  }
  private ok(r:{status:number;data:any},what:string){
    if(r.status>=200&&r.status<300)return r.data;
    const msg=typeof r.data?.message==='string'?r.data.message.slice(0,200):'';
    return fail(`GitHub ${what} failed (HTTP ${r.status})${msg?': '+msg:''}`);
  }

  async read(caller:string,claim:Claim,path:string){
    const g=await this.authorize(caller,claim,'read');
    if(path==='grant')return {grant:{repository:g.repository,ops:g.ops,branch:g.branch,base:g.base,numbers:[...g.numbers,...(g.own??[])],
      writesUsed:g.writes,writesMax:MAX_WRITES_PER_WORK}};
    check(safeReadPath(path),'This GitHub path is not readable by workers');
    this.reserve(g,'reads');
    const data=sanitize(this.ok(await this.call(g,'GET',path),'read')) as any;
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
    check(!botCommand(message),'Commit messages cannot contain @mentions, HTML comments or bot/slash commands');
    check(Array.isArray(files)&&files.length>0&&files.length<=MAX_FILES,`Commit 1-${MAX_FILES} files`);
    for(const f of files){
      check(safeRepoPath(f.path),`Path not allowed: ${String(f.path).slice(0,100)}`);
      check(!g0.paths||g0.paths.some(q=>f.path===q||f.path.startsWith(q.replace(/\/+$/,'')+'/')),`Outside the approved edit surfaces: ${String(f.path).slice(0,100)}`);
      check(f.delete===true?f.content===undefined:typeof f.content==='string'&&Buffer.byteLength(f.content)<=MAX_FILE_BYTES,
        `Give either text content (≤1 MB) or delete:true for ${f.path}`);
    }
    check(new Set(files.map(f=>f.path)).size===files.length,'Each path once per commit');
    const branch=g0.branch!;
    return this.serial(`${g0.repository}#${branch}`,async()=>{
      const g=await this.authorize(caller,claim,'commit');
      check(g.branch===branch&&validRefName(branch)&&branch.startsWith('panter/'),'Grant branch changed');
      for(const f of files)check(!g.paths||g.paths.some(q=>f.path===q||f.path.startsWith(q.replace(/\/+$/,'')+'/')),`Outside the approved edit surfaces: ${String(f.path).slice(0,100)}`);
      this.reserve(g,'writes');
      try{
        const repo=this.ok(await this.call(g,'GET',''),'repository lookup');
        check(branch!==repo.default_branch,'Refusing to write the default branch');
        const ref=await this.call(g,'GET',`git/ref/heads/${refPath(branch)}`);
        let head:string;
        if(ref.status===404){
          const base=g.base??repo.default_branch;
          check(validRefName(base),'Invalid base branch');
          head=this.ok(await this.call(g,'GET',`git/ref/heads/${refPath(base)}`),'base branch lookup').object.sha;
          check((await this.authorize(caller,claim,'commit')).branch===branch,'Grant branch changed');
          this.ok(await this.call(g,'POST','git/refs',{ref:`refs/heads/${branch}`,sha:head}),'branch creation');
          this.record(g,'branch',branch,`created from ${base}@${head}`,x=>{if(x.branch===branch&&x.repository===g.repository){
            x.branchCreated=true;x.createdBranch={repository:g.repository,branch,lastSha:head};}});
        }else{
          const found=this.ok(ref,'branch lookup');
          // Only the branch this grant created: never an existing branch that merely matches the name.
          check(this.ownsBranch(g,found.object?.sha)&&found.ref===`refs/heads/${branch}`,'That branch already exists and was not created for this work (or moved since this work last wrote it)');
          head=found.object.sha;
        }
        const info=this.ok(await this.call(g,'GET',`branches/${refPath(branch)}`),'branch check');
        check(info.protected!==true,'Refusing to write a protected branch');
        const parent=this.ok(await this.call(g,'GET',`git/commits/${head}`),'head commit lookup');
        const tree=this.ok(await this.call(g,'POST','git/trees',{base_tree:parent.tree.sha,
          tree:files.map(f=>f.delete?{path:f.path,mode:'100644',type:'blob',sha:null}:{path:f.path,mode:'100644',type:'blob',content:f.content})}),'tree creation');
        const full=`${message.trim()}\n\nPanter-Work: ${g.workId}\nPanter-Host: ${g.host}`;
        const commit=this.ok(await this.call(g,'POST','git/commits',{message:full,tree:tree.sha,parents:[head]}),'commit creation');
        // Lease and grant still live, and still on this branch, right before moving it.
        check((await this.authorize(caller,claim,'commit')).branch===branch,'Grant branch changed');
        // force:false: a concurrent push to the branch makes this fail instead of being overwritten.
        this.ok(await this.call(g,'PATCH',`git/refs/heads/${refPath(branch)}`,{sha:commit.sha,force:false}),'branch update');
        this.record(g,'commit',`${branch}@${commit.sha}`,`${files.length} file(s)`,x=>{
          if(x.createdBranch&&x.createdBranch.branch===branch&&x.createdBranch.repository===g.repository)x.createdBranch.lastSha=commit.sha;});
        return {repository:g.repository,branch,commit:commit.sha,parent:head,files:files.length};
      }catch(e){this.record(g,'commit',branch,'error: '+(e instanceof Error?e.message:'error'));throw e;}
    });
  }

  async openPr(caller:string,claim:Claim,title:string,body:string,draft:boolean){
    const g0=await this.authorize(caller,claim,'pr');
    check(typeof title==='string'&&title.trim().length>0&&title.length<=250,'Invalid PR title');
    check(typeof body==='string'&&body.length<=60_000,'PR body too long');
    check(!botCommand(title)&&!botCommand(body),'PRs cannot contain @mentions, HTML comments or bot/slash commands');
    return this.serial(`${g0.repository}#${g0.branch}`,async()=>{
      const g=await this.authorize(caller,claim,'pr');
      check(this.ownsBranch(g),'Commit to the work branch before opening a PR');
      const repo=this.ok(await this.call(g,'GET',''),'repository lookup');
      const base=g.base??repo.default_branch;
      const owner=g.repository.split('/')[0];
      const existing=this.ok(await this.call(g,'GET',`pulls?state=open&head=${encodeURIComponent(`${owner}:${g.branch}`)}`),'PR lookup');
      if(Array.isArray(existing)&&existing[0]){
        this.reserve(g,'reads');
        this.record(g,'pr',`#${existing[0].number}`,'already open',x=>{x.own??=[];if(!x.own.includes(existing[0].number))x.own.push(existing[0].number);});
        return {repository:g.repository,number:existing[0].number,url:existing[0].html_url,created:false};
      }
      this.reserve(g,'writes');
      await this.authorize(caller,claim,'pr');
      const pr=this.ok(await this.call(g,'POST','pulls',{title:title.trim(),head:g.branch,base,draft:Boolean(draft),
        body:`_Opened by Panter worker \`${g.host}\` for work \`${g.workId}\`. Merge and review stay with the leader and the reviewer account._\n\n${body}`}),'PR creation');
      this.record(g,'pr',`#${pr.number}`,'opened',x=>{(x.own??=[]).push(pr.number);});
      return {repository:g.repository,number:pr.number,url:pr.html_url,created:true};
    });
  }

  async comment(caller:string,claim:Claim,number:number,body:string){
    const g=await this.authorize(caller,claim,'comment');
    check(Number.isInteger(number)&&number>0,'Invalid issue/PR number');
    check(g.numbers.includes(number)||(g.own??[]).includes(number),'Comment only on the issues/PRs the leader listed or this work opened');
    check(typeof body==='string'&&body.trim().length>0&&body.length<=20_000,'Invalid comment');
    check(!botCommand(body),'Comments cannot contain @mentions, HTML comments or bot/slash commands');
    this.reserve(g,'writes');
    await this.authorize(caller,claim,'comment');
    const c=this.ok(await this.call(g,'POST',`issues/${number}/comments`,{body:`_(Panter worker ${g.host}, work ${g.workId.slice(0,8)})_\n\n${body}`}),'comment');
    this.record(g,'comment',`#${number}`,String(c.id));
    return {repository:g.repository,number,url:c.html_url};
  }

  async issue(caller:string,claim:Claim,title:string,body:string){
    const g=await this.authorize(caller,claim,'issue');
    check(typeof title==='string'&&title.trim().length>0&&title.length<=250,'Invalid issue title');
    check(typeof body==='string'&&body.length<=60_000,'Issue body too long');
    check(!botCommand(body)&&!botCommand(title),'Issues cannot contain @mentions, HTML comments or bot/slash commands');
    this.reserve(g,'writes');
    await this.authorize(caller,claim,'issue');
    const i=this.ok(await this.call(g,'POST','issues',{title:title.trim(),body:`_(Panter worker ${g.host}, work ${g.workId.slice(0,8)})_\n\n${body}`}),'issue creation');
    this.record(g,'issue',`#${i.number}`,'opened',x=>{(x.own??=[]).push(i.number);});
    return {repository:g.repository,number:i.number,url:i.html_url};
  }
}
