import assert from 'node:assert/strict';
import {test} from 'node:test';
import {planHostNative,nativePacket} from '../src/core/native-fallback.js';
import {assessMeshReview,NativeReviewBridge} from '../src/core/native-review.js';
import type {FlowSignals} from '../src/core/agents.js';
const sha='a'.repeat(40);
const high:FlowSignals={requirementsClear:true,resumableFromDiff:false,risk:'high',unknownCodeArea:false,independentWorkUnits:3,writesAuthorized:true};
const low:FlowSignals={requirementsClear:true,resumableFromDiff:true,risk:'low',unknownCodeArea:false,independentWorkUnits:1,writesAuthorized:true};
const task=(agentId='gentle-ai-explore')=>({agentId,objective:'Inspect scoped code',candidateSha:agentId.startsWith('review-')?sha:undefined});
const base={bindings:[],peerStates:{},capabilities:{nativeSubagents:false,maxParallelSubagents:0,toolsAvailable:true,evidence:'HOST_REPORTED_UNVERIFIED' as const}};

test('GPT-A continues all ODD phases inline with zero connected model workers',()=>{
  const p=planHostNative({...base,signals:high,assignments:[task(),task('gentle-ai-verify'),task('review-risk')]});
  assert.equal(p.assignments.length,3);
  assert.ok(p.assignments.every(x=>x.execution==='GPT_A_INLINE'&&x.host==='gpt-a'));
  assert.equal(p.serverWorkersStarted,0);assert.equal(p.requestedSubagentSlots,0);
  assert.match(p.instructions,/No.*claim independent review/i);
});
test('Host-reported native subagents may be requested for independent work but are not started',()=>{
  const p=planHostNative({...base,signals:high,assignments:[task(),task('gentle-ai-verify'),task('review-risk')],capabilities:{...base.capabilities,nativeSubagents:true,maxParallelSubagents:2}});
  assert.equal(p.requestedSubagentSlots,2);
  assert.deepEqual(p.assignments.map(x=>x.concurrentGroup),[0,1,0]);
  assert.ok(p.assignments.every(x=>x.execution==='GPT_A_NATIVE_SUBAGENT'));
  assert.equal(p.serverWorkersStarted,0);
});
test('Small task remains inline even if native concurrency exists',()=>{
  const p=planHostNative({...base,signals:low,assignments:[task()],capabilities:{...base.capabilities,nativeSubagents:true,maxParallelSubagents:16}});
  assert.equal(p.assignments[0]?.execution,'GPT_A_INLINE');
});
test('Remote host must be explicitly connected; unknown never qualifies',()=>{
  const bindings=[{agentId:'gentle-ai-explore',host:'claude' as const,modelRequest:'model',effortRequest:'high',skillIds:['gentle-ai' as const],revision:1}];
  const p=planHostNative({...base,bindings,signals:high,assignments:[task()],peerStates:{claude:'UNKNOWN'}});
  assert.equal(p.assignments[0]?.execution,'GPT_A_INLINE');
  const q=planHostNative({...base,bindings,signals:high,assignments:[task()],peerStates:{claude:'CONNECTED'}});
  assert.equal(q.assignments[0]?.execution,'REMOTE_A2A');
});
test('No write authorization blocks remote and local implementation',()=>{
  const p=planHostNative({...base,signals:{...high,writesAuthorized:false},assignments:[{agentId:'gentle-ai-worker',objective:'Change source'}]});
  assert.equal(p.assignments[0]?.execution,'BLOCKED_AUTHORIZATION');
});
test('Host-native packet loads MCP-hosted skills even without remote specialist binding',async()=>{
  const p=await nativePacket({agentId:'gentle-ai-explore',objective:'Explore codebase'});
  assert.equal(p.executionOwner,'gpt-a');
  assert.equal(p.skillIds[0],'gentle-ai');
  assert.match(p.instruction,/MCP-delivered skill packet/);
  await assert.rejects(nativePacket({agentId:'review-risk',objective:'Review a candidate'}),/frozen candidate SHA/);
});
test('Invalid concurrency report fails closed',()=>{
  assert.throws(()=>planHostNative({...base,signals:high,assignments:[task()],capabilities:{...base.capabilities,maxParallelSubagents:40}}),/Invalid host-native worker count/);
});
test('Unavailable official native RDD never reports approval',async()=>{
  const a=await NativeReviewBridge.open({enabled:false,binary:'gentle-ai',repositoryRoot:''});
  const r=await a.status();
  assert.equal(r.authoritative,false);assert.equal(r.available,false);
});
test('Review aggregate rejects unstructured or candidate-mismatched model output',()=>{
  const incomplete=assessMeshReview({kind:'judgment-day',candidateSha:sha,work:[
    {agentId:'jd-judge-a',host:'claude',state:'COMPLETED',receiptDigest:'b'.repeat(64),result:'APPROVED'},
    {agentId:'jd-judge-b',host:'grok',state:'COMPLETED',receiptDigest:'c'.repeat(64),result:JSON.stringify({agentId:'jd-judge-b',candidateSha:'d'.repeat(40),findings:[]})}
  ]});
  assert.equal(incomplete.approved,false);
  assert.equal(incomplete.status,'EVIDENCE_INCOMPLETE');
});
test('Even structured SHA-bound 4R reports do not claim native approval',()=>{
  const agents=['review-risk','review-readability','review-reliability','review-resilience'];
  const reports=agents.map((agentId,i)=>({agentId,host:['gpt-b','grok','gemini','claude'][i]!,state:'COMPLETED',receiptDigest:'e'.repeat(64),result:JSON.stringify({agentId,candidateSha:sha,findings:[{severity:'WARNING',location:'src/file.ts:2',proofRefs:['changed-hunk:src/file.ts:2']}]})}));
  const out=assessMeshReview({kind:'4r',candidateSha:sha,work:reports});
  assert.equal(out.status,'EVIDENCE_COLLECTED_UNVERIFIED');
  assert.equal(out.approved,false);assert.equal(out.nativeAuthority,false);
});

test('Parallel native writers with overlapping allowed scopes cannot be scheduled',()=>{
  const assignments=[{agentId:'gentle-ai-worker',objective:'Implement A',allowedEditSurfaces:['src/core']},{agentId:'jd-fix-agent',objective:'Fix B',allowedEditSurfaces:['src/core/file.ts']}];
  assert.throws(()=>planHostNative({...base,signals:high,assignments,capabilities:{...base.capabilities,nativeSubagents:true,maxParallelSubagents:2}}),/Overlapping native writer scopes/);
});
test('GPT-A with no tools and no peers reports a blocked capability rather than claiming work',()=>{
  const p=planHostNative({...base,signals:low,assignments:[task()],capabilities:{...base.capabilities,toolsAvailable:false}});
  assert.equal(p.assignments[0]?.execution,'BLOCKED_TOOLS');
});
