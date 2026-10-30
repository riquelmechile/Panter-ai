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

test('Durable GPT-A ODD run resumes after restart, but self execution cannot approve high-risk review', async()=>{
  const { mkdtemp,rm } = await import('node:fs/promises');
  const {tmpdir}=await import('node:os');
  const {join}=await import('node:path');
  const {AgentEngine}=await import('../src/core/agents.js');
  const {PanterStore}=await import('../src/core/store.js');
  const dir=await mkdtemp(join(tmpdir(),'panter-native-flow-'));
  try {
    const store=await PanterStore.open(dir);
    const agents=await AgentEngine.open(dir,store);
    const mission=await store.createMission('project-x','Fix critical auth');
    const flow=await agents.createFlow(mission.id,'Preserve this exact requirement: auth must not be bypassed.',high,true);
    const task=await agents.addTask({flowId:flow.id,role:'builder',target:'gpt-a',objective:'Fix auth',scopes:['src/auth'],idempotencyKey:'one'});
    const claimed=await agents.claim('gpt-a','gpt-a');
    assert.equal(claimed?.id,task.id);
    await agents.report(task.id,'gpt-a',claimed!.leaseGeneration,{summary:'Fix prepared',evidence:['commit '+sha]});
    await agents.freezeCandidate(flow.id,sha,1);
    const reopened=await AgentEngine.open(dir,store);
    const summary=await reopened.summary(flow.id);
    assert.equal(summary?.flow.spec,'Preserve this exact requirement: auth must not be bypassed.');
    assert.equal(summary?.flow.candidateSha,sha);
    assert.equal(summary?.counts.DONE,1);
    await assert.rejects(reopened.closeFlow(flow.id,2),/independent verification/);
  } finally {await rm(dir,{recursive:true,force:true})}
});

test('GPT-A native-subagent capacity preference is durable and cannot be set on worker profiles',async()=>{
  const {mkdtemp,rm}=await import('node:fs/promises');
  const {join}=await import('node:path');
  const {tmpdir}=await import('node:os');
  const {MeshEngine}=await import('../src/core/mesh.js');
  const dir=await mkdtemp(join(tmpdir(),'panter-native-preferences-'));
  try{
    const mesh=await MeshEngine.open(dir);
    const owner={host:'gpt-a' as const,actorId:'actor-gpt-a',modelRequest:'host',effortRequest:'high',roles:['orchestrator' as const],preferNativeSubagents:true,maxRequestedNativeWorkers:4};
    const saved=await mesh.setProfile('gpt-a',owner,0);
    assert.equal(saved.maxRequestedNativeWorkers,4);
    const reopened=await MeshEngine.open(dir);
    assert.equal((await reopened.profiles())[0]?.preferNativeSubagents,true);
    await assert.rejects(mesh.setProfile('gpt-a',{...owner,host:'claude',roles:['reviewer']},0),/leader-only/);
    await assert.rejects(mesh.setProfile('gpt-a',{...owner,maxRequestedNativeWorkers:40},1),/ceiling/);
  }finally{await rm(dir,{recursive:true,force:true})}
});


test('Explicit GPT-A-only forbids remote delegation even when Claude is connected and demands full root capacity',()=>{
 const bindings=[{agentId:'gentle-ai-explore',host:'claude' as const,modelRequest:'claude-model',effortRequest:'low',skillIds:['gentle-ai' as const],revision:1}];
 const p=planHostNative({...base,signals:high,assignments:[task(),task('gentle-ai-verify')],bindings,peerStates:{claude:'CONNECTED'},coordinationMode:'GPT_A_ONLY',capabilities:{...base.capabilities,nativeSubagents:true,maxParallelSubagents:8,observedModel:'gpt-6-astra',observedReasoningEffort:'max',observedWorkerProcessing:'fast'}});
 assert.equal(p.soloActive,true);assert.equal(p.soloReason,'USER_SELECTED_GPT_A_ONLY');
 assert.ok(p.assignments.every(a=>a.host==='gpt-a'&&a.execution==='GPT_A_NATIVE_SUBAGENT'));
 assert.ok(p.assignments.every(a=>a.modelRequest==='gpt-6-astra'&&a.effortRequest==='max'&&a.speedRequest==='fast-if-supported'));
 assert.equal(p.capacityContract.requestedNativeWorkers,32);
 assert.equal(p.capacityContract.hostReportedNativeWorkers,8);
 assert.equal(p.capacityContract.scheduledNativeWorkers,2);
 assert.equal(p.capacityContract.rootReasoning,'max');assert.equal(p.capacityContract.nativeWorkerPreferredSpeed,'fast-if-supported');
});

