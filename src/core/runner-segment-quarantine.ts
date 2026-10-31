/**
 * Evidence-only capture for a terminal incomplete JSONL row.
 * No truncation, retry, cutover, or resumption. This is NOT a recovery grant.
 */
import {createHash,randomBytes,type KeyObject} from 'node:crypto';
import {closeSync,constants,fstatSync,fsyncSync,linkSync,lstatSync,mkdirSync,
  openSync,readFileSync,readdirSync,unlinkSync,writeSync} from 'node:fs';
import {basename,dirname,join,resolve} from 'node:path';
import {SegmentIntegrityError,inspectSeal,segmentSealDigest,verifySegmentPrefix,
  type SignedSegmentSeal} from './runner-segments.js';

const ZERO='0'.repeat(64);
const NOFOLLOW=constants.O_NOFOLLOW??0;
function sha(b:Buffer):string{return createHash('sha256').update(b).digest('hex');}
export type QuarantinedSegmentTail={
  status:'OUTCOME_UNKNOWN';
  segment:number;
  firstSequence:number;
  prefixEntries:number;
  prefixLastHash:string;
  externalAnchorDigest:string;
  originalSha256:string;
  originalBytes:number;
  tailSha256:string;
  tailBytes:number;
  evidenceFile:string;
  receiptFile:string;
};
function signedLatest(latest:SignedSegmentSeal|null,pinned:ReadonlyMap<string,KeyObject>):
  {segment:number,first:number,previousHash:string,previousSealHash:string,anchor:string}{
  if(latest===null)return {segment:1,first:1,previousHash:ZERO,previousSealHash:ZERO,anchor:ZERO};
  // Common strict verifier validates exact envelope keys, canonical signature and claim.
  const verified=inspectSeal(latest,pinned,latest.claim);
  const claim=verified.claim;
  if(claim.segment>=99_999_999)throw new SegmentIntegrityError();
  const anchor=segmentSealDigest(verified);
  return {segment:claim.segment+1,first:claim.lastSequence+1,
    previousHash:claim.lastHash,previousSealHash:anchor,anchor};
}
/** Capture only the next unsealed segment relative to a freshly fetched signed anchor. */
export function quarantineActiveSegmentTail(rootPath:string,remoteLatest:SignedSegmentSeal|null,
  pinned:ReadonlyMap<string,KeyObject>):QuarantinedSegmentTail{
  const root=resolve(rootPath);
  let rootStat:ReturnType<typeof lstatSync>;
  try{rootStat=lstatSync(root);}catch{throw new SegmentIntegrityError();}
  if(!rootStat.isDirectory()||rootStat.isSymbolicLink()||
    rootStat.uid!==process.getuid?.()||(rootStat.mode&0o077)!==0)throw new SegmentIntegrityError();
  const anchor=signedLatest(remoteLatest,pinned);
  const expected=Array.from({length:anchor.segment},(_,i)=>
    'segment-'+String(i+1).padStart(8,'0')+'.jsonl');
  if(readdirSync(root).sort().join('|')!==expected.sort().join('|'))
    throw new SegmentIntegrityError();
  const filename=join(root,'segment-'+String(anchor.segment).padStart(8,'0')+'.jsonl');
  let raw:Buffer;
  const fd=openSync(filename,constants.O_RDONLY|NOFOLLOW|constants.O_NONBLOCK);
  try{
    const before=fstatSync(fd);
    if(!before.isFile()||before.uid!==process.getuid?.()||(before.mode&0o077)!==0||
      before.size>2*1024*1024)throw new SegmentIntegrityError();
    raw=readFileSync(fd);
    const after=fstatSync(fd);
    if(raw.length!==before.size||after.ino!==before.ino||after.size!==before.size||
      after.mtimeMs!==before.mtimeMs)throw new SegmentIntegrityError();
  }finally{closeSync(fd);}
  if(!raw.length||raw.at(-1)===10)throw new SegmentIntegrityError();
  const lastBreak=raw.lastIndexOf(10);
  const prefix=raw.subarray(0,lastBreak+1);
  const tail=raw.subarray(lastBreak+1);
  if(!tail.length)throw new SegmentIntegrityError();
  // Any malformed complete row remains an integrity failure, NOT crash tail.
  const checked=verifySegmentPrefix(prefix,anchor.segment,anchor.first,
    anchor.previousHash,anchor.previousSealHash);
  const evidenceDir=join(dirname(root),basename(root)+'-quarantine');
  try{mkdirSync(evidenceDir,{mode:0o700});}
  catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw new SegmentIntegrityError();}
  const dirStat=lstatSync(evidenceDir);
  if(!dirStat.isDirectory()||dirStat.isSymbolicLink()||
    dirStat.uid!==process.getuid?.()||(dirStat.mode&0o077)!==0)throw new SegmentIntegrityError();
  const base='segment-'+String(anchor.segment).padStart(8,'0')+'-'+sha(raw);
  const evidenceFile=join(evidenceDir,base+'.bin');
  const receiptFile=join(evidenceDir,base+'.json');
  const report:QuarantinedSegmentTail={status:'OUTCOME_UNKNOWN',segment:anchor.segment,
    firstSequence:anchor.first,prefixEntries:checked.entries,prefixLastHash:checked.lastHash,
    externalAnchorDigest:anchor.anchor,originalSha256:sha(raw),originalBytes:raw.length,
    tailSha256:sha(tail),tailBytes:tail.length,evidenceFile,receiptFile};
  // Durable receipt contains only relocatable basenames, never absolute paths.
  const relativeReport={...report,evidenceFile:basename(evidenceFile),receiptFile:basename(receiptFile)};
  const receiptBytes=Buffer.from(JSON.stringify(relativeReport)+'\n');
  function fsyncDir(){
    const dirFd=openSync(evidenceDir,constants.O_RDONLY|constants.O_DIRECTORY|NOFOLLOW);
    try{fsyncSync(dirFd);}finally{closeSync(dirFd);}
  }
  function existing(path:string,bytes:Buffer):boolean{
    let rfd:number;
    try{rfd=openSync(path,constants.O_RDONLY|NOFOLLOW|constants.O_NONBLOCK);}
    catch(e){
      if((e as NodeJS.ErrnoException).code==='ENOENT')return false;
      throw new SegmentIntegrityError();
    }
    try{
      const s=fstatSync(rfd);
      if(!s.isFile()||s.uid!==process.getuid?.()||(s.mode&0o777)!==0o400||
        s.size!==bytes.length)throw new SegmentIntegrityError();
      const actual=readFileSync(rfd);
      const after=fstatSync(rfd);
      if(!actual.equals(bytes)||after.size!==s.size||after.mtimeMs!==s.mtimeMs)
        throw new SegmentIntegrityError();
      return true;
    }finally{closeSync(rfd);}
  }
  function publish(path:string,bytes:Buffer):void{
    if(existing(path,bytes))return;
    const tmp=join(evidenceDir,'.pending-'+randomBytes(16).toString('hex'));
    const wfd=openSync(tmp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|NOFOLLOW,0o400);
    try{
      let i=0;
      while(i<bytes.length){const n=writeSync(wfd,bytes,i,bytes.length-i);
        if(n<=0)throw new SegmentIntegrityError();i+=n;}
      fsyncSync(wfd);
    }finally{closeSync(wfd);}
    try{
      try{linkSync(tmp,path);}
      catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST'||!existing(path,bytes))
        throw new SegmentIntegrityError();}
      fsyncDir();
      if(!existing(path,bytes))throw new SegmentIntegrityError();
    }finally{
      unlinkSync(tmp);fsyncDir();
    }
  }
  // A forged receipt with missing bin is not recoverable: fail closed.
  if(existing(receiptFile,receiptBytes)&&!existing(evidenceFile,tail))
    throw new SegmentIntegrityError();
  publish(evidenceFile,tail);
  publish(receiptFile,receiptBytes);
  if(!existing(evidenceFile,tail)||!existing(receiptFile,receiptBytes))
    throw new SegmentIntegrityError();
  // The active segment is intentionally left byte-identical and unusable.
  return report;
}
