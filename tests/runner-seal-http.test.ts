import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash,generateKeyPairSync,randomUUID} from 'node:crypto';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {AsyncSegmentedRunnerAudit,HttpSegmentSealAuthority} from '../src/core/runner-seal-http.js';
import {SegmentIntegrityError,type SegmentedEvent} from '../src/core/runner-segments.js';
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
