import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeSubagentReview } from '../src/core/native-review-workflow.js';
const sha='a'.repeat(40);
const finding={id:'RISK-001',location:'src/core/server.ts:15',severity:'CRITICAL' as const,claim:'Auth gap',proofRefs:['changed-hunk:src/core/server.ts:15']};
const input={missionId:'m1',kind:'4r' as const,objective:'Review the exact candidate',candidateSha:sha,idempotencyKey:'review-1'};
async function fixture(fn:(engine:NativeSubagentReview,dir:string)=>Promise<void>){const dir=await mkdtemp(join(tmpdir(),'panter-review-'));try{await fn(await NativeSubagentReview.open(dir),dir)}finally{await rm(dir,{recursive:true,force:true})}}

test('Four independent 4R slots carry frozen centrally hosted skills and requested max model',()=>fixture(async engine=>{
 const result=await engine.create(input);
 assert.equal(result.slots.length,4);
 assert.deepEqual(result.slots.map(s=>s.agentId),['review-risk','review-readability','review-reliability','review-resilience']);
 assert.equal(result.stage,'AWAITING_SUBAGENT_REPORTS');
 const packet=await engine.packet(result.reviewId,result.slots[0]!.slotId);
 assert.equal(packet.candidateSha,sha);assert.equal(packet.packetDigest,undefined); // response uses `digest`
 assert.equal(packet.digest,result.slots[0]!.packetDigest);
 assert.equal(packet.capacityRequest.reasoning,'max');
 assert.match(packet.instruction,/Specialist definition \(review-risk\)/);
 assert.equal(packet.launchPerformed,false);assert.equal(packet.execution,'HOST_NATIVE_SUBAGENT_REQUESTED');
 assert.equal(result.approved,false);
}));

test('Distinct native subagent reports can close evidence collection, never native RDD authority',()=>fixture(async engine=>{
 const review=await engine.create(input);
 for(let i=0;i<review.slots.length;i++){
  const slot=review.slots[i]!;
  const p=await engine.packet(review.reviewId,slot.slotId);
  const report={agentId:slot.agentId,candidateSha:sha,packetDigest:p.digest,subagentRunId:`native-child-${i+100}`,evidence:['Reviewed frozen source lines 1-30 and compared candidate'],findings:i===0?[finding]:[]};
  const r=await engine.submit(review.reviewId,slot.slotId,report);
  assert.equal(r.idempotent,false);
  const retry=await engine.submit(review.reviewId,slot.slotId,report);
  assert.equal(retry.idempotent,true);assert.equal(r.receiptDigest,retry.receiptDigest);
 }
 const final=await engine.status(review.reviewId);
 assert.equal(final.stage,'FINDINGS_REQUIRE_TRIAGE');
 assert.equal(final.severeFindings.length,1);
 assert.equal(final.approved,false);assert.equal(final.nativeRddAuthority,false);
 assert.equal(final.independentNativeRunsAttested,false);
 assert.equal(final.reportedSubagentRuns.length,4);
}));

test('Judgment Day only creates two blind judge packets; no fix before frozen triage',()=>fixture(async engine=>{
 const review=await engine.create({...input,kind:'judgment-day',idempotencyKey:'jd-1'});
 assert.deepEqual(review.slots.map(s=>s.agentId),['jd-judge-a','jd-judge-b']);
 const a=await engine.packet(review.reviewId,review.slots[0]!.slotId);
 assert.match(a.instruction,/judgment-day/);
 assert.equal(a.skillIds[0],'judgment-day');
 assert.ok(!a.instruction.includes('native-child-111'));
 const b=await engine.packet(review.reviewId,review.slots[1]!.slotId);
 assert.notEqual(a.digest,b.digest);
 assert.ok(!b.instruction.includes('native-child-111'));
}));

