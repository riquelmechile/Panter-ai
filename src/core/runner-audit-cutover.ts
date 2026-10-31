/**
 * Audit cutover staging: copy verified legacy metadata into remotely sealed
 * segments. This deliberately NEVER switches the live writer or executes work.
 * Existing legacy bytes remain untouched. Future activation requires an
 * independent writer-freeze barrier, process fencing, and recovery E2E.
 */
import {createHash,randomBytes} from 'node:crypto';
import {closeSync,constants,existsSync,fstatSync,fsyncSync,lstatSync,linkSync,mkdirSync,
  openSync,readFileSync,readdirSync,unlinkSync,writeSync} from 'node:fs';
import {join,resolve} from 'node:path';
import type {KeyObject} from 'node:crypto';
import {snapshotRunnerAudit,AuditIntegrityError,type RunnerAuditEvent} from './runner-journal.js';
import {AsyncSegmentedRunnerAudit,type AsyncSealAuthority} from './runner-seal-http.js';
import {inspectSeal,segmentSealDigest,SegmentIntegrityError,type SegmentedEvent} from './runner-segments.js';

const NOFOLLOW=constants.O_NOFOLLOW??0;
export type RunnerAuditStagingReceipt={
  domain:'panter.runner-audit-cutover-staging/v1';
  legacySha256:string;legacyBytes:number;legacyEntries:number;legacyLastHash:string;
  segmentEntries:number;sealedSegments:number;lastHash:string;externalSealDigest:string;
  segmentDirectory:'segments';
};
function safeDir(path:string):void{
  let stat:ReturnType<typeof lstatSync>;
  try{stat=lstatSync(path);}catch{throw new SegmentIntegrityError();}
  if(!stat.isDirectory()||stat.isSymbolicLink()||
     stat.uid!==process.getuid?.()||(stat.mode&0o077)!==0)throw new SegmentIntegrityError();
}
function identical(a:unknown,b:RunnerAuditEvent):boolean{
  if(!a||typeof a!=='object'||Array.isArray(a))return false;
  const x=a as Record<string,unknown>;
  return x.requestId===b.requestId&&x.operation===b.operation&&
    x.grantDigest===b.grantDigest&&x.status===b.status&&x.outputDigest===b.outputDigest;
}
/** Confirm staged prefix corresponds to the exact complete verified legacy rows. */
function verifyStagedPrefix(folder:string,rows:RunnerAuditEvent[],expected:number):void{
  const names=readdirSync(folder).sort();
  let index=0;
  for(const name of names){
    if(!/^segment-\d{8}\.jsonl$/.test(name))throw new SegmentIntegrityError();
    const file=join(folder,name);
    const fd=openSync(file,constants.O_RDONLY|NOFOLLOW|constants.O_NONBLOCK);
    let raw:string;
    try{
      const before=fstatSync(fd);
      if(!before.isFile()||before.uid!==process.getuid?.()||
        (before.mode&0o077)!==0||before.size>2*1024*1024)
        throw new SegmentIntegrityError();
      const content=readFileSync(fd);
      const after=fstatSync(fd);
      if(content.length!==before.size||after.ino!==before.ino||
        after.size!==before.size||after.mtimeMs!==before.mtimeMs)
        throw new SegmentIntegrityError();
      try{raw=new TextDecoder('utf-8',{fatal:true}).decode(content);}
      catch{throw new SegmentIntegrityError();}
    }finally{closeSync(fd);}
    if(raw.length&&!raw.endsWith('\n'))throw new SegmentIntegrityError();
    for(const line of raw.split('\n').filter(Boolean)){
      let parsed:unknown;
      try{parsed=JSON.parse(line);}catch{throw new SegmentIntegrityError();}
      if(!parsed||typeof parsed!=='object'||!('event' in parsed)||
         !rows[index]||!identical((parsed as {event:unknown}).event,rows[index]!))
        throw new SegmentIntegrityError();
      index++;
    }
  }
  if(index!==expected)throw new SegmentIntegrityError();
}
function publishManifest(root:string,data:Buffer):void{
  const manifest=JSON.parse(data.toString('utf8')) as RunnerAuditStagingReceipt;
  if(!/^[0-9a-f]{64}$/.test(manifest.legacySha256))throw new SegmentIntegrityError();
  const path=join(root,'cutover-staging-'+manifest.legacySha256+'.json');
  function validate():boolean{
    if(!existsSync(path))return false;
    let s:ReturnType<typeof lstatSync>;
    try{s=lstatSync(path);}catch{throw new SegmentIntegrityError();}
    if(!s.isFile()||s.isSymbolicLink()||(s.mode&0o777)!==0o400||
       s.uid!==process.getuid?.())throw new SegmentIntegrityError();
    if(!readFileSync(path).equals(data))throw new SegmentIntegrityError();
    return true;
  }
  if(validate())return;
  const temp=join(root,'.pending-'+randomBytes(16).toString('hex'));
  const fd=openSync(temp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|NOFOLLOW,0o400);
  try{let off=0;while(off<data.length){
    const n=writeSync(fd,data,off,data.length-off);
    if(n<=0)throw new SegmentIntegrityError();off+=n;
  }fsyncSync(fd);}finally{closeSync(fd);}
  try{
    try{linkSync(temp,path);}catch(e){
      if((e as NodeJS.ErrnoException).code!=='EEXIST'||!validate())throw new SegmentIntegrityError();
    }
    const rootFd=openSync(root,constants.O_RDONLY|constants.O_DIRECTORY|NOFOLLOW);
    try{fsyncSync(rootFd);}finally{closeSync(rootFd);}
    if(!validate())throw new SegmentIntegrityError();
  }finally{unlinkSync(temp);}
}
/**
 * Stage from a read-only legacy snapshot. A source writer race is detected
 * by pre/post fingerprints, but this does NOT prevent writes after return.
 * The result is NOT a permission to change active writers.
 */
