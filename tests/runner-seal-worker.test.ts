import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash,generateKeyPairSync,randomUUID,verify} from 'node:crypto';
// Worker is deliberately framework-free JS for Cloudflare's WebCrypto runtime.
// @ts-expect-error Separate worker deployment has no local TS declaration
import worker from '../src/runner/seal-worker.mjs';

const pair=generateKeyPairSync('ed25519');
const privateB64=pair.privateKey.export({format:'der',type:'pkcs8'}).toString('base64');
const publicB64=pair.publicKey.export({format:'der',type:'spki'}).toString('base64');
const token='test-owner-token-with-at-least-32-bytes';
class FakeR2{
  readonly objects=new Map<string,string>();
  put(key:string,value:string,opts?:{onlyIf?:Headers}):Promise<{key:string}|null>{
    if(opts?.onlyIf?.get('If-None-Match')==='*'&&this.objects.has(key))return Promise.resolve(null);
    this.objects.set(key,value);return Promise.resolve({key});
  }
  get(key:string):Promise<{text:()=>Promise<string>,json:()=>Promise<unknown>}|null>{
    const value=this.objects.get(key);
    return Promise.resolve(value===undefined?null:{
      text:async()=>value,json:async()=>JSON.parse(value),
    });
  }
  list(args:{prefix:string}):Promise<{objects:{key:string}[],truncated:false}>{
    return Promise.resolve({objects:[...this.objects.keys()].filter(k=>k.startsWith(args.prefix))
      .map(key=>({key})),truncated:false});
  }
}
function env(bucket=new FakeR2()){
  return {SEAL_BUCKET:bucket,SEAL_KEY_ID:'external-1',SEAL_BEARER_TOKEN:token,
    SEAL_PRIVATE_KEY_PKCS8_B64:privateB64,SEAL_PUBLIC_KEY_SPKI_B64:publicB64};
}
function h(s:string|Buffer){return createHash('sha256').update(s).digest('hex');}
function receiptPayload(claim:any){return Buffer.from(JSON.stringify([
  'panter.segment-seal/v1',claim.segment,claim.firstSequence,claim.lastSequence,
  claim.lastHash,claim.previousSealHash,claim.contentSha256,claim.bytes,
]));}
function sealHash(receipt:any){return h(Buffer.concat([receiptPayload(receipt.claim),
  Buffer.from(receipt.signature,'base64url')]));}
function eventRow(segment:number,seq:number,previousHash:string){
  const event={requestId:randomUUID(),operation:'git.inspect',grantDigest:'a'.repeat(64),
    status:'RESERVED',outputDigest:'b'.repeat(64)};
  const hash=h(Buffer.from(JSON.stringify(['panter.segment-row/v1',segment,seq,previousHash,event])));
  return {segment,sequence:seq,previousHash,event,hash};
}
function input(segment:number,sequence:number,previousHash:string,previousSealHash:string){
  const row=eventRow(segment,sequence,previousHash);
  const raw=Buffer.from(JSON.stringify(row)+'\n');
  const claim={domain:'panter.segment-seal/v1',segment,firstSequence:sequence,lastSequence:sequence,
    lastHash:row.hash,previousSealHash,contentSha256:h(raw),bytes:raw.length};
  return {claim,segmentBase64:raw.toString('base64url')};
}
async function call(e:ReturnType<typeof env>,url:string,body?:unknown,key=token){
  return worker.fetch(new Request('https://sealer.example'+url,{
    method:body?'POST':'GET',headers:{authorization:'Bearer '+key,...(body?{'content-type':'application/json'}:{})},
    ...(body?{body:JSON.stringify(body)}:{}),
  }),e);
}
test('Cloudflare Worker signs and stores append-only manifest and segment, idempotent retry',async()=>{
  const e=env();const first=input(1,1,'0'.repeat(64),'0'.repeat(64));
  const res=await call(e,'/seal',first);
  assert.equal(res.status,200,await res.text());
  const one=(await (await call(e,'/seal/00000001')).json() as any).receipt;
  assert.equal(one.keyId,'external-1');
  assert.equal(verify(null,receiptPayload(one.claim),pair.publicKey,Buffer.from(one.signature,'base64url')),true);
  assert.equal((await call(e,'/seal',first)).status,200);
  const next=input(2,2,one.claim.lastHash,sealHash(one));
  assert.equal((await call(e,'/seal',next)).status,200);
  const last=(await (await call(e,'/seal/latest')).json() as any).receipt;
  assert.equal(last.claim.segment,2);
  assert.equal(e.SEAL_BUCKET.objects.size,4);
});
test('unauthorized, wrong sequence, conflicting immutable payload and forged receipt are rejected',async()=>{
  const e=env();const first=input(1,1,'0'.repeat(64),'0'.repeat(64));
  assert.equal((await call(e,'/seal',first,'invalid')).status,403);
  assert.equal((await call(e,'/seal',input(2,2,'0'.repeat(64),'0'.repeat(64)))).status,409);
  assert.equal((await call(e,'/seal',first)).status,200);
  const changed=input(1,1,'0'.repeat(64),'0'.repeat(64));
  assert.equal((await call(e,'/seal',changed)).status,409);
  const previous=JSON.parse(e.SEAL_BUCKET.objects.get('receipts/00000001.json')!);
  e.SEAL_BUCKET.objects.set('receipts/00000001.json',JSON.stringify({...previous,signature:'A'.repeat(86)}));
  assert.equal((await call(e,'/seal/latest')).status,409);
  assert.equal((await call(e,'/seal',input(2,2,previous.claim.lastHash,sealHash(previous)))).status,409);
});
test('crash after storing payload but before receipt is safe to retry without rewriting',async()=>{
  const e=env();const first=input(1,1,'0'.repeat(64),'0'.repeat(64));
  const raw=Buffer.from(first.segmentBase64,'base64url').toString('utf8');
  e.SEAL_BUCKET.objects.set('payloads/00000001.jsonl',raw);
  assert.equal((await call(e,'/seal',first)).status,200);
  assert.equal(e.SEAL_BUCKET.objects.get('payloads/00000001.jsonl'),raw);
  assert.equal(e.SEAL_BUCKET.objects.has('receipts/00000001.json'),true);
});
test('tampered row hashes or manifest digests cannot be sealed',async()=>{
  const e=env();const first=input(1,1,'0'.repeat(64),'0'.repeat(64));
  assert.equal((await call(e,'/seal',{...first,claim:{...first.claim,contentSha256:'f'.repeat(64)}})).status,409);
  const decoded=Buffer.from(first.segmentBase64,'base64url').toString('utf8');
  const payload=Buffer.from(decoded.replace('"RESERVED"','"SUCCEEDED"'));
  assert.equal((await call(e,'/seal',{...first,
    claim:{...first.claim,contentSha256:h(payload)},
    segmentBase64:payload.toString('base64url')})).status,409);
  assert.equal(e.SEAL_BUCKET.objects.size,0);
});
