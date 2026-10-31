/**
 * Offline-configurable async HTTP bridge for the independent Worker seal API.
 * All outbound requests are HTTPS, signed seals are verified by the journal.
 * No Worker/R2 resources or credentials are provisioned by this module.
 */
import type {KeyObject} from 'node:crypto';
import {segmentSealDigest,SegmentedRunnerAudit,SegmentIntegrityError,
  type ExternalSealAuthority,type SegmentInspection,type SegmentedEvent,
  type SegmentSealClaim,type SignedSegmentSeal} from './runner-segments.js';

export interface AsyncSealAuthority {
  latest():Promise<SignedSegmentSeal|null>;
  get(segment:number):Promise<SignedSegmentSeal|null>;
  seal(claim:SegmentSealClaim,payload:Buffer):Promise<SignedSegmentSeal>;
}

/** Dependency-injected fetch allows end-to-end tests against an in-process Worker. */
export class HttpSegmentSealAuthority implements AsyncSealAuthority {
  private readonly base:string;
  private readonly bearer:string;
  private readonly send:(request:Request)=>Promise<Response>;
  constructor(url:string,bearer:string,send:(request:Request)=>Promise<Response>=fetch){
    let origin:URL;
    try{origin=new URL(url);}catch{throw new SegmentIntegrityError();}
    if(origin.protocol!=='https:'||origin.pathname!=='/'||origin.search||origin.hash||
      origin.username||origin.password||!origin.hostname||
      typeof bearer!=='string'||bearer.length<32)throw new SegmentIntegrityError();
    this.base=origin.origin;this.bearer=bearer;this.send=send;
  }
  private async request(path:string,data?:object):Promise<unknown>{
    const body=data?JSON.stringify(data):undefined;
    try{
      const response=await this.send(new Request(this.base+path,{
        method:body?'POST':'GET',redirect:'error',signal:AbortSignal.timeout(10_000),
        headers:{authorization:'Bearer '+this.bearer,
          ...(body?{'content-type':'application/json'}:{})},
        ...(body?{body}:{}),
      }));
      if(response.status!==200||Number(response.headers.get('content-length')||0)>8192)
        throw new SegmentIntegrityError();
      const raw=await response.text();
      if(raw.length>8192)throw new SegmentIntegrityError();
      const json:unknown=JSON.parse(raw);
      if(!json||typeof json!=='object'||Array.isArray(json)||
        Object.keys(json).sort().join()!=='receipt')throw new SegmentIntegrityError();
      return (json as {receipt:unknown}).receipt;
    }catch{throw new SegmentIntegrityError();}
  }
  async latest():Promise<SignedSegmentSeal|null>{
    return (await this.request('/seal/latest')) as SignedSegmentSeal|null;
  }
  async get(segment:number):Promise<SignedSegmentSeal|null>{
    if(!Number.isSafeInteger(segment)||segment<1||segment>99_999_999)throw new SegmentIntegrityError();
    return (await this.request('/seal/'+String(segment).padStart(8,'0'))) as SignedSegmentSeal|null;
  }
  async seal(claim:SegmentSealClaim,payload:Buffer):Promise<SignedSegmentSeal>{
    if(payload.length>2*1024*1024||payload.length===0)throw new SegmentIntegrityError();
    return (await this.request('/seal',{claim,segmentBase64:payload.toString('base64url')})) as SignedSegmentSeal;
  }
}
/** Synchronous, in-memory authority populated ONLY by completed HTTP calls. */
class SealCache implements ExternalSealAuthority {
  private readonly receipts=new Map<number,SignedSegmentSeal>();
  latest():SignedSegmentSeal|null{return this.receipts.get(this.receipts.size)??null;}
  get(n:number):SignedSegmentSeal|null{return this.receipts.get(n)??null;}
  seal():SignedSegmentSeal{throw new SegmentIntegrityError();} // no synchronous signing fallback
  install(segment:number,receipt:SignedSegmentSeal):void{
    if(!receipt||receipt.claim?.segment!==segment||!Number.isSafeInteger(segment)||
      segment!==this.receipts.size+1)throw new SegmentIntegrityError();
    this.receipts.set(segment,receipt);
  }
}
/**
 * All local appends/rotations are serialized. Unknown network outcomes fail
 * closed; caller can retry the identical bytes, never a different claim.
 */
export class AsyncSegmentedRunnerAudit {
  private busy=false;
  private constructor(
    private readonly journal:SegmentedRunnerAudit,
    private readonly remote:AsyncSealAuthority,
    private readonly cache:SealCache,
    private readonly limit:number,
  ){}
  static async open(root:string,remote:AsyncSealAuthority,pinned:ReadonlyMap<string,KeyObject>,
    limit=1024*1024):Promise<AsyncSegmentedRunnerAudit>{
    const cache=new SealCache();
    try{
      const latest=await remote.latest();
      if(latest!==null){
        const end=latest.claim?.segment;
        if(!Number.isSafeInteger(end)||end<1||end>10_000)throw new SegmentIntegrityError();
        for(let i=1;i<=end;i++){
          const receipt=await remote.get(i);
          if(!receipt)throw new SegmentIntegrityError();
          cache.install(i,receipt);
        }
        if(segmentSealDigest(cache.latest()!)!==segmentSealDigest(latest))
          throw new SegmentIntegrityError();
      }
      return new AsyncSegmentedRunnerAudit(new SegmentedRunnerAudit(root,cache,pinned,limit),
        remote,cache,limit);
    }catch{throw new SegmentIntegrityError();}
  }
  state():SegmentInspection{return this.journal.state();}
  private async exclusive<T>(work:()=>Promise<T>):Promise<T>{
    if(this.busy)throw new SegmentIntegrityError();
    this.busy=true;
    try{return await work();}finally{this.busy=false;}
  }
  private async sealUnlocked():Promise<SegmentInspection>{
    const {claim,payload}=this.journal.pendingSeal();
    // Network failure leaves the active local segment unchanged; the server
    // may already have sealed it, so recovery/retry MUST reuse these bytes.
    const receipt=await this.remote.seal(claim,payload);
    this.cache.install(claim.segment,receipt);
    // verify independent signature, local content and chain before creating next
    return this.journal.sealCurrent();
  }
  async sealCurrent():Promise<SegmentInspection>{
    return this.exclusive(()=>this.sealUnlocked());
  }
  async append(event:SegmentedEvent):Promise<SegmentInspection>{
    return this.exclusive(async()=>{
      const size=this.journal.previewAppendBytes(event);
      if(size>this.limit)throw new SegmentIntegrityError();
      if(this.journal.state().activeBytes+size>this.limit)await this.sealUnlocked();
      return this.journal.append(event);
    });
  }
}
