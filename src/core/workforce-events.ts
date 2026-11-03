/** MCP Events webhook delivery for host-native ChatGPT Work. The backend
 * never invokes provider inference: a connected GPT-B Work chat owns the
 * subscription and the callback. Only opaque, actor-bound work pointers leave.
 * https://developers.openai.com/plugins/build/mcp-events
 */
import {createHash,createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
import {lookup} from 'node:dns/promises';
import {request} from 'node:https';
import {BlockList,isIP,type LookupFunction} from 'node:net';
import {SqliteLedger} from './sqlite-ledger.js';

export const WORK_EVENT='panter.work.ready';
export type EventHost='gpt-b'|'gemini';
type Subscription={id:string;owner:EventHost;url:string;secret:string;expiresAt:string;verifiedAt:string};
type Delivery={id:string;subId:string;workId:string;state:'PENDING'|'SENDING'|'ACCEPTED'|'FAILED';
  attempts:number;nextAt:number;lastStatus:number|null;terminalAt?:number;
  failureReason?:'SUBSCRIPTION_INACTIVE'};
type EventData={version:1;subscriptions:Subscription[];deliveries:Delivery[]};
type PostResult={status:number;body:string};
export type EventPost=(url:string,headers:Record<string,string>,body:string)=>Promise<PostResult>;
const seed:EventData={version:1,subscriptions:[],deliveries:[]};
const hash=(v:string)=>createHash('sha256').update(v).digest('hex');
const now=()=>Date.now();
// DNS was prevalidated; honor both Node.js lookup callback shapes.
export function pinnedAddressLookup(address:string,family:number):LookupFunction{
  return (_hostname,opts,callback)=>{
    if(opts.all)callback(null,[{address,family}]);
    else callback(null,address,family);
  };
}

const privateIps=new BlockList();
for(const [ip,mask] of [
  ['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],
  ['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],
  ['192.0.2.0',24],['192.168.0.0',16],['198.18.0.0',15],
  ['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],
  ['240.0.0.0',4],
] as const)privateIps.addSubnet(ip,mask,'ipv4');
for(const [ip,mask] of [
  ['::',128],['::1',128],['fc00::',7],['fe80::',10],
  ['ff00::',8],['2001:db8::',32],['2001:10::',28],
] as const)privateIps.addSubnet(ip,mask,'ipv6');

const MAX_OUTSTANDING=2000;
const MAX_TERMINAL_HISTORY=2000;
const TERMINAL_HISTORY_TTL_MS=7*24*60*60*1000;
const isTerminal=(d:Delivery)=>d.state==='ACCEPTED'||d.state==='FAILED';
/** Keep successful webhook dedup while work remains queued, but bound terminal
 * history after work is no longer in the authenticated actor's queue.
 * A webhook 2xx must never be mistaken for a completed worker claim.
 */
function compactTerminalHistory(d:EventData,actor:EventHost,queued:Set<string>){
  const owners=new Set(d.subscriptions.filter(s=>s.owner===actor).map(s=>s.id));
  const eligible=d.deliveries.filter(x=>isTerminal(x)&&owners.has(x.subId)&&!queued.has(x.workId));
  eligible.sort((a,b)=>(b.terminalAt??b.nextAt)-(a.terminalAt??a.nextAt));
  const keep=new Set(eligible.slice(0,MAX_TERMINAL_HISTORY)
    .filter(x=>(x.terminalAt??x.nextAt)>=now()-TERMINAL_HISTORY_TTL_MS).map(x=>x.id));
  const candidates=new Set(eligible.map(x=>x.id));
  d.deliveries=d.deliveries.filter(x=>!candidates.has(x.id)||keep.has(x.id));
}

export function publicIp(ip:string):boolean{
  const family=isIP(ip);
  if(!family)return false;
  if(family===6&&!ip.toLowerCase().startsWith('2'))return false;
  return !privateIps.check(ip,family===4?'ipv4':'ipv6');
}
export function validCallback(raw:string):URL{
  if(typeof raw!=='string'||raw.length>2048)throw Error('Invalid webhook callback');
  let u:URL;
  try{u=new URL(raw);}catch{throw Error('Invalid webhook callback');}
  const host=u.hostname.toLowerCase();
  if(u.protocol!=='https:'||!host.includes('.')||isIP(host)!==0||
    u.username||u.password||u.port||u.hash||
    host==='localhost'||host.endsWith('.localhost')||
    host.endsWith('.internal')||host.endsWith('.local')||
    host.endsWith('.test')||host.endsWith('.invalid')||host.endsWith('.example'))
    throw Error('Only public HTTPS callback endpoints are allowed');
  return u;
}
function secretBytes(secret:string):Buffer{
  if(typeof secret!=='string'||!/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret))
    throw Error('Invalid webhook signing secret');
  const raw=secret.slice(6);
  const bytes=Buffer.from(raw,'base64');
  if(bytes.length<24||bytes.length>64||bytes.toString('base64')!==raw)
    throw Error('Invalid webhook signing secret');
  return bytes;
}
export function webhookHeaders(secret:string,id:string,subscriptionId:string,body:string,
  signedAt=Math.floor(now()/1000)){
  const timestamp=String(signedAt);
  const digest=createHmac('sha256',secretBytes(secret))
    .update(id+'.'+timestamp+'.'+body).digest('base64');
  return {'content-type':'application/json','webhook-id':id,
    'webhook-timestamp':timestamp,'webhook-signature':'v1,'+digest,
    'X-MCP-Subscription-Id':subscriptionId};
}
export async function safeWebhookPost(url:string,headers:Record<string,string>,
  body:string):Promise<PostResult>{
  const u=validCallback(url);
  // Resolve before each call; reject every private answer and pin one validated
  // address for the TLS connection. Preserve hostname for certificate/SNI.
  const records=await lookup(u.hostname,{all:true,verbatim:true});
  if(!records.length||!records.every(r=>publicIp(r.address)))
    throw Error('Unsafe webhook destination');
  const selected=records[0]!;
  return new Promise<PostResult>((resolve,reject)=>{
    const req=request(u,{method:'POST',
      servername:u.hostname,timeout:7000,maxHeaderSize:16384,
      lookup:pinnedAddressLookup(selected.address,selected.family),
      headers:{...headers,'content-length':Buffer.byteLength(body)}},
    res=>{
      const chunks:Buffer[]=[];let total=0;
      res.on('data',(chunk:Buffer)=>{
        total+=chunk.length;
        if(total>8192){req.destroy(Error('Webhook response too large'));return;}
        chunks.push(chunk);
      });
      res.on('end',()=>resolve({status:res.statusCode??0,
        body:Buffer.concat(chunks).toString('utf8')}));
      res.on('error',reject);
    });
    req.on('timeout',()=>req.destroy(Error('Webhook timeout')));
    req.on('error',reject);req.end(body);
  });
}
function assertActor(actor:string):asserts actor is EventHost{
  if(actor!=='gpt-b'&&actor!=='gemini')
    throw Error('Only GPT-B or Gemini OAuth actors may subscribe to Panter MCP events');
}
function eventArgs(input:unknown,actor:EventHost){
  if(!input||typeof input!=='object'||Array.isArray(input))throw Error('Invalid event arguments');
  const args=input as Record<string,unknown>;
  if(Object.keys(args).length!==1||args.host!==actor)throw Error('Event filter must match authenticated actor');
}
function subId(owner:EventHost,url:string){
  return 'sub_'+hash(owner+'\n'+url+'\n'+WORK_EVENT+'\n'+JSON.stringify({host:owner})).slice(0,32);
}
const isLive=(s:Subscription,t=now())=>Date.parse(s.expiresAt)>t;

export class WorkforceEvents{
  private readonly db:SqliteLedger;
  constructor(directory:string,private readonly post:EventPost=safeWebhookPost){
    this.db=SqliteLedger.open(directory);
  }
  list(actor:string){
    // Other authenticated Panter hosts still use the same MCP plugin;
    // an empty event catalog must not disrupt their ordinary tool discovery.
    if(actor!=='gpt-b'&&actor!=='gemini')return {events:[]};
    return {events:[{name:WORK_EVENT,
      description:'An authenticated '+actor+' work pointer is ready. Claim with panter_workforce_pickup.',
      delivery:['webhook'],
      inputSchema:{type:'object',properties:{host:{type:'string',enum:[actor]}},
        required:['host'],additionalProperties:false},
      payloadSchema:{type:'object',properties:{workId:{type:'string',format:'uuid'}},
        required:['workId'],additionalProperties:false}}]};
  }
  hasActive(actor:EventHost){
    const data=this.db.read('events',seed);
    return data.subscriptions.some(s=>s.owner===actor&&isLive(s));
  }
  async subscribe(actor:string,args:{name:string;arguments:unknown;
    delivery:{mode:string;url:string;secret:string};ttlMs?:number|null;
    cursor?:string|null}){
    assertActor(actor);if(args.name!==WORK_EVENT)throw Error('Unknown event');
    eventArgs(args.arguments,actor);
    if(args.cursor!==undefined&&args.cursor!==null)throw Error('Event replay not supported');
    if(args.delivery?.mode!=='webhook')throw Error('Webhook delivery required');
    const u=validCallback(args.delivery.url);
    const secret=args.delivery.secret;
    secretBytes(secret);
    const requested=args.ttlMs===undefined||args.ttlMs===null?86_400_000:args.ttlMs;
    if(!Number.isInteger(requested)||requested<60_000)throw Error('Invalid event subscription TTL');
    const ttl=Math.min(86_400_000,requested);
    const id=subId(actor,u.toString());
    const exists=this.db.read('events',seed).subscriptions.find(s=>s.id===id&&isLive(s)&&s.secret===secret);
    if(!exists){
      const challenge=randomBytes(24).toString('base64url');
      const message='msg_verification_'+randomBytes(12).toString('hex');
      const body=JSON.stringify({type:'verification',challenge});
      let verified:PostResult;
      try{verified=await this.post(u.toString(),webhookHeaders(secret,message,id,body),body);}
      catch{throw Error('CallbackEndpointError: connection or TLS failure');}
      if(verified.status<200||verified.status>=300)throw Error('CallbackEndpointError: verification HTTP error');
      let returned:unknown;
      try{returned=JSON.parse(verified.body);}catch{throw Error('CallbackEndpointError: invalid verification response');}
      const received=(returned as {challenge?:unknown})?.challenge;
      const r=typeof received==='string'?Buffer.from(received):Buffer.alloc(0);
      const expected=Buffer.from(challenge);
      if(r.length!==expected.length||!timingSafeEqual(r,expected))
        throw Error('CallbackEndpointError: challenge_failed');
    }
    const expiresAt=new Date(now()+ttl).toISOString();
    const saved:Subscription={id,owner:actor,url:u.toString(),secret,
      expiresAt,verifiedAt:new Date().toISOString()};
    this.db.mutate('events',seed,d=>{
      const i=d.subscriptions.findIndex(x=>x.id===id);
      if(i<0)d.subscriptions.push(saved);
      else d.subscriptions[i]=saved;
      // Preserve durable pending events on refresh and key rotation.
      // The exact raw body is re-signed on each attempt with the current key.
    });
    return {id,refreshBefore:expiresAt,cursor:null,truncated:false};
  }
  unsubscribe(actor:string,args:{name:string;arguments:unknown;delivery:{url:string}}){
    assertActor(actor);if(args.name!==WORK_EVENT)throw Error('Unknown event');
    eventArgs(args.arguments,actor);
    const url=validCallback(args.delivery?.url).toString();
    const id=subId(actor,url);
    this.db.mutate('events',seed,d=>{
      d.subscriptions=d.subscriptions.filter(x=>x.id!==id||x.owner!==actor);
      d.deliveries=d.deliveries.filter(x=>x.subId!==id);
    });
    return {};
  }
  /** Reconcile only real QUEUED pointers for the authenticated host. */
  queue(actor:EventHost,workIds:string[]){
    const ids=[...new Set(workIds.filter(id=>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)))].slice(0,100);
    const stillQueued=new Set(workIds);
    return this.db.mutate('events',seed,d=>{
      compactTerminalHistory(d,actor,stillQueued);
      if(!ids.length)return 0;
      let added=0;
      let outstanding=d.deliveries.filter(x=>!isTerminal(x)).length;
      for(const sub of d.subscriptions.filter(s=>s.owner===actor&&isLive(s)))
        for(const workId of ids){
          const id='evt_'+hash(sub.id+':'+workId).slice(0,32);
          const existing=d.deliveries.find(x=>x.id===id);
          if(existing){
            // Only an expiration-failed event can be rearmed, and only when
            // the actor is subscribed again AND the work remains queued.
            if(existing.state==='FAILED'&&existing.failureReason==='SUBSCRIPTION_INACTIVE'){
              if(outstanding>=MAX_OUTSTANDING)throw Error('MCP event backlog limit reached');
              existing.state='PENDING';existing.attempts=0;existing.nextAt=now();
              existing.lastStatus=null;existing.terminalAt=undefined;
              existing.failureReason=undefined;outstanding++;added++;
            }
            continue;
          }
          if(outstanding>=MAX_OUTSTANDING)throw Error('MCP event backlog limit reached');
          outstanding++;
          d.deliveries.push({id,subId:sub.id,workId,state:'PENDING',
            attempts:0,nextAt:now(),lastStatus:null});added++;
        }
      return added;
    }).result;
  }
  /** CAS lease in SQLite. Two server processes cannot post the same attempt. */
  async flush(limit=10){
    let attempted=0;
    for(let n=0;n<Math.min(20,limit);n++){
      const item=this.db.mutate('events',seed,d=>{
        const t=now();
        const next=d.deliveries.find(x=>(x.state==='PENDING'&&x.nextAt<=t)||
          (x.state==='SENDING'&&x.nextAt<=t));
        if(!next)return null;
        const sub=d.subscriptions.find(s=>s.id===next.subId&&isLive(s,t));
        if(!sub){next.state='FAILED';next.terminalAt=t;next.failureReason='SUBSCRIPTION_INACTIVE';return null;}
        if(next.attempts>=5){next.state='FAILED';next.terminalAt=t;return null;}
        next.attempts++;next.state='SENDING';next.nextAt=t+60_000;
        return {delivery:{...next},sub:{...sub}};
      }).result;
      if(!item)break;
      attempted++;
      const {delivery,sub}=item;
      const body=JSON.stringify({eventId:delivery.id,name:WORK_EVENT,
        timestamp:new Date().toISOString(),data:{workId:delivery.workId},cursor:null});
      let status:number|null=null;
      try{
        const response=await this.post(sub.url,
          webhookHeaders(sub.secret,delivery.id,sub.id,body),body);
        status=response.status;
      }catch{/* Never log host URL, token, exception or body. */}
      this.db.mutate('events',seed,d=>{
        const x=d.deliveries.find(y=>y.id===delivery.id);
        if(!x||x.state!=='SENDING'||x.attempts!==delivery.attempts)return;
        x.lastStatus=status;
        if(status!==null&&status>=200&&status<300){x.state='ACCEPTED';x.terminalAt=now();return;}
        if(status===410||status===413||x.attempts>=5){x.state='FAILED';x.terminalAt=now();return;}
        x.state='PENDING';
        x.nextAt=now()+Math.min(300_000,5000*2**(x.attempts-1));
      });
    }
    return attempted;
  }
  status(actor:string){
    if(actor!=='gpt-a')throw Error('Only GPT-A may inspect event wake');
    const data=this.db.read('events',seed);
    return {hosts:['gpt-b','gemini'].map(host=>({host,activeSubscriptions:data.subscriptions.filter(s=>s.owner===host&&isLive(s)).length})),subscriptions:data.subscriptions.filter(s=>isLive(s)).length,
      pending:data.deliveries.filter(x=>x.state==='PENDING'||x.state==='SENDING').length,
      accepted:data.deliveries.filter(x=>x.state==='ACCEPTED').length,
      failed:data.deliveries.filter(x=>x.state==='FAILED').length,
      autonomousWakeVerified:false as const};
  }
}

/** Always drain existing webhooks even if one actor's enqueue hits its limit. */
export async function reconcileWorkforceEventOutbox(
  hosts:readonly EventHost[],
  pending:(host:EventHost)=>Promise<ReadonlyArray<{workId:string}>>,
  events:Pick<WorkforceEvents,'queue'|'flush'>
):Promise<{enqueueFailures:number;flushed:number}>{
  const attempts=await Promise.allSettled(hosts.map(async host=>{
    const rows=await pending(host);
    events.queue(host,rows.map(x=>x.workId));
  }));
  const flushed=await events.flush();
  return {enqueueFailures:attempts.filter(x=>x.status==='rejected').length,flushed};
}
