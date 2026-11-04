/** Gemini wake over Gmail, without any Gemini API (same pattern Xanxittoo used for Spark).
 *
 * Gemini's only event trigger is a Gmail monitor. Panter therefore claims a READ-ONLY Gemini work for
 * one mail attempt, sends the task through the operator's Cloudflare email relay to the Gmail inbox
 * Gemini watches, and later accepts Gemini's e-mailed reply (forwarded by the same relay) only with a
 * one-time, lease-bound result token. Implementer work never travels by mail.
 *
 * Trust: the relay holds no secret. Before sending, it asks Panter to validate the exact envelope
 * (token + instruction digest of an outstanding ticket), so nobody can make it mail arbitrary tasks to
 * Gemini. A reply completes work only with the unused token of the current lease.
 */
import {createHash,randomBytes,timingSafeEqual} from 'node:crypto';
import {isIP} from 'node:net';
import {SqliteLedger} from './sqlite-ledger.js';

export const GEMINI_MAIL_ENVELOPE_VERSION='panter-gemini-mail-v1';
export const GEMINI_MAIL_RESULT_MARKER='PANTER_GEMINI_RESULT_V1';
const LEASE_SECONDS=3600;
const MAX_ATTEMPTS=3;
const MAX_RESULT=48_000;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type Ticket={workId:string;attemptId:string;leaseGeneration:number;tokenHash:string;instructionDigest:string;
  expiresAt:string;createdAt:string;sentAt:string|null;usedAt:string|null;attempt:number};
type Backoff={workId:string;attempts:number;nextAt:number};
type MailData={version:1;tickets:Ticket[];backoff:Backoff[]};
const seed:MailData={version:1,tickets:[],backoff:[]};

export type MailClaim={id:string;state:string;attemptId:string|null;leaseGeneration:number;leaseUntil:string|null;
  instruction:string;role:string;missionId:string};
export type MailMesh={
  pending(host:'gemini'):Promise<Array<{workId:string;role:string;createdAt:string}>>;
  claim(host:'gemini',workId:string,leaseSeconds:number,requireQueued:boolean,requireFree:boolean):Promise<MailClaim>;
  complete(host:'gemini',id:string,attemptId:string,generation:number,result:string,success:boolean):Promise<unknown>;
  releaseUnsentClaim(host:'gemini',id:string,attemptId:string,generation:number):Promise<unknown>;
};
export type RelaySender=(url:string,body:string,headers:Record<string,string>)=>Promise<number>;

const sha=(v:string)=>createHash('sha256').update(v).digest('hex');
const iso=(ms=Date.now())=>new Date(ms).toISOString();
const sameHash=(a:string,b:string)=>a.length===b.length&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
const defaultSender:RelaySender=async(url,body,headers)=>{
  const r=await fetch(url,{method:'POST',redirect:'manual',headers,body,signal:AbortSignal.timeout(10_000)});
  return r.status;
};

export function publicHttpsUrl(raw:string,label:string):URL{
  const u=new URL(raw);
  const h=u.hostname.toLowerCase();
  if(u.protocol!=='https:'||u.username||u.password||(u.port!==''&&u.port!=='443')||isIP(h)!==0||
    !h.includes('.')||h==='localhost'||/\.(localhost|local|internal|invalid|test|example)$/.test(h))
    throw Error(`${label} must be a public HTTPS URL`);
  return u;
}

