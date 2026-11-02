import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MeshEngine} from '../src/core/mesh.js';

async function fixture(run:(mesh:MeshEngine)=>Promise<void>){
  const dir=await mkdtemp(join(tmpdir(),'panter-auto-wake-'));
  try{await run(await MeshEngine.open(dir));}
  finally{await rm(dir,{recursive:true,force:true});}
}
const role='reviewer' as const;
const task={missionId:'mission-wake',role,instruction:'review an isolated candidate',idempotencyKey:'wake-one'};
const profile=(host:'claude'|'grok')=>({
  host,actorId:'actor-'+host,roles:[role],modelRequest:'host-native',effortRequest:'max'
});

test('GPT-A auto routing fails closed with no authenticated standing peer',()=>fixture(async m=>{
  await m.setProfile('gpt-a',{host:'gpt-a',actorId:'gpt-a-primary',roles:['orchestrator'],
    modelRequest:'host-native',effortRequest:'max',coordinationMode:'AUTO'},0);
  await m.setProfile('gpt-a',profile('grok'),0);
  const status=await m.delegateAuto('gpt-a',task);
  assert.equal(status.status,'LOCAL_FALLBACK_REQUIRED');
  assert.equal(status.autonomousWakeVerified,false);
  assert.deepEqual(await m.pending('grok'),[],'unknown peer must not receive unattended work');
  await assert.rejects(m.delegateAuto('grok',task),/Only GPT-A/);
}));

test('GPT-A routes to available host automatically, receives durable silent results and rearms',()=>fixture(async m=>{
  await m.setProfile('gpt-a',{host:'gpt-a',actorId:'gpt-a-primary',roles:['orchestrator'],
    modelRequest:'host-native',effortRequest:'max',coordinationMode:'AUTO'},0);
  await m.setProfile('gpt-a',profile('grok'),0);
  await m.setProfile('gpt-a',profile('claude'),0);
  await m.workforcePoll('grok',{protocolEra:'2026-07-28',deliveryMode:'LONG_POLL'});
  await m.workforcePoll('claude',{protocolEra:'2026-07-28',deliveryMode:'LONG_POLL'});
  const first=await m.delegateAuto('gpt-a',task);
  assert.equal(first.status,'DELEGATED');
  if(first.status!=='DELEGATED')throw Error('Expected delegation');
  assert.equal(first.selectedHost,'claude','deterministic tie break');
  assert.equal(first.autonomousWakeVerified,false);
  const replay=await m.delegateAuto('gpt-a',task);
  assert.equal(replay.status,'DELEGATED');
  if(replay.status==='DELEGATED') assert.equal(replay.work.id,first.work.id,'idempotent retry');
  const second=await m.delegateAuto('gpt-a',{...task,idempotencyKey:'wake-two'});
  assert.equal(second.status,'DELEGATED');
  if(second.status==='DELEGATED')assert.equal(second.selectedHost,'grok','least loaded peer selected');
  const claimed=await m.pickup('claude',300);
  assert.equal(claimed.status,'CLAIMED');
  if(claimed.status!=='CLAIMED')throw Error('Expected claim');
  const privateResult='private evidence only GPT-A may retrieve';
  const complete=await m.completeAndRearm('claude',claimed.work.id,claimed.work.attemptId!,
    claimed.work.leaseGeneration,privateResult,true,'2026-07-28');
  assert.equal(complete.receipt.resultAvailable,true);
  assert.ok(!JSON.stringify(complete).includes(privateResult),'worker ACK must stay compact');
  const completeResult=await m.resultGet('gpt-a',claimed.work.id);
  assert.equal(completeResult.result,privateResult);
  await assert.rejects(m.resultGet('grok',claimed.work.id),/Only GPT-A/);
  const inbox=await m.inbox('gpt-a',0);
  assert.ok(!JSON.stringify(inbox).includes(privateResult),'inbox contains pointers, not full result');
  await m.setCoordinationMode('gpt-a','GPT_A_ONLY',1);
  const local=await m.delegateAuto('gpt-a',{...task,idempotencyKey:'local-only'});
  assert.equal(local.status,'LOCAL_FALLBACK_REQUIRED','explicit solo mode must not fan out');
}));
