/**
 * Offline Linux cgroup-v2 observation, not a recovery grant or kill switch.
 * An empty cgroup at one instant is NOT proof that no process can join later.
 * Never expose this observation as authorization to reclaim a fence.
 */
import {createHash} from 'node:crypto';
import {closeSync,constants,fstatSync,lstatSync,openSync,readFileSync,statfsSync} from 'node:fs';
import {join} from 'node:path';

const CGROUP_ROOT='/sys/fs/cgroup';
const CGROUP2_SUPER_MAGIC=0x63677270;
const NOFOLLOW=constants.O_NOFOLLOW??0;
const MAX_FILE_BYTES=32*1024;
const SEGMENT=/^[A-Za-z0-9_-][A-Za-z0-9_.@-]{0,63}$/;
export class CgroupObservationRejected extends Error{
  constructor(){super('Runner cgroup observation rejected');this.name='CgroupObservationRejected';}
}
export type CgroupObservation={
  status:'QUIESCENT_OBSERVATION_NOT_AUTHORIZATION';
  scope:string;
  observedAt:number;
  evidenceDigest:string;
  populated:0;
  procs:0;
  threads:0;
  permitsReclaim:false;
  permitsExecution:false;
};
function parseLines(raw:string):string[]{
  if(typeof raw!=='string'||raw.length>MAX_FILE_BYTES||raw.includes('\0'))
    throw new CgroupObservationRejected();
  if(!raw.length)return [];
  if(!raw.endsWith('\n'))throw new CgroupObservationRejected();
  return raw.slice(0,-1).split('\n');
}
/** Pure parser for independent and deterministic adversarial testing. */
export function parseCgroupV2Events(raw:string):{populated:0|1}{
  const fields=new Map<string,string>();
  for(const line of parseLines(raw)){
    const match=/^([a-z][a-z0-9_]*) ([0-9]+)$/.exec(line);
    if(!match||fields.has(match[1]!))throw new CgroupObservationRejected();
    fields.set(match[1]!,match[2]!);
  }
  const populated=fields.get('populated');
  if(populated!=='0'&&populated!=='1')throw new CgroupObservationRejected();
  return {populated:Number(populated) as 0|1};
}
export function parseCgroupV2Pids(raw:string):number[]{
  const out:number[]=[];
  for(const line of parseLines(raw)){
    if(!/^[1-9][0-9]*$/.test(line))throw new CgroupObservationRejected();
    const pid=Number(line);
    if(!Number.isSafeInteger(pid))throw new CgroupObservationRejected();
    out.push(pid);
  }
  if(new Set(out).size!==out.length)throw new CgroupObservationRejected();
  return out;
}
function safeScope(scope:string):string[]{
  if(typeof scope!=='string'||scope.length>512||scope.length<1||
    scope.startsWith('/')||scope.endsWith('/')||scope.includes('\\')||scope.includes('\0'))
    throw new CgroupObservationRejected();
  const parts=scope.split('/');
  if(parts.length>8||parts.some(p=>p==='.'||p==='..'||!SEGMENT.test(p)))
    throw new CgroupObservationRejected();
  return parts;
}
function validateDirectory(path:string):void{
  const s=lstatSync(path);
  if(!s.isDirectory()||s.isSymbolicLink())throw new CgroupObservationRejected();
  const fd=openSync(path,constants.O_RDONLY|constants.O_DIRECTORY|NOFOLLOW);
  try{
    const opened=fstatSync(fd);
    if(!opened.isDirectory()||opened.dev!==s.dev||opened.ino!==s.ino)
      throw new CgroupObservationRejected();
  }finally{closeSync(fd);}
}
/** Read a kernel pseudo-file by O_NOFOLLOW and cap its contents. */
function kernelRead(path:string):string{
  const fd=openSync(path,constants.O_RDONLY|NOFOLLOW|constants.O_NONBLOCK);
  try{
    const info=fstatSync(fd);
    if(!info.isFile())throw new CgroupObservationRejected();
    const raw=readFileSync(fd);
    if(raw.length>MAX_FILE_BYTES)throw new CgroupObservationRejected();
    return new TextDecoder('utf-8',{fatal:true}).decode(raw);
  }finally{closeSync(fd);}
}
type Snapshot={events:string;procs:string;threads:string};
function readSnapshot(path:string):Snapshot{
  return {events:kernelRead(join(path,'cgroup.events')),
    procs:kernelRead(join(path,'cgroup.procs')),
    threads:kernelRead(join(path,'cgroup.threads'))};
}
/**
 * The source path is fixed, not caller-supplied. No injected fake filesystem
 * can pass this API: cgroup2 statfs magic is mandatory. Reads are repeated,
 * but even a stable observation does not freeze admission of future processes.
 */
export function inspectRunnerCgroupV2Quiescence(scope:string):CgroupObservation{
  try{
    const parts=safeScope(scope);
    if(statfsSync(CGROUP_ROOT).type!==CGROUP2_SUPER_MAGIC)
      throw new CgroupObservationRejected();
    let path=CGROUP_ROOT;
    validateDirectory(path);
    for(const part of parts){
      path=join(path,part);
      validateDirectory(path);
    }
    if(statfsSync(path).type!==CGROUP2_SUPER_MAGIC)
      throw new CgroupObservationRejected();
    const a=readSnapshot(path);
    const b=readSnapshot(path);
    if(a.events!==b.events||a.procs!==b.procs||a.threads!==b.threads||
      parseCgroupV2Events(b.events).populated!==0||
      parseCgroupV2Pids(b.procs).length!==0||
      parseCgroupV2Pids(b.threads).length!==0)
      throw new CgroupObservationRejected();
    const evidenceDigest=createHash('sha256').update(JSON.stringify([
      'panter.runner-cgroup-observation/v1',scope,a.events,a.procs,a.threads,
    ])).digest('hex');
    return {status:'QUIESCENT_OBSERVATION_NOT_AUTHORIZATION',scope,
      observedAt:Date.now(),evidenceDigest,populated:0,procs:0,threads:0,
      permitsReclaim:false,permitsExecution:false};
  }catch{throw new CgroupObservationRejected();}
}