export class GeminiMailWake{
  readonly configured:boolean;
  private readonly db:SqliteLedger|null;
  private readonly relayUrl:string;
  private readonly recipient:string;
  private running=false;
  constructor(dir:string,private readonly mesh:MailMesh,
    private readonly isListening:()=>boolean,
    env:Record<string,string|undefined>=process.env,
    private readonly sender:RelaySender=defaultSender,
    private readonly minAgeMs=Number(env.PANTER_GEMINI_MAIL_MIN_AGE_SECONDS??'20')*1000){
    const url=env.PANTER_GEMINI_MAIL_RELAY_URL??'';
    this.configured=Boolean(url);
    this.relayUrl=url?publicHttpsUrl(url,'PANTER_GEMINI_MAIL_RELAY_URL').toString():'';
    this.recipient=(env.PANTER_GEMINI_MAIL_RECIPIENT??'').trim().toLowerCase();
    if(this.configured&&!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(this.recipient))
      throw Error('PANTER_GEMINI_MAIL_RECIPIENT must be the Gmail address Gemini monitors');
    if(!Number.isFinite(this.minAgeMs)||this.minAgeMs<0)throw Error('Invalid PANTER_GEMINI_MAIL_MIN_AGE_SECONDS');
    this.db=this.configured?SqliteLedger.open(dir):null;
  }
  describe(){return {configured:this.configured,adapter:this.configured?'GEMINI_GMAIL_RELAY':'NONE',recipient:this.recipient||null};}

  /** Mail every due Gemini work once (or retry an expired, unanswered one). Never runs concurrently. */
  async dispatchDue(now=Date.now()):Promise<{sent:string[];failed:string[]}>{
    const out={sent:[] as string[],failed:[] as string[]};
    if(!this.configured||this.running)return out;
    this.running=true;
    try{
      // An open Gemini chat that is already waiting takes the work directly; mail only wakes an idle Gemini.
      if(this.isListening())return out;
      const data=this.db!.read('gemini_mail',seed);
      const blocked=(id:string)=>(data.backoff??[]).some(b=>b.workId===id&&b.nextAt>now);
      const queued=(await this.mesh.pending('gemini'))
        .filter(w=>w.role!=='implementer'&&now-Date.parse(w.createdAt)>=this.minAgeMs&&!blocked(w.workId))
        .map(w=>w.workId);
      // Unanswered tickets whose lease expired: re-mail with a fresh lease, up to MAX_ATTEMPTS.
      const retry=data.tickets.filter(t=>!t.usedAt&&t.sentAt&&Date.parse(t.expiresAt)<=now&&!blocked(t.workId)&&
        !data.tickets.some(n=>n.workId===t.workId&&n.attempt>t.attempt)).map(t=>t.workId);
      for(const workId of [...new Set([...queued,...retry])].slice(0,5)){
        const sent=await this.mailOne(workId,now).catch(()=>false);
        (sent?out.sent:out.failed).push(workId);
      }
      return out;
    }finally{this.running=false;}
  }

