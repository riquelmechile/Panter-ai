import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MeshEngine} from '../src/core/mesh.js';

const route={protocolEra:'2026-07-28' as const,deliveryMode:'SCHEDULED_POLL' as const,pollIntervalSeconds:3600};
const profile={host:'gemini' as const,actorId:'gemini-oauth-worker',roles:['explorer' as const,'implementer' as const],
  modelRequest:'host-native',effortRequest:'max',scheduledPickupEnabled:true,scheduledPollIntervalSeconds:3600};
const task={missionId:'workforce-gemini',role:'explorer' as const,
  instruction:'Review an isolated public code example without editing.',idempotencyKey:'gemini-one'};

async function fixture(run:(mesh:MeshEngine,dir:string)=>Promise<void>){
  const dir=await mkdtemp(join(tmpdir(),'panter-scheduled-test-'));
  try{await run(await MeshEngine.open(dir),dir)}
  finally{await rm(dir,{recursive:true,force:true})}
}

test('Gemini cannot be auto-selected from OAuth config or self-reported live listener alone',()=>fixture(async m=>{
  await m.setProfile('gpt-a',profile,0);
  const before=await m.delegateScheduled('gpt-a',task);
  assert.equal(before.status,'LOCAL_FALLBACK_REQUIRED');
  await m.workforcePoll('gemini',{protocolEra:'2026-07-28',deliveryMode:'LONG_POLL'});
  const fake=await m.delegateScheduled('gpt-a',task);
  assert.equal(fake.status,'LOCAL_FALLBACK_REQUIRED');
  assert.deepEqual(await m.pending('gemini'),[]);
  await assert.rejects(m.delegateScheduled('gemini',task),/Only GPT-A/);
}));

test('Gemini scheduled pickup queues one read-only work and returns fenced terminal receipt',()=>fixture(async(m,dir)=>{
  await m.setProfile('gpt-a',profile,0);
  const tick=await m.workforcePoll('gemini',route);
  assert.equal(tick.status,'EMPTY');
  const offered=await m.delegateScheduled('gpt-a',task);
  assert.equal(offered.status,'DELEGATED');
  assert.equal(offered.selectedHost,'gemini');
  assert.equal(offered.selectionEvidence,'OBSERVED_SCHEDULE_POLL_QUEUE_ONLY');
  assert.equal(offered.autonomousWakeVerified,false);
  if(offered.status!=='DELEGATED')throw Error('not dispatched');
  const replay=await m.delegateScheduled('gpt-a',task);
  assert.equal(replay.status,'DELEGATED');
  if(replay.status!=='DELEGATED')throw Error('not replayed');
  assert.equal(replay.work.id,offered.work.id);
  const busy=await m.delegateScheduled('gpt-a',{...task,idempotencyKey:'gemini-two'});
  assert.equal(busy.status,'LOCAL_FALLBACK_REQUIRED');
  assert.equal((await m.pending('gemini')).length,1);
  const claim=await m.pickup('gemini',300,true);
  assert.equal(claim.status,'CLAIMED');
  if(claim.status!=='CLAIMED')throw Error('not claimed');
  const result=await m.complete('gemini',claim.work.id,claim.work.attemptId!,
    claim.work.leaseGeneration,'completed by host, no secret',true);
  assert.equal(result.resultAvailable,true);
  assert.equal((await m.resultGet('gpt-a',claim.work.id)).result,'completed by host, no secret');
  await assert.rejects(m.resultGet('claude',claim.work.id),/Only GPT-A/);
  const prior=await m.rearmStatus('gemini');
  assert.ok(JSON.stringify(prior).includes('PENDING'));
  // A *new* host-owned schedule invocation, not completion, acknowledges rearm.
  await m.workforcePoll('gemini',route);
  const next=await m.rearmStatus('gemini');
  assert.ok(JSON.stringify(next).includes('ACKED'));
  const status=await m.workforceStatus('gpt-a');
  const gemini=status.find(x=>x.host==='gemini')!;
  assert.equal(gemini.scheduledPickup.configured,true);
  assert.equal(gemini.scheduledPickup.observedCallCount,2);
  assert.equal(gemini.scheduledPickup.autonomousWakeVerified,false);
  const restored=await MeshEngine.open(dir);
  assert.equal((await restored.workforceStatus('gpt-a')).find(x=>x.host==='gemini')!.scheduledPickup.observedCallCount,2);
}));

test('scheduled worker skips writers and does not bypass solo policy or profile cadence',()=>fixture(async m=>{
  await m.setProfile('gpt-a',profile,0);
  await m.workforcePoll('gemini',{...route,pollIntervalSeconds:7200});
  assert.equal((await m.delegateScheduled('gpt-a',task)).status,'LOCAL_FALLBACK_REQUIRED');
  await m.workforcePoll('gemini',route);
  await m.delegate('gpt-a',{...task,target:'gemini',role:'implementer',idempotencyKey:'manual-writer'});
  const allowed=await m.delegateScheduled('gpt-a',task);
  assert.equal(allowed.status,'LOCAL_FALLBACK_REQUIRED');
  const noWrite=await m.pickup('gemini',300,true);
  assert.equal(noWrite.status,'EMPTY');
  assert.equal((await m.pending('gemini')).length,1);
  await m.setCoordinationMode('gpt-a','GPT_A_ONLY',0);
  assert.equal((await m.delegateScheduled('gpt-a',{...task,idempotencyKey:'solo'})).status,'LOCAL_FALLBACK_REQUIRED');
}));

test('profile must opt in with an explicit bounded interval; scheduled writer auto-dispatch denied',()=>fixture(async m=>{
  await assert.rejects(m.setProfile('gpt-a',{...profile,scheduledPickupEnabled:true,
    scheduledPollIntervalSeconds:10},0),/3600/);
  await assert.rejects(m.setProfile('gpt-a',{...profile,scheduledPollIntervalSeconds:undefined},0),/interval required/);
  await m.setProfile('gpt-a',profile,0);
  await m.workforcePoll('gemini',route);
  assert.equal((await m.delegateScheduled('gpt-a',{...task,role:'implementer'})).status,'LOCAL_FALLBACK_REQUIRED');
}));