test('Tampered SHA and packet digest are rejected without consuming slot',()=>fixture(async engine=>{
 const review=await engine.create(input);const slot=review.slots[0]!;
 const report={agentId:slot.agentId,candidateSha:'b'.repeat(40),packetDigest:slot.packetDigest,subagentRunId:'native-test-0001',evidence:['Verified candidate'],findings:[]};
 await assert.rejects(engine.submit(review.reviewId,slot.slotId,report),/Mismatched frozen/);
 await assert.rejects(engine.submit(review.reviewId,slot.slotId,{...report,candidateSha:sha,packetDigest:'f'.repeat(64)}),/Mismatched frozen/);
 assert.equal((await engine.status(review.reviewId)).missing.length,4);
}));

test('One run cannot impersonate two separate reviewers; conflicting replay is blocked',()=>fixture(async engine=>{
 const review=await engine.create(input);const a=review.slots[0]!,b=review.slots[1]!;
 const r={agentId:a.agentId,candidateSha:sha,packetDigest:a.packetDigest,subagentRunId:'native-run-001',evidence:['Checked code'],findings:[]};
 await engine.submit(review.reviewId,a.slotId,r);
 await assert.rejects(engine.submit(review.reviewId,b.slotId,{...r,agentId:b.agentId,packetDigest:b.packetDigest}),/run ID reused/);
 await assert.rejects(engine.submit(review.reviewId,a.slotId,{...r,evidence:['Different']}),/Conflicting immutable/);
}));

test('Review survives restart; duplicate keys are idempotent and conflicts fail',()=>fixture(async(engine,dir)=>{
 const first=await engine.create(input);
 const again=await engine.create(input);assert.equal(first.reviewId,again.reviewId);
 await assert.rejects(engine.create({...input,candidateSha:'c'.repeat(40)}),/idempotency conflict/);
 const other=await NativeSubagentReview.open(dir);
 assert.equal((await other.status(first.reviewId)).slots.length,4);
}));

test('No clean approval without concrete evidence and independent reported runs',()=>fixture(async engine=>{
 const review=await engine.create(input);const slot=review.slots[0]!;
 assert.throws(()=>engine.submit(review.reviewId,slot.slotId,{agentId:slot.agentId,candidateSha:sha,packetDigest:slot.packetDigest,subagentRunId:'gpt-a',evidence:['note'],findings:[]}),/Unique native subagent/);
 assert.throws(()=>engine.submit(review.reviewId,slot.slotId,{agentId:slot.agentId,candidateSha:sha,packetDigest:slot.packetDigest,subagentRunId:'subagent-001',evidence:[],findings:[]}),/Concrete evidence/);
 assert.throws(()=>engine.submit(review.reviewId,slot.slotId,{agentId:slot.agentId,candidateSha:sha,packetDigest:slot.packetDigest,subagentRunId:'subagent-001',evidence:['note'],findings:[{...finding,proofRefs:[]}]}),/proof references/);
}));

test('Concurrent start with same key makes exactly one durable review',()=>fixture(async engine=>{
 const results=await Promise.all(Array.from({length:4},()=>engine.create(input)));
 assert.equal(new Set(results.map(x=>x.reviewId)).size,1);
}));

test('Batch prepares all independent native reviewer packets at observed capacity without launching models',()=>fixture(async engine=>{
 const review=await engine.create(input);
 const batch=await engine.batch(review.reviewId,3);
 assert.equal(batch.dispatch,'READY_FOR_HOST_NATIVE_DISPATCH');
 assert.equal(batch.packets.length,4);assert.equal(batch.concurrentSlots,3);
 assert.equal(batch.modelsStartedByMcp,0);assert.equal(batch.requestedReasoning,'max');
 assert.notEqual(batch.packets[0]!.digest,batch.packets[1]!.digest);
 const unavailable=await engine.batch(review.reviewId,0);
 assert.equal(unavailable.dispatch,'HOST_NATIVE_SUBAGENTS_UNAVAILABLE');assert.equal(unavailable.concurrentSlots,0);
 await assert.rejects(engine.batch(review.reviewId,33),/Invalid observed native parallelism/);
}));
