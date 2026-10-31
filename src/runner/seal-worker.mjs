/**
 * Cloudflare Worker implementation of an independent audit-seal authority.
 * NEVER deploy within the Panter runner UID, never grant runner R2 access.
 * The worker holds the Ed25519 PKCS#8 signing key as a Cloudflare secret.
 *
 * Access: bearer token only; R2 conditional create-once objects.
 * No delete/update APIs. Not wired to a live runner in this PR.
 */
const HEX=/^[0-9a-f]{64}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OPERATIONS=new Set(['workspace.prepare','git.inspect','git.diff','build.install',
  'build.check','build.compile','test.run','workspace.cleanup','release.request']);
const STATUS=new Set(['RESERVED','DENIED','SUCCEEDED','FAILED','QUARANTINED']);
const MAX_BODY=3*1024*1024;
const ZERO='0'.repeat(64);
const encoder=new TextEncoder();
function fail(status=400){return Response.json({error:'REJECTED'},{status,headers:{'Cache-Control':'no-store'}});}
function response(obj){return Response.json(obj,{headers:{'Cache-Control':'no-store'}});}
function bytesToB64Url(bytes){
  let s='';for(const b of bytes)s+=String.fromCharCode(b);
  return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
function base64Bytes(s){
  if(typeof s!=='string'||!/^[A-Za-z0-9_-]+$/.test(s))throw Error('noncanonical');
  const b64=s.replace(/-/g,'+').replace(/_/g,'/');
  const raw=atob(b64);
  const bytes=Uint8Array.from(raw,c=>c.charCodeAt(0));
  if(bytesToB64Url(bytes)!==s)throw Error('noncanonical');
  return bytes;
}
function strictKeys(x,names){
  return x!==null&&typeof x==='object'&&!Array.isArray(x)&&
    Object.keys(x).sort().join('|')===[...names].sort().join('|');
}
function claimOK(x){
  return strictKeys(x,['domain','segment','firstSequence','lastSequence','lastHash','previousSealHash','contentSha256','bytes'])&&
    x.domain==='panter.segment-seal/v1'&&Number.isSafeInteger(x.segment)&&x.segment>=1&&
    Number.isSafeInteger(x.firstSequence)&&x.firstSequence>=1&&
    Number.isSafeInteger(x.lastSequence)&&x.lastSequence>=x.firstSequence&&
    Number.isSafeInteger(x.bytes)&&x.bytes>0&&x.bytes<=2*1024*1024&&
    [x.lastHash,x.previousSealHash,x.contentSha256].every(v=>typeof v==='string'&&HEX.test(v));
}
function sealPayload(c){
  if(!claimOK(c))throw Error('bad claim');
  return encoder.encode(JSON.stringify(['panter.segment-seal/v1',c.segment,c.firstSequence,c.lastSequence,
    c.lastHash,c.previousSealHash,c.contentSha256,c.bytes]));
}
async function sha256(bytes){
  const hash=new Uint8Array(await crypto.subtle.digest('SHA-256',bytes));
  return [...hash].map(b=>b.toString(16).padStart(2,'0')).join('');
}
async function sealDigest(receipt){
  const sig=base64Bytes(receipt.signature);
  const payload=sealPayload(receipt.claim);
  const bytes=new Uint8Array(payload.length+sig.length);
  bytes.set(payload);bytes.set(sig,payload.length);
  return sha256(bytes);
}
async function verifyRows(claim,data){
  if(data.length!==claim.bytes||await sha256(data)!==claim.contentSha256)throw Error('bad payload');
  if(data.length>0&&data.at(-1)!==10)throw Error('truncated');
  const text=new TextDecoder('utf-8',{fatal:true}).decode(data);
  const lines=text.length?text.trimEnd().split('\n'):[];
  if(lines.length!==claim.lastSequence-claim.firstSequence+1)throw Error('wrong range');
  let seq=claim.firstSequence;
  let previous=null;
  for(const line of lines){
    const row=JSON.parse(line);
    if(!strictKeys(row,['segment','sequence','previousHash','event','hash'])||
      row.segment!==claim.segment||row.sequence!==seq||typeof row.previousHash!=='string'||
      !HEX.test(row.previousHash)||typeof row.hash!=='string'||!HEX.test(row.hash)||
      !strictKeys(row.event,['requestId','operation','grantDigest','status','outputDigest'])||
      typeof row.event.requestId!=='string'||!UUID.test(row.event.requestId)||
      !OPERATIONS.has(row.event.operation)||!STATUS.has(row.event.status)||
      typeof row.event.grantDigest!=='string'||!HEX.test(row.event.grantDigest)||
      typeof row.event.outputDigest!=='string'||!HEX.test(row.event.outputDigest))throw Error('bad row');
    if(previous!==null&&row.previousHash!==previous)throw Error('broken link');
    const digestInput=encoder.encode(JSON.stringify(['panter.segment-row/v1',row.segment,row.sequence,row.previousHash,row.event]));
    if(await sha256(digestInput)!==row.hash||JSON.stringify(row)+'\n'!==line+'\n')throw Error('bad row digest');
    previous=row.hash;seq++;
  }
  if((lines.length?previous:null)!== (lines.length?claim.lastHash:null))throw Error('wrong last hash');
}
function receiptKey(i){return 'receipts/'+String(i).padStart(8,'0')+'.json';}
function dataKey(i){return 'payloads/'+String(i).padStart(8,'0')+'.jsonl';}
async function latest(env){
  let cursor=undefined,maximum=0;
  do{
    const result=await env.SEAL_BUCKET.list({prefix:'receipts/',limit:1000,...(cursor?{cursor}:{})});
    for(const obj of result.objects){
      const match=/^receipts\/(\d{8})\.json$/.exec(obj.key);
      if(!match)throw Error('unexpected receipt');
      maximum=Math.max(maximum,Number(match[1]));
    }
    cursor=result.truncated?result.cursor:undefined;
  }while(cursor);
  return maximum?getReceipt(env,maximum):null;
}
async function getReceipt(env,i){
  const obj=await env.SEAL_BUCKET.get(receiptKey(i));
  if(!obj)return null;
  const receipt=await obj.json();
  if(!strictKeys(receipt,['keyId','claim','signature'])||!claimOK(receipt.claim)||
    receipt.claim.segment!==i||receipt.keyId!==env.SEAL_KEY_ID||
    typeof receipt.signature!=='string'||!/^[A-Za-z0-9_-]{86}$/.test(receipt.signature))throw Error('untrusted receipt');
  const publicKey=await crypto.subtle.importKey('spki',
    base64Bytes(env.SEAL_PUBLIC_KEY_SPKI_B64.replace(/=+$/,'').replace(/\+/g,'-').replace(/\//g,'_')),
    {name:'Ed25519'},false,['verify']);
  const signature=base64Bytes(receipt.signature);
  if(signature.length!==64||!await crypto.subtle.verify('Ed25519',publicKey,signature,sealPayload(receipt.claim)))
    throw Error('forged receipt');
  return receipt;
}
async function putOnce(bucket,key,text){
  const inserted=await bucket.put(key,text,{onlyIf:new Headers({'If-None-Match':'*'})});
  if(inserted!==null)return;
  const present=await bucket.get(key);
  if(!present||await present.text()!==text)throw Error('immutable conflict');
}
async function signClaim(env,claim){
  const keyBytes=base64Bytes(env.SEAL_PRIVATE_KEY_PKCS8_B64.replace(/=+$/,'').replace(/\+/g,'-').replace(/\//g,'_'));
  const key=await crypto.subtle.importKey('pkcs8',keyBytes,{name:'Ed25519'},false,['sign']);
  const sig=new Uint8Array(await crypto.subtle.sign('Ed25519',key,sealPayload(claim)));
  return {keyId:env.SEAL_KEY_ID,claim,signature:bytesToB64Url(sig)};
}
function allowed(request,env){
  if(typeof env.SEAL_BEARER_TOKEN!=='string'||env.SEAL_BEARER_TOKEN.length<32)return false;
  const expected='Bearer '+env.SEAL_BEARER_TOKEN;
  const got=request.headers.get('authorization')??'';
  if(got.length!==expected.length)return false;
  let diff=0;for(let i=0;i<got.length;i++)diff|=got.charCodeAt(i)^expected.charCodeAt(i);
  return diff===0;
}
export default {
  async fetch(request,env){
    if(!allowed(request,env)||!env.SEAL_BUCKET||!env.SEAL_KEY_ID||!env.SEAL_PRIVATE_KEY_PKCS8_B64||!env.SEAL_PUBLIC_KEY_SPKI_B64)return fail(403);
    const url=new URL(request.url);
    try{
      if(request.method==='GET'&&url.pathname==='/seal/latest')return response({receipt:await latest(env)});
      const match=/^\/seal\/(\d{8})$/.exec(url.pathname);
      if(request.method==='GET'&&match)return response({receipt:await getReceipt(env,Number(match[1]))});
      if(request.method!=='POST'||url.pathname!=='/seal')return fail(404);
      if(Number(request.headers.get('content-length')??0)>MAX_BODY)return fail(413);
      const text=await request.text();
      if(encoder.encode(text).length>MAX_BODY)return fail(413);
      const body=JSON.parse(text);
      if(!strictKeys(body,['claim','segmentBase64'])||!claimOK(body.claim))return fail();
      const claim=body.claim,raw=base64Bytes(body.segmentBase64);
      if(raw.length>2*1024*1024)return fail(413);
      await verifyRows(claim,raw);
      const old=await getReceipt(env,claim.segment);
      if(old){
        if(JSON.stringify(old.claim)!==JSON.stringify(claim))return fail(409);
        // Verify payload is still byte-identical when serving an idempotent retry.
        const stored=await env.SEAL_BUCKET.get(dataKey(claim.segment));
        if(!stored||await stored.text()!==new TextDecoder().decode(raw))return fail(409);
        return response({receipt:old});
      }
      const prev=await latest(env),n=(prev?.claim.segment??0)+1;
      if(claim.segment!==n||claim.firstSequence!==(prev?prev.claim.lastSequence+1:1)||
        claim.previousSealHash!==(prev?await sealDigest(prev):ZERO))return fail(409);
      // First event must chain to the previous sealed last hash.
      if(raw.length){
        const first=JSON.parse(new TextDecoder().decode(raw).split('\n')[0]);
        if(first.previousHash!==(prev?prev.claim.lastHash:ZERO))return fail(409);
      }else if(prev&&claim.lastHash!==prev.claim.lastHash)return fail(409);
      // Crash between data and receipt: a retry can complete the receipt if the
      // data exists and matches. Concurrent writes cannot replace one another.
      const dataText=new TextDecoder().decode(raw);
      await putOnce(env.SEAL_BUCKET,dataKey(n),dataText);
      const signed=await signClaim(env,claim);
      await putOnce(env.SEAL_BUCKET,receiptKey(n),JSON.stringify(signed));
      const persisted=await getReceipt(env,n);
      if(!persisted||JSON.stringify(persisted)!==JSON.stringify(signed))return fail(409);
      return response({receipt:persisted});
    }catch{return fail(409);}
  }
};