test('No external workforce keeps full GPT-A model/effort and fast branch preference',()=>{
 const p=planHostNative({...base,signals:high,assignments:[task(),task('gentle-ai-verify')],capabilities:{...base.capabilities,nativeSubagents:true,maxParallelSubagents:3}});
 assert.equal(p.soloReason,'NO_CONNECTED_PEERS');
 assert.equal(p.capacityContract.rootModel,'gpt-6-astra');
 assert.equal(p.capacityContract.rootReasoning,'max');
 assert.equal(p.capacityContract.requestedNativeWorkers,32);
 assert.equal(p.requestedSubagentSlots,2);
 assert.equal(p.capacityContract.nativeWorkerFallbackSpeed,'standard-preserve-reasoning');
});

test('No native subagents continues same quality root inline and reports capacity gaps',()=>{
 const p=planHostNative({...base,signals:high,assignments:[task(),task('gentle-ai-verify')],coordinationMode:'GPT_A_ONLY',capabilities:{...base.capabilities,observedModel:'another',observedReasoningEffort:'low'}});
 assert.ok(p.assignments.every(x=>x.execution==='GPT_A_INLINE'&&x.modelRequest==='gpt-6-astra'&&x.effortRequest==='max'));
 assert.equal(p.capacityContract.requestedNativeWorkers,32);
 assert.equal(p.capacityContract.hostReportedNativeWorkers,0);
 assert.equal(p.fullCapacityObserved,false);
 assert.ok(p.capacityGaps.some(x=>/model/.test(x)));
 assert.ok(p.capacityGaps.some(x=>/reasoning/.test(x)));
 assert.ok(p.capacityGaps.some(x=>/subagents/.test(x)));
});

test('GPT-A-only preference persists and cannot be saved as a worker mode',async()=>{
 const {mkdtemp,rm}=await import('node:fs/promises');
 const {join}=await import('node:path');
 const {tmpdir}=await import('node:os');
 const {MeshEngine}=await import('../src/core/mesh.js');
 const dir=await mkdtemp(join(tmpdir(),'panter-solo-preferences-'));
 try{
  const m=await MeshEngine.open(dir);
  await m.setProfile('gpt-a',{host:'gpt-a',actorId:'actor-gpt-a',modelRequest:'gpt-6-astra',effortRequest:'max',roles:['orchestrator'],coordinationMode:'GPT_A_ONLY'},0);
  const reread=await MeshEngine.open(dir);
  assert.equal((await reread.profiles())[0]?.coordinationMode,'GPT_A_ONLY');
  await assert.rejects(m.setProfile('gpt-a',{host:'claude',actorId:'actor-claude',modelRequest:'claude',effortRequest:'high',roles:['reviewer'],coordinationMode:'GPT_A_ONLY'},0),/GPT-A-only/);
 } finally {await rm(dir,{recursive:true,force:true})}
});


test('Serial GPT-A only mode allows overlapping writer paths without claiming parallel isolation',()=>{
 const p=planHostNative({...base,signals:high,assignments:[{agentId:'gentle-ai-worker',objective:'Implement A',allowedEditSurfaces:['src/core']},{agentId:'jd-fix-agent',objective:'Fix B',allowedEditSurfaces:['src/core/file.ts']}],coordinationMode:'GPT_A_ONLY'});
 assert.ok(p.assignments.every(x=>x.execution==='GPT_A_INLINE'));
 assert.equal(p.capacityContract.scheduledNativeWorkers,0);
});