export async function stageLegacyAuditCutover(
  legacyDir:string,stagingRoot:string,remote:AsyncSealAuthority,
  pinned:ReadonlyMap<string,KeyObject>,segmentLimit=1024*1024,
):Promise<RunnerAuditStagingReceipt>{
  const before=snapshotRunnerAudit(legacyDir);
  if(before.rows.length===0)throw new AuditIntegrityError();
  const root=resolve(stagingRoot);
  try{mkdirSync(root,{recursive:false,mode:0o700});}
  catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw new SegmentIntegrityError();}
  safeDir(root);
  const dir=join(root,'segments');
  const journal=await AsyncSegmentedRunnerAudit.open(dir,remote,pinned,segmentLimit);
  const rows=before.rows.map(row=>({
    requestId:row.requestId,operation:row.operation,grantDigest:row.grantDigest,
    status:row.status,outputDigest:row.outputDigest,
  } satisfies SegmentedEvent));
  const already=journal.state().entries;
  if(already>rows.length)throw new SegmentIntegrityError();
  verifyStagedPrefix(dir,rows,already);
  for(let i=already;i<rows.length;i++)await journal.append(rows[i]!);
  if(journal.state().activeBytes>0)await journal.sealCurrent();
  const state=journal.state();
  if(state.entries!==rows.length||state.activeBytes!==0||state.sealed<1)
    throw new SegmentIntegrityError();
  const after=snapshotRunnerAudit(legacyDir);
  if(after.sha256!==before.sha256||after.bytes!==before.bytes||
     after.rows.length!==before.rows.length||after.lastHash!==before.lastHash)
    throw new AuditIntegrityError();
  const latest=await remote.latest();
  if(!latest||latest.claim.segment!==state.sealed||
     latest.claim.lastSequence!==state.entries||latest.claim.lastHash!==state.lastHash)
    throw new SegmentIntegrityError();
  // The final receipt is a second remote read; verify it independently rather
  // than trusting the claim fields or hashing unauthenticated signature text.
  const verifiedLatest=inspectSeal(latest,pinned,latest.claim);
  const receipt:RunnerAuditStagingReceipt={
    domain:'panter.runner-audit-cutover-staging/v1',
    legacySha256:before.sha256,legacyBytes:before.bytes,legacyEntries:before.rows.length,
    legacyLastHash:before.lastHash,segmentEntries:state.entries,sealedSegments:state.sealed,
    lastHash:state.lastHash,externalSealDigest:segmentSealDigest(verifiedLatest),segmentDirectory:'segments',
  };
  // The evidence name is content-addressed by the verified original snapshot.
  // Never replace an earlier snapshot manifest after legacy bytes have changed.
  publishManifest(root,Buffer.from(JSON.stringify(receipt)+'\n'));
  // Last verification closes the obvious race before returning (not a writer lock).
  if(snapshotRunnerAudit(legacyDir).sha256!==before.sha256)throw new AuditIntegrityError();
  return receipt;
}
