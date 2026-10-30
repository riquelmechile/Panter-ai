/** Trusted operator-pinned local Git evidence for RDD without a GitHub PR.
 * This runner NEVER accepts cwd or command strings from the AI host.
 * Commands are argv arrays loaded from a protected operator config file.
 */
import { createHash } from 'node:crypto';
import { realpath, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec=promisify(execFile);
const sha=/^[a-f0-9]{40}$/;
const projectName=/^[A-Za-z0-9_.\/-]{1,100}$/;
const allowedExecutables=new Set(['npm','node','pnpm','yarn','python3','go','cargo','make']);
export type LocalGitProject={root:string;checks:string[][]};
export type LocalGitDecision={state:'BLOCKED'|'REVIEWABLE';project:string;candidateSha:string;
  checkedHead?:string;checkDigests:string[];blockers:string[];kind:'LOCAL_GIT';
  approvals:{review:false;commit:false;push:false;merge:false;deploy:false}};
export class LocalGitVerifier {
  private constructor(private readonly projects:Readonly<Record<string,LocalGitProject>>){}
  static async open(file:string){
    if(!file.startsWith('/')||file.includes('..'))throw new Error('Operator Git config must use an absolute trusted path');
    const raw:unknown=JSON.parse(await readFile(file,'utf8'));
    if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('Invalid trusted Git config');
    const projects=raw as Record<string,LocalGitProject>;
    if(Object.keys(projects).length>32)throw new Error('Too many local Git projects');
    for(const [name,entry] of Object.entries(projects)){
      if(!projectName.test(name)||!entry||typeof entry.root!=='string'||!entry.root.startsWith('/')||entry.root.includes('..')||
        !Array.isArray(entry.checks)||entry.checks.length<1||entry.checks.length>12)throw new Error('Invalid local Git project');
      for(const argv of entry.checks){
        if(!Array.isArray(argv)||argv.length<1||argv.length>16||!allowedExecutables.has(argv[0]!)||
          !argv.every(x=>typeof x==='string'&&x.length>0&&x.length<=300&& !x.includes('\0')))
          throw new Error('Unsafe configured Git check');
      }
    }
    return new LocalGitVerifier(projects);
  }
  async inspect(project:string,candidateSha:string):Promise<LocalGitDecision>{
    if(!sha.test(candidateSha))throw new Error('Invalid local candidate SHA');
    const decision:LocalGitDecision={state:'BLOCKED',project,candidateSha,checkDigests:[],blockers:[],kind:'LOCAL_GIT',
      approvals:{review:false,commit:false,push:false,merge:false,deploy:false}};
    const config=this.projects[project];
    if(!config){decision.blockers.push('Project is not in operator local-worktree allowlist');return decision;}
    try{
      const root=await realpath(config.root);
      const git=async(...args:string[])=>{
        const r=await exec('git',args,{cwd:root,timeout:20000,maxBuffer:1024*512,windowsHide:true});return r.stdout.trim();
      };
      if(await git('rev-parse','--show-toplevel')!==root)throw new Error('Local Git checkout root mismatch');
      const observed=await git('rev-parse','--verify','HEAD');decision.checkedHead=observed;
      if(observed!==candidateSha)throw new Error('Local Git HEAD differs from frozen candidate');
      if(await git('status','--porcelain','--untracked-files=normal'))throw new Error('Local worktree has uncommitted or untracked files');
      for(const argv of config.checks){
        const result=await exec(argv[0]!,argv.slice(1),{cwd:root,timeout:120000,maxBuffer:1024*512,windowsHide:true});
        decision.checkDigests.push(createHash('sha256').update(JSON.stringify({argv,stdout:result.stdout,stderr:result.stderr})).digest('hex'));
      }
      if(await git('rev-parse','--verify','HEAD')!==candidateSha||await git('status','--porcelain','--untracked-files=normal'))
        throw new Error('Local checkout changed during validation');
      decision.state='REVIEWABLE';
    }catch(error){decision.blockers.push(error instanceof Error?error.message:'Local Git proof failed');}
    return decision;
  }
}