  private async mailOne(workId:string,now:number):Promise<boolean>{
    const previous=this.db!.read('gemini_mail',seed).tickets.filter(t=>t.workId===workId);
    const attempt=previous.length+1;
    let work:MailClaim;
    // requireFree: a live claim (e.g. an open Gemini chat that picked the work up) is never adopted.
    try{work=await this.mesh.claim('gemini',workId,LEASE_SECONDS,previous.length===0,true);}
    catch{
      // Completed, taken by a live Gemini chat, or no longer claimable: stop retrying its old tickets.
      if(previous.length)this.db!.mutate('gemini_mail',seed,d=>{for(const t of d.tickets)if(t.workId===workId&&!t.usedAt)t.usedAt=iso();});
      return false;
    }
    if(work.state!=='RUNNING'||!work.attemptId||!work.leaseUntil||work.role==='implementer')return false;
    if(attempt>MAX_ATTEMPTS){
      await this.mesh.complete('gemini',workId,work.attemptId,work.leaseGeneration,
        `Gemini mail relay: no reply after ${MAX_ATTEMPTS} e-mailed attempts; Gemini did not complete this task.`,false);
      return false;
    }
    const token=randomBytes(32).toString('base64url');
    const ticket:Ticket={workId,attemptId:work.attemptId,leaseGeneration:work.leaseGeneration,tokenHash:sha(token),
      instructionDigest:sha(work.instruction),expiresAt:work.leaseUntil,createdAt:iso(now),sentAt:null,usedAt:null,attempt};
    this.db!.mutate('gemini_mail',seed,d=>{d.tickets.push(ticket);d.tickets=d.tickets.slice(-500);});
    const envelope={work_id:workId,mission_id:work.missionId,role:work.role,lease_generation:work.leaseGeneration,
      expires_at:work.leaseUntil,attempt,instruction:work.instruction,result_marker:GEMINI_MAIL_RESULT_MARKER,
      result_template:{work_id:workId,token,success:'<true|false>',result:'<your complete result>'}};
    let status=0;
    try{
      status=await this.sender(this.relayUrl,JSON.stringify({version:GEMINI_MAIL_ENVELOPE_VERSION,
        recipient:this.recipient,envelope}),{'content-type':'application/json','user-agent':'Panter-Gemini-Mail/1'});
    }catch{status=0;}
    if(status>=200&&status<300){
      this.db!.mutate('gemini_mail',seed,d=>{
        const t=d.tickets.find(x=>x.workId===workId&&x.attempt===attempt);if(t)t.sentAt=iso();
        d.backoff=(d.backoff??[]).filter(b=>b.workId!==workId);
      });
      return true;
    }
    // Nothing reached Gemini: return the work to the queue and back off before retrying.
    await this.mesh.releaseUnsentClaim('gemini',workId,work.attemptId,work.leaseGeneration).catch(()=>{});
    this.db!.mutate('gemini_mail',seed,d=>{
      d.tickets=d.tickets.filter(x=>!(x.workId===workId&&x.attempt===attempt));
      d.backoff??=[];
      const b=d.backoff.find(x=>x.workId===workId)??(d.backoff.push({workId,attempts:0,nextAt:0}),d.backoff.at(-1)!);
      b.attempts++;b.nextAt=Date.now()+Math.min(30*60_000,60_000*2**(b.attempts-1));
    });
    return false;
  }

  /** Relay pre-send check: only an outstanding ticket's exact envelope may be e-mailed. */
  validateEnvelope(envelope:unknown){
    if(!this.configured)throw new MailError(404,'Gemini mail relay disabled');
    const e=envelope as Record<string,unknown>;
    const token=(e?.result_template as Record<string,unknown>|undefined)?.token;
    if(typeof e?.work_id!=='string'||!UUID.test(e.work_id)||typeof token!=='string'||typeof e.instruction!=='string')
      throw new MailError(400,'Invalid envelope');
    const t=this.db!.read('gemini_mail',seed).tickets.find(x=>x.workId===e.work_id&&!x.usedAt&&
      sameHash(x.tokenHash,sha(token)));
    if(!t||Date.parse(t.expiresAt)<=Date.now()||!sameHash(t.instructionDigest,sha(e.instruction as string))||
      e.lease_generation!==t.leaseGeneration)throw new MailError(403,'Envelope is not an outstanding Panter ticket');
    return {ok:true,work_id:t.workId,lease_generation:t.leaseGeneration};
  }

  /** Gemini's e-mailed reply, forwarded raw by the relay. Completes the exact lease once. */
  async acceptResult(payload:unknown){
    if(!this.configured)throw new MailError(404,'Gemini mail relay disabled');
    const p=payload as Record<string,unknown>;
    if(typeof p?.raw_mime_base64!=='string'||p.raw_mime_base64.length>800_000)throw new MailError(400,'Invalid payload');
    const texts=mimeTexts(Buffer.from(p.raw_mime_base64,'base64').toString('latin1'));
    const data=this.db!.read('gemini_mail',seed);
    for(const text of texts){
      for(const reply of markedJson(text)){
        const r=reply as Record<string,unknown>;
        if(typeof r.work_id!=='string'||typeof r.token!=='string'||typeof r.success!=='boolean'||
          typeof r.result!=='string'||!r.result.trim()||r.result.length>MAX_RESULT)continue;
        const t=data.tickets.find(x=>x.workId===r.work_id&&sameHash(x.tokenHash,sha(r.token as string)));
        if(!t)continue;
        if(t.usedAt)throw new MailError(409,'Result already accepted');
        try{await this.mesh.complete('gemini',t.workId,t.attemptId,t.leaseGeneration,
          `[via Gmail relay] ${r.result}`,r.success);}
        catch(error){throw new MailError(409,error instanceof Error?error.message:'Stale lease');}
        this.db!.mutate('gemini_mail',seed,d=>{const x=d.tickets.find(y=>y.workId===t.workId&&y.attempt===t.attempt);if(x)x.usedAt=iso();});
        return {ok:true,work_id:t.workId,state:r.success?'COMPLETED':'FAILED'};
      }
    }
    throw new MailError(422,`No valid ${GEMINI_MAIL_RESULT_MARKER} result with a current token`);
  }
}
export class MailError extends Error{constructor(readonly status:number,message:string){super(message);}}

