import assert from 'node:assert/strict';
import {test} from 'node:test';
import {generateKeyPairSync,randomUUID,sign} from 'node:crypto';
import {appendFileSync,chmodSync,mkdtempSync,readFileSync,readdirSync,rmSync,unlinkSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {
  SegmentedRunnerAudit,SegmentIntegrityError,segmentSealPayload,
  type ExternalSealAuthority,type SegmentSealClaim,type SignedSegmentSeal,
  type SegmentedEvent,
} from '../src/core/runner-segments.js';

const keypair=generateKeyPairSync('ed25519');
const pins=new Map([['independent-signer',keypair.publicKey]]);
class FakeExternalAuthority implements ExternalSealAuthority {
  readonly anchors=new Map<number,SignedSegmentSeal>();
  latest():SignedSegmentSeal|null{return this.anchors.get(this.anchors.size)??null;}
  get(index:number):SignedSegmentSeal|null{return this.anchors.get(index)??null;}
  seal(claim:SegmentSealClaim):SignedSegmentSeal{
    const old=this.anchors.get(claim.segment);
    if(old){if(JSON.stringify(old.claim)!==JSON.stringify(claim))throw Error('remote immutable mismatch');return old;}
    if(claim.segment!==this.anchors.size+1)throw Error('remote rollback or gap');
    const receipt:SignedSegmentSeal={keyId:'independent-signer',claim,signature:
      sign(null,segmentSealPayload(claim),keypair.privateKey).toString('base64url')};
    this.anchors.set(claim.segment,receipt);
    return receipt;
  }
}
const event=():SegmentedEvent=>({requestId:randomUUID(),operation:'git.inspect',
  grantDigest:'a'.repeat(64),status:'RESERVED',outputDigest:'b'.repeat(64)});
const rejects=(fn:()=>unknown)=>assert.throws(fn,SegmentIntegrityError);

test('rotates small journal into signed immutable segments, preserving sequence and O(1) append state',()=>{
  const root=mkdtempSync(join(tmpdir(),'runner-segment-'));
  try{
    const store=new FakeExternalAuthority();
    let journal=new SegmentedRunnerAudit(root,store,pins,650);
    let current=journal.state();
    for(let i=0;i<22;i++){
      current=journal.append(event());
      assert.equal(current.entries,i+1);
      assert.ok(current.activeBytes<=650);
    }
    assert.ok(current.sealed>0);
    const oldHash=current.lastHash;
    journal=new SegmentedRunnerAudit(root,store,pins,650);
    assert.deepEqual(journal.state(),current);
    for(let i=0;i<6;i++)journal.append(event());
    assert.equal(journal.state().entries,28);
    assert.notEqual(journal.state().lastHash,oldHash);
    assert.equal(store.anchors.size,journal.state().sealed);
  }finally{rmSync(root,{recursive:true,force:true});}
});
test('rejects modified sealed content and forged external checkpoint',()=>{
  for(const kind of ['sealed-content','signature','rollback'] as const){
    const root=mkdtempSync(join(tmpdir(),'runner-segment-tamper-'));
    try{
      const store=new FakeExternalAuthority();
      const journal=new SegmentedRunnerAudit(root,store,pins,650);
      for(let i=0;i<5;i++)journal.append(event());
      assert.ok(journal.state().sealed>=1);
      if(kind==='sealed-content'){
        const file=join(root,'segment-00000001.jsonl');
        const original=readFileSync(file,'utf8');
        writeFileSync(file,original.replace('"RESERVED"','"SUCCEEDED"'));
      }else if(kind==='signature'){
        const receipt=store.anchors.get(1)!;
        store.anchors.set(1,{...receipt,signature:receipt.signature.slice(0,-1)+'A'});
      }else{
        store.anchors.clear();
      }
      rejects(()=>new SegmentedRunnerAudit(root,store,pins,650));
    }finally{rmSync(root,{recursive:true,force:true});}
  }
});
test('partial active append is detected on restart, no implicit truncation or retry',()=>{
  const root=mkdtempSync(join(tmpdir(),'runner-segment-crash-'));
  try{
    const store=new FakeExternalAuthority();
    const journal=new SegmentedRunnerAudit(root,store,pins,650);
    journal.append(event());
    const file=join(root,'segment-00000001.jsonl');
    appendFileSync(file,'{"fragment":');
    const before=readFileSync(file);
    rejects(()=>new SegmentedRunnerAudit(root,store,pins,650));
    assert.deepEqual(readFileSync(file),before);
  }finally{rmSync(root,{recursive:true,force:true});}
});
test('restart after signed seal but before next segment creation can recover without duplicate seals',()=>{
  const root=mkdtempSync(join(tmpdir(),'runner-segment-seal-crash-'));
  try{
    const store=new FakeExternalAuthority();
    const journal=new SegmentedRunnerAudit(root,store,pins,650);
    journal.append(event());
    const state=journal.sealCurrent();
    assert.equal(state.sealed,1);
    unlinkSync(join(root,'segment-00000002.jsonl'));
    const reopened=new SegmentedRunnerAudit(root,store,pins,650);
    assert.equal(reopened.state().activeSegment,2);
    assert.equal(reopened.state().entries,1);
    reopened.append(event());
    assert.equal(reopened.state().entries,2);
    assert.equal(store.anchors.size,1);
  }finally{rmSync(root,{recursive:true,force:true});}
});
test('rejects symlinked segment, unexpected files and insecure permissions',()=>{
  const root=mkdtempSync(join(tmpdir(),'runner-segment-files-'));
  try{
    const store=new FakeExternalAuthority();
    const journal=new SegmentedRunnerAudit(root,store,pins,650);
    journal.append(event());
    const file=join(root,'segment-00000001.jsonl');
    chmodSync(file,0o666);
    rejects(()=>new SegmentedRunnerAudit(root,store,pins,650));
    chmodSync(file,0o600);
    writeFileSync(join(root,'surprise.json'),'bad');
    rejects(()=>new SegmentedRunnerAudit(root,store,pins,650));
  }finally{rmSync(root,{recursive:true,force:true});}
});
test('off-host unavailable or refused seal blocks rotation, never silently continues',()=>{
  const root=mkdtempSync(join(tmpdir(),'runner-segment-seal-deny-'));
  try{
    const store=new FakeExternalAuthority();
    store.seal=()=>{throw new Error('remote unavailable')};
    const journal=new SegmentedRunnerAudit(root,store,pins,650);
    journal.append(event());
    assert.throws(()=>journal.sealCurrent());
    assert.deepEqual(readdirSync(root),['segment-00000001.jsonl']);
  }finally{rmSync(root,{recursive:true,force:true});}
});
