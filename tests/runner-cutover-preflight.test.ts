import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash,generateKeyPairSync,randomUUID,sign} from 'node:crypto';
import {appendFileSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {RunnerAuditJournal} from '../src/core/runner-journal.js';
import {RunnerOutcomeLedger,type OutcomeIntent,OutcomeRejected} from '../src/core/runner-outcomes.js';
import {stageLegacyAuditCutover} from '../src/core/runner-audit-cutover.js';
import {inspectLegacyCutoverEvidence} from '../src/core/runner-cutover-preflight.js';
import {SegmentIntegrityError,segmentSealPayload,segmentSealDigest,
  type SegmentSealClaim,type SignedSegmentSeal} from '../src/core/runner-segments.js';
import type {AsyncSealAuthority} from '../src/core/runner-seal-http.js';

const pair=generateKeyPairSync('ed25519');
const pinned=new Map([['offline-test',pair.publicKey]]);
const event=()=>({requestId:randomUUID(),operation:'git.inspect' as const,
  grantDigest:'a'.repeat(64),status:'RESERVED' as const,outputDigest:'b'.repeat(64)});
const intent=():OutcomeIntent=>({operationId:randomUUID(),subject:'gpt-a',
  repository:'riquelmechile/Panter-ai',candidateSha:'c'.repeat(40),
  missionId:'mission-1',workId:'work-1',attemptId:'attempt-1',
  leaseGeneration:1,operation:'git.inspect',grantDigest:'a'.repeat(64)});
class FakeRemote implements AsyncSealAuthority{
  readonly seals=new Map<number,SignedSegmentSeal>();
  async latest(){return this.seals.get(this.seals.size)??null;}
  async get(n:number){return this.seals.get(n)??null;}
  async seal(claim:SegmentSealClaim,payload:Buffer){
    assert.equal(payload.length,claim.bytes);
    const existing=this.seals.get(claim.segment);
    if(existing)return existing;
    const previous=this.seals.get(this.seals.size);
    assert.equal(claim.previousSealHash,previous?segmentSealDigest(previous):'0'.repeat(64));
    const signed={keyId:'offline-test',claim,
      signature:sign(null,segmentSealPayload(claim),pair.privateKey).toString('base64url')};
    this.seals.set(claim.segment,signed);return signed;
  }
}
async function fixture(){
  const tmp=mkdtempSync(join(tmpdir(),'runner-cutover-readonly-'));
  const root=join(tmp,'runner'),legacy=join(tmp,'legacy'),staging=join(tmp,'staging');
  const ledger=new RunnerOutcomeLedger(join(root,'outcomes'));ledger.close();
  const old=new RunnerAuditJournal(legacy);
  old.append(event());old.append(event());
  const remote=new FakeRemote();
  const receipt=await stageLegacyAuditCutover(legacy,staging,remote,pinned,650);
  return {tmp,root,legacy,staging,old,remote,receipt};
}
test('preflight reads all sealed evidence and empty outcomes without mutating source',async()=>{
  const x=await fixture();
  try{
    const original=readFileSync(x.old.path);
    const result=await inspectLegacyCutoverEvidence(x.root,x.legacy,x.staging,x.remote,pinned);
    assert.equal(result.status,'EVIDENCE_CONSISTENT_NOT_AUTHORIZED');
    assert.equal(result.permitsCutover,false);
    assert.equal(result.requiresWriterFreeze,true);
    assert.equal(result.terminalOutcomes,0);
    assert.equal(result.entries,2);
    assert.equal(result.legacySha256,x.receipt.legacySha256);
    assert.deepEqual(readFileSync(x.old.path),original);
    assert.deepEqual(await inspectLegacyCutoverEvidence(x.root,x.legacy,x.staging,x.remote,pinned),result);
  }finally{rmSync(x.tmp,{recursive:true,force:true});}
});
test('any pending or uncertain outcome blocks preflight, readonly query preserves writer epoch',async()=>{
  const x=await fixture();
  try{
    const db=new RunnerOutcomeLedger(join(x.root,'outcomes')),item=intent();
    db.prepare(item);
    await assert.rejects(()=>inspectLegacyCutoverEvidence(x.root,x.legacy,x.staging,x.remote,pinned),SegmentIntegrityError);
    assert.equal(db.get(item.operationId)?.state,'INTENT');
    db.close();
  }finally{rmSync(x.tmp,{recursive:true,force:true});}
});
test('tampered staging manifest, signed anchor or sealed JSONL blocks without repairing',async()=>{
  const x=await fixture();
  try{
    const file=join(x.staging,'cutover-staging-'+x.receipt.legacySha256+'.json');
    const original=readFileSync(file);
    writeFileSync(file,Buffer.from(original.toString().replace('"legacyBytes":', '"legacyBytes":9999,"bogus":')),{mode:0o400});
    await assert.rejects(()=>inspectLegacyCutoverEvidence(x.root,x.legacy,x.staging,x.remote,pinned),SegmentIntegrityError);
    writeFileSync(file,original,{mode:0o400});
    const record=x.remote.seals.get(1)!;
    x.remote.seals.set(1,{...record,signature:record.signature.slice(0,-1)+(record.signature.endsWith('A')?'E':'A')});
    await assert.rejects(()=>inspectLegacyCutoverEvidence(x.root,x.legacy,x.staging,x.remote,pinned),SegmentIntegrityError);
    x.remote.seals.set(1,record);
    appendFileSync(join(x.staging,'segments','segment-00000001.jsonl'),'{}\n');
    await assert.rejects(()=>inspectLegacyCutoverEvidence(x.root,x.legacy,x.staging,x.remote,pinned),SegmentIntegrityError);
  }finally{rmSync(x.tmp,{recursive:true,force:true});}
});
test('unknown outcomes storage and unsealed active data never allow preflight',async()=>{
  const x=await fixture();
  try{
    appendFileSync(join(x.staging,'segments','segment-00000002.jsonl'),'{"partial":');
    await assert.rejects(()=>inspectLegacyCutoverEvidence(x.root,x.legacy,x.staging,x.remote,pinned),SegmentIntegrityError);
    rmSync(join(x.root,'outcomes'),{recursive:true,force:true});
    await assert.rejects(()=>inspectLegacyCutoverEvidence(x.root,x.legacy,x.staging,x.remote,pinned));
  }finally{rmSync(x.tmp,{recursive:true,force:true});}
});