/** Minimal MIME reader: text/plain parts first, then text/html (tags stripped). */
export function mimeTexts(raw:string):string[]{
  const plain:string[]=[],html:string[]=[];
  const walk=(part:string,depth:number)=>{
    if(depth>8)return;
    const split=part.search(/\r?\n\r?\n/);
    const head=split<0?part:part.slice(0,split);
    const body=split<0?'':part.slice(split).replace(/^\r?\n\r?\n/,'');
    const headers=head.replace(/\r?\n[ \t]+/g,' ').split(/\r?\n/);
    const get=(n:string)=>headers.find(h=>h.toLowerCase().startsWith(n+':'))?.slice(n.length+1).trim()??'';
    const type=get('content-type').toLowerCase()||'text/plain';
    const boundary=/boundary="?([^";]+)"?/i.exec(get('content-type'))?.[1];
    if(type.startsWith('multipart/')&&boundary){
      for(const sub of body.split('--'+boundary).slice(1)){
        if(sub.startsWith('--'))break;
        walk(sub.replace(/^\r?\n/,''),depth+1);
      }
      return;
    }
    if(!type.startsWith('text/'))return;
    const enc=get('content-transfer-encoding').toLowerCase();
    let bytes:Buffer;
    if(enc==='base64')bytes=Buffer.from(body.replace(/\s+/g,''),'base64');
    else if(enc==='quoted-printable')bytes=Buffer.from(body.replace(/=\r?\n/g,'')
      .replace(/=([0-9A-Fa-f]{2})/g,(_,h)=>String.fromCharCode(parseInt(h,16))),'latin1');
    else bytes=Buffer.from(body,'latin1');
    const text=bytes.toString('utf8');
    if(type.startsWith('text/html'))html.push(text.replace(/<br\s*\/?>/gi,'\n').replace(/<\/(p|div)>/gi,'\n')
      .replace(/<[^>]+>/g,'').replace(/&quot;/g,'"').replace(/&#39;|&#x27;/g,"'").replace(/&lt;/g,'<')
      .replace(/&gt;/g,'>').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&'));
    else plain.push(text);
  };
  walk(raw,0);
  return [...plain,...html];
}

/** JSON objects that follow each result marker, in order (the reply comes before any quoted template). */
export function markedJson(text:string):unknown[]{
  const out:unknown[]=[];
  let from=0;
  for(;;){
    const at=text.indexOf(GEMINI_MAIL_RESULT_MARKER,from);
    if(at<0)return out;
    from=at+GEMINI_MAIL_RESULT_MARKER.length;
    const start=text.indexOf('{',from);
    if(start<0)return out;
    let depth=0,inStr=false,esc=false,end=-1;
    for(let i=start;i<text.length&&i<start+MAX_RESULT*2;i++){
      const c=text[i];
      if(inStr){if(esc)esc=false;else if(c==='\\')esc=true;else if(c==='"')inStr=false;continue;}
      if(c==='"')inStr=true;else if(c==='{')depth++;else if(c==='}'&&--depth===0){end=i;break;}
    }
    if(end<0)continue;
    try{out.push(JSON.parse(text.slice(start,end+1)));}catch{/* quoted or wrapped copy; try the next marker */}
  }
}
