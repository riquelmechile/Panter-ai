import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash,generateKeyPairSync,randomUUID,sign} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {AsyncSegmentedRunnerAudit,type AsyncSealAuthority} from '../src/core/runner-seal-http.js';
import {RunnerAuditSealBatcher} from '../src/core/runner-seal-batch.js';
import {segmentSealPayload,SegmentIntegrityError,type SegmentSealClaim,type SignedSegmentSeal,
  type SegmentedEvent} from '../src/core/runner-segments.js';

const keys=generateKeyPairSync('ed25519'),pins=new Map([['external',keys.publicKey]]);
class Remote implements AsyncSealAuthority {
  readonly seals:SignedSegmentSeal[]=[];
  fail=false;
  async latest(){return this.seals.at(-1)??null;}
  async get(i:number){return this.seals[i-1]??null;}
  async seal(claim:SegmentSealClaim,payload:Buffer):Promise<SignedSegmentSeal>{
    if(this.fail)throw Error('network uncertain');
    assert.equal(createHash('sha256').update(payload).digest('hex'),claim.contentSha256);
    const old=this.seals[claim.segment-1];
    if(old)return old;
    const out={keyId:'external',claim,signature:sign(null,segmentSealPayload(claim),
      keys.privateKey).toString('base64url')};
    this.seals.push(out);return out;
  }
}
function event():SegmentedEvent{return {requestId:randomUUID(),operation:'git.inspect',
  grantDigest:'a'.repeat(64),status:'RESERVED',outputDigest:'0'.repeat(64)};}
test('three concurrent admissions receive one remote seal and none resolves prematurely',async()=>{
  const root=mkdtempSync(join(tmpdir(),'runner-seal-batch-'));
  try{
    const remote=new Remote();
    const journal=await AsyncSegmentedRunnerAudit.open(root,remote,pins,2048);
    const batch=new RunnerAuditSealBatcher(journal,{maxEvents:3,maxDelayMs:3000});
    let resolved=0;
    const one=batch.appendAndSeal(event()).then(()=>{resolved++;});
    const two=batch.appendAndSeal(event()).then(()=>{resolved++;});
    await new Promise(r=>setTimeout(r,40));
    assert.equal(resolved,0);
    assert.equal(remote.seals.length,0);
    const three=batch.appendAndSeal(event()).then(()=>{resolved++;});
    await Promise.all([one,two,three]);
    assert.equal(resolved,3);
    assert.equal(remote.seals.length,1);
    assert.equal(journal.state().entries,3);
    assert.equal(journal.state().activeBytes,0);
    batch.close();
  }finally{rmSync(root,{recursive:true,force:true});}
});
test('time threshold seals singleton without waiting for another admission',async()=>{
  const root=mkdtempSync(join(tmpdir(),'runner-seal-time-'));
  try{
    const remote=new Remote(),journal=await AsyncSegmentedRunnerAudit.open(root,remote,pins,2048);
    const batch=new RunnerAuditSealBatcher(journal,{maxEvents:8,maxDelayMs:35});
    await batch.appendAndSeal(event());
    assert.equal(remote.seals.length,1);
    assert.equal(journal.state().sealed,1);
    batch.close();
  }finally{rmSync(root,{recursive:true,force:true});}
});
test('remote failure rejects all pending, poisons instance and never falsely seals',async()=>{
  const root=mkdtempSync(join(tmpdir(),'runner-seal-failclosed-'));
  try{
    const remote=new Remote(),journal=await AsyncSegmentedRunnerAudit.open(root,remote,pins,2048);
    const batch=new RunnerAuditSealBatcher(journal,{maxEvents:3,maxDelayMs:3000});
    remote.fail=true;
    const values=await Promise.allSettled([batch.appendAndSeal(event()),
      batch.appendAndSeal(event()),batch.appendAndSeal(event())]);
    assert.deepEqual(values.map(x=>x.status),['rejected','rejected','rejected']);
    await assert.rejects(()=>batch.appendAndSeal(event()),SegmentIntegrityError);
    assert.equal(remote.seals.length,0);
    assert.equal(journal.state().sealed,0);
    batch.close();
  }finally{rmSync(root,{recursive:true,force:true});}
});
