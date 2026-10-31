import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash,generateKeyPairSync,randomUUID,sign} from 'node:crypto';
import {appendFileSync,mkdtempSync,readFileSync,rmSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {AsyncSegmentedRunnerAudit,HttpSegmentSealAuthority} from '../src/core/runner-seal-http.js';
import {SegmentIntegrityError,segmentSealPayload,type SegmentedEvent} from '../src/core/runner-segments.js';
// @ts-expect-error Separate Cloudflare JavaScript Worker has no local TS declaration.
import worker from '../src/runner/seal-worker.mjs';

const pair=generateKeyPairSync('ed25519');
const TOKEN='test-only-independent-worker-bearer-000000000';
const pins=new Map([['test-external',pair.publicKey]]);
class FakeR2 {
  readonly objects=new Map<string,string>();
  async put(key:string,value:string,opts?:{onlyIf?:Headers}){
    if(opts?.onlyIf?.get('If-None-Match')==='*'&&this.objects.has(key))return null;
    this.objects.set(key,value);return {key};
  }
  async get(key:string){
    const v=this.objects.get(key);
    return v===undefined?null:{text:async()=>v,json:async()=>JSON.parse(v)};
  }
  async list(args:{prefix:string}){
    return {objects:[...this.objects.keys()].filter(k=>k.startsWith(args.prefix)).map(key=>({key})),truncated:false};
  }
}
function service(bucket=new FakeR2()){
  const env={SEAL_BUCKET:bucket,SEAL_KEY_ID:'test-external',
    SEAL_BEARER_TOKEN:TOKEN,SEAL_PRIVATE_KEY_PKCS8_B64:pair.privateKey.export({format:'der',type:'pkcs8'}).toString('base64'),
    SEAL_PUBLIC_KEY_SPKI_B64:pair.publicKey.export({format:'der',type:'spki'}).toString('base64')};
  const send=(request:Request):Promise<Response>=>worker.fetch(request,env);
  const remote=new HttpSegmentSealAuthority('https://worker.test/',TOKEN,send);
  return {bucket,send,remote};
}
const event=():SegmentedEvent=>({
  requestId:randomUUID(),operation:'git.inspect',grantDigest:'a'.repeat(64),
  status:'RESERVED',outputDigest:'b'.repeat(64),
});
test('async HTTP bridge seals full JSONL bytes, verifies signatures and reopens continuous chain',async()=>{
  const root=mkdtempSync(join(tmpdir(),'runner-http-bridge-'));
  try{
    const {bucket,remote}=service();
    let journal=await AsyncSegmentedRunnerAudit.open(root,remote,pins,650);
    for(let i=0;i<12;i++)await journal.append(event()); // automatic remote seals
    await journal.sealCurrent();
    const state=journal.state();
    assert.ok(state.sealed>1);
    assert.equal(state.entries,12);
    assert.equal(bucket.objects.size,state.sealed*2);
    journal=await AsyncSegmentedRunnerAudit.open(root,remote,pins,650);
    assert.deepEqual(journal.state(),state);
    await journal.append(event());
    assert.equal(journal.state().entries,13);
  }finally{rmSync(root,{recursive:true,force:true});}
});
test('lost response after R2 receipt: startup reads remote seal and recovers active segment safely',async()=>{
  const root=mkdtempSync(join(tmpdir(),'runner-http-ambiguous-'));
  try{
    const {send,remote,bucket}=service();
    const journal=await AsyncSegmentedRunnerAudit.open(root,remote,pins,650);
    await journal.append(event());
    const first=readFileSync(join(root,'segment-00000001.jsonl'));
    let drop=true;
    const flaky=new HttpSegmentSealAuthority('https://worker.test/',TOKEN,async(request)=>{
      const response=await send(request);
      if(drop&&request.method==='POST'){drop=false;throw new Error('ambiguous network loss');}
      return response;
    });
    // New caller reads same local journal; do not use it concurrently with the old one.
    const signer=await AsyncSegmentedRunnerAudit.open(root,flaky,pins,650);
    await assert.rejects(()=>signer.sealCurrent(),SegmentIntegrityError);
    assert.deepEqual(readFileSync(join(root,'segment-00000001.jsonl')),first);
    assert.equal(bucket.objects.has('receipts/00000001.json'),true);
    const recovered=await AsyncSegmentedRunnerAudit.open(root,remote,pins,650);
    assert.equal(recovered.state().sealed,1);
    assert.equal(recovered.state().activeSegment,2);
    assert.equal(recovered.state().entries,1);
    await recovered.append(event());
    assert.equal(recovered.state().entries,2);
  }finally{rmSync(root,{recursive:true,force:true});}
});
test('bad Worker signature, failed authentication and tampered sealed bytes fail closed',async()=>{
  const root=mkdtempSync(join(tmpdir(),'runner-http-fail-'));
  try{
    const {bucket,remote,send}=service();
    const journal=await AsyncSegmentedRunnerAudit.open(root,remote,pins,650);
    await journal.append(event());
    await journal.sealCurrent();
    const wrong=new HttpSegmentSealAuthority('https://worker.test/','wrong-auth-bearer-test-000000000000000',send);
    await assert.rejects(()=>AsyncSegmentedRunnerAudit.open(root,wrong,pins,650),SegmentIntegrityError);
    const key='receipts/00000001.json';
    const old=JSON.parse(bucket.objects.get(key)!);
    const last=old.signature.slice(-1);
    bucket.objects.set(key,JSON.stringify({...old,signature:old.signature.slice(0,-1)+(last==='A'?'E':'A')}));
    await assert.rejects(()=>AsyncSegmentedRunnerAudit.open(root,remote,pins,650),SegmentIntegrityError);
  }finally{rmSync(root,{recursive:true,force:true});}
});
test('HTTP bridge denies non-HTTPS or URL with embedded credentials before network',()=>{
  assert.throws(()=>new HttpSegmentSealAuthority('http://worker.test/',TOKEN),SegmentIntegrityError);
  assert.throws(()=>new HttpSegmentSealAuthority('https://evil:pass@worker.test/',TOKEN),SegmentIntegrityError);
  assert.throws(()=>new HttpSegmentSealAuthority('https://worker.test/?secret=x',TOKEN),SegmentIntegrityError);
});

test('forged Worker seal response never poisons in-memory cache; later genuine retry succeeds',async()=>{
  const root=mkdtempSync(join(tmpdir(),'runner-http-poison-retry-'));
  try{
    const {send,remote}=service();
    const journal=await AsyncSegmentedRunnerAudit.open(root,remote,pins,650);
    await journal.append(event());
    let tamper=true;
    const flaky=new HttpSegmentSealAuthority('https://worker.test/',TOKEN,async req=>{
      const response=await send(req);
      if(tamper&&req.method==='POST'&&response.status===200){
        tamper=false;
        const data=await response.json() as {receipt:{signature:string}};
        const signature=data.receipt.signature;
        data.receipt.signature=signature.slice(0,-1)+(signature.endsWith('A')?'E':'A');
        return Response.json(data);
      }
      return response;
    });
    // The original journal is no longer used; local-only exclusive serialization.
    const active=await AsyncSegmentedRunnerAudit.open(root,flaky,pins,650);
    await assert.rejects(()=>active.sealCurrent(),SegmentIntegrityError);
    assert.equal(active.state().sealed,0);
    // Worker already persisted a real seal; retry same bytes, same instance.
    assert.equal((await active.sealCurrent()).sealed,1);
    assert.equal(active.state().activeSegment,2);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('signed but wrong segment claim cannot poison cache; valid retry seals normally',async()=>{
  const root=mkdtempSync(join(tmpdir(),'runner-http-wrong-claim-'));
  try{
    const {send,remote}=service();
    const initial=await AsyncSegmentedRunnerAudit.open(root,remote,pins,650);
    await initial.append(event());
    let rewrite=true;
    const faulty=new HttpSegmentSealAuthority('https://worker.test/',TOKEN,async request=>{
      const response=await send(request);
      if(rewrite&&request.method==='POST'&&response.status===200){
        rewrite=false;
        const raw=await response.json() as {receipt:{
          keyId:string;claim:any;signature:string
        }};
        const claim={...raw.receipt.claim,bytes:raw.receipt.claim.bytes+1};
        raw.receipt={...raw.receipt,claim,
          signature:sign(null,segmentSealPayload(claim),pair.privateKey).toString('base64url')};
        return Response.json(raw);
      }
      return response;
    });
    const active=await AsyncSegmentedRunnerAudit.open(root,faulty,pins,650);
    await assert.rejects(()=>active.sealCurrent(),SegmentIntegrityError);
    assert.equal(active.state().activeSegment,1);
    assert.equal(active.state().sealed,0);
    assert.equal((await active.sealCurrent()).sealed,1);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('verified local checkpoint replaces repeated remote GET scan, and tampering fails closed',async()=>{
  const root=mkdtempSync(join(tmpdir(),'runner-http-checkpoint-'));
  try{
    const {remote,bucket}=service();
    const first=await AsyncSegmentedRunnerAudit.open(root,remote,pins,650);
    for(let i=0;i<12;i++)await first.append(event());
    await first.sealCurrent();
    const checkpoint=join(root,'seal-checkpoint.json');
    assert.ok(JSON.parse(readFileSync(checkpoint,'utf8')).receipts.length>2);
    let reads=0;
    const counted={latest:()=>remote.latest(),get:(n:number)=>{reads++;return remote.get(n);},
      seal:(claim:any,payload:Buffer)=>remote.seal(claim,payload)};
    const second=await AsyncSegmentedRunnerAudit.open(root,counted,pins,650);
    assert.equal(reads,0,'cached receipts must be independently reverified against signed latest');
    assert.equal(second.state().entries,12);
    const bytes=readFileSync(checkpoint);
    const corrupted=Buffer.from(bytes.toString().replace('"keyId":"test-external"','"keyId":"evil"'));
    assert.notDeepEqual(corrupted,bytes);
    unlinkSync(checkpoint);
    appendFileSync(checkpoint,corrupted,{mode:0o600});
    await assert.rejects(()=>AsyncSegmentedRunnerAudit.open(root,remote,pins,650),SegmentIntegrityError);
    unlinkSync(checkpoint);
    reads=0;
    const recovered=await AsyncSegmentedRunnerAudit.open(root,counted,pins,650);
    assert.ok(reads>0,'missing checkpoint should refetch history');
    assert.equal(recovered.state().entries,12);
  }finally{rmSync(root,{recursive:true,force:true});}
});
