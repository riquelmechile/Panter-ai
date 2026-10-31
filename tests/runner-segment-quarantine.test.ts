import assert from 'node:assert/strict';
import {test} from 'node:test';
import {generateKeyPairSync,randomUUID,sign} from 'node:crypto';
import {appendFileSync,chmodSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {quarantineActiveSegmentTail} from '../src/core/runner-segment-quarantine.js';
import {SegmentedRunnerAudit,SegmentIntegrityError,segmentSealPayload,
  type ExternalSealAuthority,type SignedSegmentSeal,type SegmentSealClaim,type SegmentedEvent} from '../src/core/runner-segments.js';

const pair=generateKeyPairSync('ed25519');
const pinned=new Map([['external',pair.publicKey]]);
class FakeAuthority implements ExternalSealAuthority{
  readonly receipts=new Map<number,SignedSegmentSeal>();
  latest():SignedSegmentSeal|null{return this.receipts.get(this.receipts.size)??null;}
  get(n:number):SignedSegmentSeal|null{return this.receipts.get(n)??null;}
  seal(claim:SegmentSealClaim):SignedSegmentSeal{
    const r={keyId:'external',claim,signature:sign(null,segmentSealPayload(claim),
      pair.privateKey).toString('base64url')};
    this.receipts.set(claim.segment,r);return r;
  }
}
function event():SegmentedEvent{return {requestId:randomUUID(),operation:'git.inspect',
  grantDigest:'a'.repeat(64),status:'RESERVED',outputDigest:'b'.repeat(64)};}
test('preserves truncated active tail and receipt idempotently without altering source or resuming',()=>{
  const dir=mkdtempSync(join(tmpdir(),'segment-tail-')),root=join(dir,'journal');
  try{
    const authority=new FakeAuthority();
    const j=new SegmentedRunnerAudit(root,authority,pinned,650);
    j.append(event());j.sealCurrent();j.append(event());
    const active=join(root,'segment-00000002.jsonl');
    const tail=Buffer.from('{"incomplete":"CANARY_DO_NOT_LOG');
    appendFileSync(active,tail);
    const before=readFileSync(active);
    assert.throws(()=>new SegmentedRunnerAudit(root,authority,pinned,650),SegmentIntegrityError);
    const evidence=quarantineActiveSegmentTail(root,authority.latest(),pinned);
    assert.equal(evidence.status,'OUTCOME_UNKNOWN');
    assert.equal(evidence.segment,2);
    assert.equal(evidence.prefixEntries,1);
    assert.equal(evidence.tailBytes,tail.length);
    assert.deepEqual(readFileSync(evidence.evidenceFile),tail);
    assert.deepEqual(readFileSync(active),before);
    assert.deepEqual(quarantineActiveSegmentTail(root,authority.latest(),pinned),evidence);
    assert.throws(()=>new SegmentedRunnerAudit(root,authority,pinned,650),SegmentIntegrityError);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('rejects tampered complete prefix, forged remote seal and modified evidence',()=>{
  const dir=mkdtempSync(join(tmpdir(),'segment-tail-failure-')),root=join(dir,'journal');
  try{
    const authority=new FakeAuthority();
    const j=new SegmentedRunnerAudit(root,authority,pinned,650);
    j.append(event());j.sealCurrent();j.append(event());
    const active=join(root,'segment-00000002.jsonl');
    const original=readFileSync(active);
    writeFileSync(active,Buffer.concat([Buffer.from(original.toString().replace('"RESERVED"','"SUCCEEDED"')),
      Buffer.from('{"partial":')]));
    assert.throws(()=>quarantineActiveSegmentTail(root,authority.latest(),pinned),SegmentIntegrityError);
    writeFileSync(active,Buffer.concat([original,Buffer.from('{"partial":')]));
    const last=authority.latest()!;
    const bad={...last,signature:last.signature.slice(0,-1)+(last.signature.endsWith('A')?'E':'A')};
    assert.throws(()=>quarantineActiveSegmentTail(root,bad,pinned),SegmentIntegrityError);
    const ok=quarantineActiveSegmentTail(root,last,pinned);
    chmodSync(ok.evidenceFile,0o600);
    writeFileSync(ok.evidenceFile,'damaged');
    chmodSync(ok.evidenceFile,0o400);
    assert.throws(()=>quarantineActiveSegmentTail(root,last,pinned),SegmentIntegrityError);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('empty active prefix with a crashed first write is capturable but not recoverable',()=>{
  const dir=mkdtempSync(join(tmpdir(),'segment-tail-first-')),root=join(dir,'journal');
  try{
    const a=new FakeAuthority();
    new SegmentedRunnerAudit(root,a,pinned,650);
    appendFileSync(join(root,'segment-00000001.jsonl'),'{');
    const q=quarantineActiveSegmentTail(root,null,pinned);
    assert.equal(q.prefixEntries,0);
    assert.equal(q.firstSequence,1);
    assert.equal(q.tailBytes,1);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
