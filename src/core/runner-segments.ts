/**
 * Offline segmented audit journal and off-host seal protocol (no dispatcher).
 * Single writer. No remote private key, execution, network client or deployment.
 *
 * The SealAuthority MUST be a separate UID/host with an append-only store and
 * independent Ed25519 private key; a local mock is for tests ONLY.
 */
import {createHash,verify, type KeyObject} from 'node:crypto';
import {constants,closeSync,existsSync,fstatSync,fsyncSync,lstatSync,mkdirSync,openSync,readFileSync,readdirSync,statSync,writeSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {RUNNER_OPERATIONS,type RunnerOperation} from './runner-grants.js';

const ZERO='0'.repeat(64);
const HEX=/^[0-9a-f]{64}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NOFOLLOW=constants.O_NOFOLLOW??0;
export class SegmentIntegrityError extends Error {
  constructor(){super('Segmented audit integrity failure');this.name='SegmentIntegrityError';}
}
export type SegmentedEvent={
  requestId:string;
  operation:RunnerOperation;
  grantDigest:string;
  status:'RESERVED'|'DENIED'|'SUCCEEDED'|'FAILED'|'QUARANTINED';
  outputDigest:string;
};
type SegmentRow={segment:number,sequence:number,previousHash:string,event:SegmentedEvent,hash:string};
export type SegmentSealClaim={
  domain:'panter.segment-seal/v1';
  segment:number;
  firstSequence:number;
  lastSequence:number;
  lastHash:string;
  previousSealHash:string;
  contentSha256:string;
  bytes:number;
};
export type SignedSegmentSeal={keyId:string,claim:SegmentSealClaim,signature:string};
export interface ExternalSealAuthority {
  /** Must read a signed, immutable anchor from outside the runner UID/host. */
  latest():SignedSegmentSeal|null;
  get(segment:number):SignedSegmentSeal|null;
  /** Append-only create, MUST reject a different claim at the same index. */
  seal(claim:SegmentSealClaim):SignedSegmentSeal;
}
export type SegmentInspection={sealed:number,activeSegment:number,entries:number,lastHash:string,activeBytes:number};

function digest(x:Buffer|string):string{return createHash('sha256').update(x).digest('hex');}
function keys(x:unknown,fields:string[]):x is Record<string,unknown>{
  return x!==null&&typeof x==='object'&&!Array.isArray(x)&&
    Object.keys(x).sort().join('\0')===[...fields].sort().join('\0');
}
function eventOk(x:unknown):x is SegmentedEvent{
  if(!keys(x,['requestId','operation','grantDigest','status','outputDigest']))return false;
  return typeof x.requestId==='string'&&UUID.test(x.requestId)&&
    typeof x.operation==='string'&&RUNNER_OPERATIONS.includes(x.operation as RunnerOperation)&&
    typeof x.grantDigest==='string'&&HEX.test(x.grantDigest)&&
    typeof x.outputDigest==='string'&&HEX.test(x.outputDigest)&&
    ['RESERVED','DENIED','SUCCEEDED','FAILED','QUARANTINED'].includes(String(x.status));
}
function rowBody(r:Omit<SegmentRow,'hash'>):Buffer{
  return Buffer.from(JSON.stringify(['panter.segment-row/v1',r.segment,r.sequence,r.previousHash,r.event]));
}
function rowEncoded(r:SegmentRow):Buffer{return Buffer.from(JSON.stringify(r)+'\n');}
function sealBody(c:SegmentSealClaim):Buffer{
  return Buffer.from(JSON.stringify(['panter.segment-seal/v1',c.segment,c.firstSequence,c.lastSequence,
    c.lastHash,c.previousSealHash,c.contentSha256,c.bytes]));
}
export function segmentSealDigest(s:SignedSegmentSeal):string{
  const signature=Buffer.from(s.signature,'base64url');
  return digest(Buffer.concat([sealBody(s.claim),signature]));
}
function validClaim(x:unknown):x is SegmentSealClaim{
  if(!keys(x,['domain','segment','firstSequence','lastSequence','lastHash','previousSealHash','contentSha256','bytes']))return false;
  return x.domain==='panter.segment-seal/v1'&&
    Number.isSafeInteger(x.segment)&&(x.segment as number)>0&&
    Number.isSafeInteger(x.firstSequence)&&(x.firstSequence as number)>0&&
    Number.isSafeInteger(x.lastSequence)&&(x.lastSequence as number)>=(x.firstSequence as number)&&
    Number.isSafeInteger(x.bytes)&&(x.bytes as number)>0&&
    [x.lastHash,x.previousSealHash,x.contentSha256].every(z=>typeof z==='string'&&HEX.test(z));
}
function sameClaim(a:SegmentSealClaim,b:SegmentSealClaim):boolean{return sealBody(a).equals(sealBody(b));}
function inspectSeal(seal:unknown,keysPinned:ReadonlyMap<string,KeyObject>,claim:SegmentSealClaim):SignedSegmentSeal {
  if(!keys(seal,['keyId','claim','signature'])||typeof seal.keyId!=='string'||
    typeof seal.signature!=='string'||!validClaim(seal.claim)||!sameClaim(seal.claim,claim))throw new SegmentIntegrityError();
  const key=keysPinned.get(seal.keyId);
  if(!key||key.asymmetricKeyType!=='ed25519'||!/^[A-Za-z0-9_-]{86}$/.test(seal.signature))throw new SegmentIntegrityError();
  const sig=Buffer.from(seal.signature,'base64url');
  if(sig.length!==64||sig.toString('base64url')!==seal.signature||!verify(null,sealBody(claim),key,sig))throw new SegmentIntegrityError();
  return seal as unknown as SignedSegmentSeal;
}
export function segmentSealPayload(claim:SegmentSealClaim):Buffer{
  if(!validClaim(claim))throw new SegmentIntegrityError();
  return sealBody(claim);
}
function segmentName(i:number):string{return 'segment-'+String(i).padStart(8,'0')+'.jsonl';}
function validateDir(dir:string):string{
  const root=resolve(dir);
  mkdirSync(root,{recursive:true,mode:0o700});
  const s=lstatSync(root);
  if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid?.()||(s.mode&0o077)!==0)throw new SegmentIntegrityError();
  return root;
}
function openExisting(p:string):Buffer {
  const fd=openSync(p,constants.O_RDONLY|NOFOLLOW|constants.O_NONBLOCK);
  try {
    const s=fstatSync(fd);
    if(!s.isFile()||s.uid!==process.getuid?.()||(s.mode&0o077)!==0||s.size>2*1024*1024)throw new SegmentIntegrityError();
    const data=readFileSync(fd);
    const second=fstatSync(fd);
    if(data.length!==s.size||second.ino!==s.ino||second.size!==s.size||second.mtimeMs!==s.mtimeMs)throw new SegmentIntegrityError();
    return data;
  }finally{closeSync(fd);}
}
function createSegment(p:string):void{
  const fd=openSync(p,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|NOFOLLOW,0o600);
  try{fsyncSync(fd);}finally{closeSync(fd);}
}
type Scan={segment:number,first:number,last:number,hash:string,bytes:number,contentSha256:string,previousSealHash:string};
function scanSegment(p:string,index:number,sequence:number,prevHash:string,previousSealHash:string):Scan{
  return scanSegmentBytes(openExisting(p),index,sequence,prevHash,previousSealHash);
}
function scanSegmentBytes(data:Buffer,index:number,sequence:number,prevHash:string,previousSealHash:string):Scan{
  if(data.length>2*1024*1024||(data.length>0&&data.at(-1)!==10))throw new SegmentIntegrityError();
  const lines=data.length?data.toString('utf8').trimEnd().split('\n'):[];
  let seq=sequence,hash=prevHash;
  for(const line of lines){
    let row:unknown;
    try{row=JSON.parse(line);}catch{throw new SegmentIntegrityError();}
    if(!keys(row,['segment','sequence','previousHash','event','hash'])||
      row.segment!==index||row.sequence!==seq||row.previousHash!==hash||!eventOk(row.event)||
      typeof row.hash!=='string'||!HEX.test(row.hash))throw new SegmentIntegrityError();
    const body={segment:index,sequence:seq,previousHash:hash,event:row.event};
    if(digest(rowBody(body))!==row.hash||!rowEncoded({...body,hash:row.hash}).equals(Buffer.from(line+'\n')))throw new SegmentIntegrityError();
    hash=row.hash;
    seq++;
  }
  return {segment:index,first:sequence,last:seq-1,hash,bytes:data.length,contentSha256:digest(data),previousSealHash};
}
/** Strictly validate complete crash-tail prefix bytes against expected chain anchors. */
export function verifySegmentPrefix(data:Buffer,index:number,firstSequence:number,prevHash:string,
  previousSealHash:string):{entries:number,lastHash:string}{
  const scan=scanSegmentBytes(data,index,firstSequence,prevHash,previousSealHash);
  return {entries:scan.last-firstSequence+1,lastHash:scan.hash};
}
function claimOf(scan:Scan):SegmentSealClaim{
  return {domain:'panter.segment-seal/v1',segment:scan.segment,firstSequence:scan.first,
    lastSequence:scan.last,lastHash:scan.hash,previousSealHash:scan.previousSealHash,
    contentSha256:scan.contentSha256,bytes:scan.bytes};
}
export class SegmentedRunnerAudit {
  private sequence=1;
  private lastHash=ZERO;
  private segment=1;
  private bytes=0;
  private readonly root:string;
  private previousSealHash=ZERO;
  private readonly limit:number;
  private readonly authority:ExternalSealAuthority;
  private readonly pinned:ReadonlyMap<string,KeyObject>;
  constructor(root:string,authority:ExternalSealAuthority,pinned:ReadonlyMap<string,KeyObject>,limit=1024*1024){
    if(!Number.isSafeInteger(limit)||limit<512||limit>2*1024*1024||pinned.size===0)throw new SegmentIntegrityError();
    this.root=validateDir(root);this.authority=authority;this.pinned=pinned;this.limit=limit;
    this.recover();
  }
  private path(n:number){return join(this.root,segmentName(n));}
  private syncDir(){
    const fd=openSync(this.root,constants.O_RDONLY|constants.O_DIRECTORY|NOFOLLOW);
    try{fsyncSync(fd);}finally{closeSync(fd);}
  }
  private recover():void{
    const files=readdirSync(this.root);
    if(files.some(f=>!/^segment-\d{8}\.jsonl$/.test(f)))throw new SegmentIntegrityError();
    const indices=files.map(f=>Number(f.slice(8,16))).sort((a,b)=>a-b);
    if(indices.some((z,i)=>z!==i+1))throw new SegmentIntegrityError();
    const latest=this.authority.latest();
    if(latest!==null&&(!keys(latest,['keyId','claim','signature'])||!validClaim(latest.claim)))throw new SegmentIntegrityError();
    const highest=latest?.claim.segment??0;
    if(highest>indices.length||highest<indices.length-1)throw new SegmentIntegrityError();
    if(indices.length===0){
      if(latest!==null)throw new SegmentIntegrityError();
      createSegment(this.path(1));this.syncDir();
      this.firstSequence=this.sequence;this.segmentStartHash=this.lastHash;
      return;
    }
    let first=1,prev=ZERO,prevSeal=ZERO;
    for(const [offset,number] of indices.entries()){
      const previousHashBeforeScan=prev;
      const scan=scanSegment(this.path(number),number,first,prev,prevSeal);
      const receipt=this.authority.get(number);
      if(number<=highest){
        if(!receipt)throw new SegmentIntegrityError();
        const verified=inspectSeal(receipt,this.pinned,claimOf(scan));
        prevSeal=segmentSealDigest(verified);
        if(number===highest&&latest&&segmentSealDigest(latest)!==prevSeal)throw new SegmentIntegrityError();
      }else if(receipt!==null)throw new SegmentIntegrityError();
      if(number<indices.length && number>highest)throw new SegmentIntegrityError();
      first=scan.last+1;prev=scan.hash;
      if(offset===indices.length-1){this.sequence=first;this.lastHash=prev;this.bytes=scan.bytes;this.segment=number;this.previousSealHash=number<=highest?prevSeal:scan.previousSealHash;this.firstSequence=scan.first;this.segmentStartHash=number<=highest?scan.hash:(scan.first===1?ZERO:previousHashBeforeScan);}
    }
    // Crash after remote sealing but before creation of the next active file.
    if(highest===indices.length){
      createSegment(this.path(highest+1));this.syncDir();
      this.segment=highest+1;this.bytes=0;
      this.previousSealHash=prevSeal;
      this.firstSequence=this.sequence;this.segmentStartHash=this.lastHash;
    }
  }
  private rotate():void {
    // Explicit active-segment anchors survive recovery without recounting sealed rows.
    const scan=scanSegment(this.path(this.segment),this.segment,
      this.firstSequence,this.segmentStartHash,this.previousSealHash);
    const claim=claimOf(scan);
    const existing=this.authority.get(this.segment);
    const seal=inspectSeal(existing??this.authority.seal(claim),this.pinned,claim);
    if(segmentSealDigest(this.authority.latest()!)!==segmentSealDigest(seal))throw new SegmentIntegrityError();
    const next=this.segment+1;
    if(existsSync(this.path(next)))throw new SegmentIntegrityError();
    createSegment(this.path(next));this.syncDir();
    this.previousSealHash=segmentSealDigest(seal);
    this.segment=next;this.bytes=0;this.firstSequence=this.sequence;this.segmentStartHash=this.lastHash;
  }
  private firstSequence=1;
  private segmentStartHash=ZERO;
  append(event:SegmentedEvent):SegmentInspection {
    if(!eventOk(event))throw new SegmentIntegrityError();
    let row=this.row(event);
    if(this.bytes+row.length>this.limit){this.rotate();row=this.row(event);}
    if(row.length>this.limit)throw new SegmentIntegrityError();
    const p=this.path(this.segment);
    const stat=lstatSync(p);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==this.bytes||
      stat.uid!==process.getuid?.()||(stat.mode&0o077)!==0)throw new SegmentIntegrityError();
    const fd=openSync(p,constants.O_APPEND|constants.O_WRONLY|NOFOLLOW);
    try{
      const atOpen=fstatSync(fd);
      if(atOpen.ino!==stat.ino||atOpen.size!==stat.size)throw new SegmentIntegrityError();
      let offset=0;while(offset<row.length){const n=writeSync(fd,row,offset,row.length-offset);if(n<=0)throw new SegmentIntegrityError();offset+=n;}
      fsyncSync(fd);
    }catch{throw new SegmentIntegrityError();}finally{closeSync(fd);}
    const line=JSON.parse(row.toString()) as SegmentRow;
    this.bytes+=row.length;this.lastHash=line.hash;this.sequence++;
    return this.state();
  }
  private row(event:SegmentedEvent):Buffer{
    const body={segment:this.segment,sequence:this.sequence,previousHash:this.lastHash,event};
    return rowEncoded({...body,hash:digest(rowBody(body))});
  }
  /** Size of the next row for async pre-rotation; throws on invalid event. */
  previewAppendBytes(event:SegmentedEvent):number{
    if(!eventOk(event))throw new SegmentIntegrityError();
    return this.row(event).length;
  }
  /** Immutable evidence for async off-host sealing, before any local rotation. */
  pendingSeal():{claim:SegmentSealClaim;payload:Buffer}{
    if(this.bytes===0)throw new SegmentIntegrityError();
    const p=this.path(this.segment);
    const scan=scanSegment(p,this.segment,this.firstSequence,this.segmentStartHash,this.previousSealHash);
    if(scan.bytes!==this.bytes||scan.last!==this.sequence-1||scan.hash!==this.lastHash)
      throw new SegmentIntegrityError();
    const payload=openExisting(p);
    if(digest(payload)!==scan.contentSha256)throw new SegmentIntegrityError();
    return {claim:claimOf(scan),payload};
  }
  state():SegmentInspection{return {sealed:this.segment-1,activeSegment:this.segment,entries:this.sequence-1,lastHash:this.lastHash,activeBytes:this.bytes};}
  /** Operator-controlled explicit seal; no effectful executor may rely on local-only hashes. */
  sealCurrent():SegmentInspection{
    if(this.bytes===0)throw new SegmentIntegrityError();
    this.rotate();return this.state();
  }
}
