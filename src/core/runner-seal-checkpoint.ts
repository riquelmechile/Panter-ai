/**
 * Untrusted local index of signed segment receipts. Every row is reverified
 * against pinned keys and the latest off-host signed anchor before use.
 * This avoids N sequential remote GETs on normal restart; it does not bypass
 * the complete local JSONL hash-chain scan or create a new signing authority.
 */
import {randomBytes} from 'node:crypto';
import {closeSync,constants,existsSync,fstatSync,fsyncSync,lstatSync,
  openSync,readFileSync,renameSync,unlinkSync,writeSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {SegmentIntegrityError,type SignedSegmentSeal} from './runner-segments.js';

const NAME='seal-checkpoint.json';
const NOFOLLOW=constants.O_NOFOLLOW??0;
const MAX_BYTES=256*1024*1024;
export function loadSealCheckpoint(rootPath:string):SignedSegmentSeal[]|null{
  const file=join(resolve(rootPath),NAME);
  if(!existsSync(file))return null;
  let fd:number;
  try{fd=openSync(file,constants.O_RDONLY|NOFOLLOW|constants.O_NONBLOCK);}
  catch{throw new SegmentIntegrityError();}
  try{
    const before=fstatSync(fd);
    if(!before.isFile()||before.uid!==process.getuid?.()||(before.mode&0o077)!==0||
      before.size<=0||before.size>MAX_BYTES)throw new SegmentIntegrityError();
    const raw=readFileSync(fd);
    const after=fstatSync(fd);
    if(raw.length!==before.size||after.ino!==before.ino||after.size!==before.size||
      after.mtimeMs!==before.mtimeMs)throw new SegmentIntegrityError();
    let data:unknown;
    try{data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw));}
    catch{throw new SegmentIntegrityError();}
    if(!data||typeof data!=='object'||Array.isArray(data))throw new SegmentIntegrityError();
    const v=data as Record<string,unknown>;
    if(Object.keys(v).sort().join('|')!=='domain|receipts'||
      v.domain!=='panter.segment-seal-checkpoint/v1'||!Array.isArray(v.receipts))
      throw new SegmentIntegrityError();
    return v.receipts as SignedSegmentSeal[];
  }finally{closeSync(fd);}
}
/** Atomic local cache replacement; network receipt remains the sole authority. */
export function saveSealCheckpoint(rootPath:string,receipts:SignedSegmentSeal[]):void{
  const root=resolve(rootPath);
  const s=lstatSync(root);
  if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid?.()||
    (s.mode&0o077)!==0)throw new SegmentIntegrityError();
  const path=join(root,NAME),tmp=join(root,'.pending-seal-'+randomBytes(16).toString('hex'));
  const payload=Buffer.from(JSON.stringify({domain:'panter.segment-seal-checkpoint/v1',receipts})+'\n');
  if(payload.length>MAX_BYTES)throw new SegmentIntegrityError();
  const fd=openSync(tmp,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|NOFOLLOW,0o600);
  try{
    let pos=0;
    while(pos<payload.length){
      const n=writeSync(fd,payload,pos,payload.length-pos);
      if(n<1)throw new SegmentIntegrityError();pos+=n;
    }
    fsyncSync(fd);
  }finally{closeSync(fd);}
  try{
    if(existsSync(path)){
      const existing=lstatSync(path);
      if(!existing.isFile()||existing.isSymbolicLink()||
        existing.uid!==process.getuid?.()||(existing.mode&0o077)!==0)
        throw new SegmentIntegrityError();
    }
    renameSync(tmp,path);
    const dirFd=openSync(root,constants.O_RDONLY|constants.O_DIRECTORY|NOFOLLOW);
    try{fsyncSync(dirFd);}finally{closeSync(dirFd);}
  }finally{
    if(existsSync(tmp))unlinkSync(tmp);
  }
}
