import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MeshEngine } from '../src/core/mesh.js';

async function fixture(fn:(m:MeshEngine,dir:string)=>Promise<void>){
 const dir=await mkdtemp(join(tmpdir(),'panter-task-'));
 try{await fn(await MeshEngine.open(dir),dir)}
 finally{await rm(dir,{recursive:true,force:true})}
}
const grok={host:'grok' as const,actorId:'actor-grok',modelRequest:'host',effortRequest:'max',
 roles:['reviewer' as const]};

test('bridge is durable, actor-bound, metadata-only, never native Tasks wire',()=>fixture(async (m,dir)=>{
 await m.setProfile('gpt-a',grok,0);
 const task=await m.taskBridgeArm('grok','2025-11-25',60);
 assert.equal(task.status,'ARMED');
 assert.equal(task.delivery,'SCHEMA_BRIDGE_ONLY');
 assert.equal(task.autonomousWakeVerified,false);
 assert.equal((await m.taskBridgeArm('grok','2025-11-25',60)).taskId,task.taskId);
 await assert.rejects(m.taskBridgeGet('claude',task.taskId),/Task not found/);
 const w=await m.delegate('gpt-a',{missionId:'m',target:'grok',role:'reviewer',
   instruction:'secret instructions',idempotencyKey:'task-1'});
 const reopened=await MeshEngine.open(dir);
 const delivered=await reopened.taskBridgeGet('grok',task.taskId);
 assert.equal(delivered.workId,w.id);
 assert.equal(delivered.status,'DELIVERED');
 assert.ok(!JSON.stringify(delivered).includes('secret'));
 assert.equal((await reopened.pending('grok')).length,1);
 const cancel=await reopened.taskBridgeCancel('grok',task.taskId);
 assert.equal(cancel.status,'CANCELLED');
 assert.equal(cancel.workCancelled,false);
 assert.equal((await reopened.pending('grok')).length,1);
}));

test('protocol era is explicit and no worker may consume another listener',()=>fixture(async m=>{
 const legacy=await m.taskBridgeArm('gemini','2025-11-25');
 const modern=await m.taskBridgeArm('claude','2026-07-28');
 assert.equal(legacy.protocolEra,'2025-11-25');
 assert.equal(modern.protocolEra,'2026-07-28');
 await assert.rejects(m.taskBridgeArm('gpt-a','2026-07-28'),/Only workers/);
 await assert.rejects(m.taskBridgeArm('grok','2026-07-28',5),/Invalid task bridge TTL/);
 await assert.rejects(m.taskBridgeCancel('grok',legacy.taskId),/Task not found/);
 await assert.rejects(m.taskBridgeGet('gpt-a',modern.taskId),/Only workers/);
}));

test('terminal completion creates one durable rearm intent and returns no result text, even after retry',()=>fixture(async (m,dir)=>{
 await m.setProfile('gpt-a',grok,0);
 const w=await m.delegate('gpt-a',{missionId:'rearm',target:'grok',role:'reviewer',
   instruction:'Analyze',idempotencyKey:'one'});
 const c=await m.claim('grok',w.id);
 const secret='full sensitive result stays in backend';
 const result=await m.complete('grok',w.id,c.attemptId!,c.leaseGeneration,secret);
 assert.equal(JSON.stringify(result).includes(secret),false);
 assert.equal(result.rearmPending,true);
 const replay=await m.complete('grok',w.id,c.attemptId!,c.leaseGeneration,secret);
 assert.equal(JSON.stringify(replay).includes(secret),false);
 assert.equal(JSON.stringify(replay).includes('instruction'),false);
 await assert.rejects(m.resultGet('claude',w.id),/Only GPT-A/);
 assert.equal((await m.resultGet('gpt-a',w.id)).result,secret);
 const inbox=await m.inbox('gpt-a');
 assert.equal(JSON.stringify(inbox).includes(secret),false);
 assert.equal((await m.rearmStatus('grok')).filter(x=>x.status==='PENDING').length,1);
 const reopened=await MeshEngine.open(dir);
 assert.equal((await reopened.rearmStatus('grok')).length,1);
 const task=await reopened.taskBridgeArm('grok','2026-07-28');
 assert.equal(task.status,'ARMED');
 assert.equal((await reopened.rearmStatus('grok'))[0]!.status,'ACKED');
 const again=await reopened.taskBridgeArm('grok','2026-07-28');
 assert.equal(task.taskId,again.taskId);
 assert.equal((await reopened.rearmStatus('grok')).length,1);
}));

test('replay conflict and stale writer completion never create a duplicate terminal receipt',()=>fixture(async m=>{
 await m.setProfile('gpt-a',{...grok,roles:['implementer']},0);
 const w=await m.delegate('gpt-a',{missionId:'writer',target:'grok',role:'implementer',
 instruction:'Write',idempotencyKey:'one'});
 const claim=await m.claim('grok',w.id,30);
 await m.complete('grok',w.id,claim.attemptId!,claim.leaseGeneration,'one result');
 await assert.rejects(m.complete('grok',w.id,claim.attemptId!,claim.leaseGeneration,'second result'),/Conflicting terminal/);
 await assert.rejects(m.complete('claude',w.id,claim.attemptId!,claim.leaseGeneration,'one result'),/Work not found/);
 assert.equal((await m.rearmStatus('grok')).length,1);
}));

test('standing worker pickup atomically claims oldest eligible pointer, then drains queue',()=>fixture(async m=>{
 await m.setProfile('gpt-a',grok,0);
 const w=await m.delegate('gpt-a',{missionId:'standing',target:'grok',role:'reviewer',
   instruction:'Check source',idempotencyKey:'first'});
 const first=await m.pickup('grok',60);
 assert.equal(first.status,'CLAIMED');
 assert.equal(first.work?.id,w.id);
 assert.equal(first.work?.instruction,'Check source');
 assert.equal((await m.pickup('grok',60)).status,'EMPTY');
 await assert.rejects(m.pickup('gpt-a',60),/Only workers/);
}));

test('complete-and-rearm commits result exactly once and creates host-owned listener',()=>fixture(async (m,dir)=>{
 await m.setProfile('gpt-a',grok,0);
 const w=await m.delegate('gpt-a',{missionId:'m-complete',target:'grok',
   role:'reviewer',instruction:'Audit',idempotencyKey:'1'});
 const c=await m.pickup('grok',300);
 assert.equal(c.status,'CLAIMED');
 const terminal=await m.completeAndRearm('grok',w.id,c.work!.attemptId!,c.work!.leaseGeneration,
   'full raw findings',true,'2025-11-25');
 assert.equal(terminal.receipt.state,'COMPLETED');
 assert.equal(terminal.rearm.status,'ACKED');
 assert.equal(JSON.stringify(terminal).includes('full raw findings'),false);
 assert.equal((await m.resultGet('gpt-a',w.id)).result,'full raw findings');
 const restarted=await MeshEngine.open(dir);
 assert.equal((await restarted.rearmStatus('grok'))[0]!.status,'ACKED');
 assert.equal((await restarted.workforceStatus('gpt-a')).find(x=>x.host==='grok')!.bridgeListeners.length,1);
 const again=await restarted.completeAndRearm('grok',w.id,c.work!.attemptId!,c.work!.leaseGeneration,
   'full raw findings',true,'2025-11-25');
 assert.equal(again.rearm.status,'ACKED');
 assert.equal((await restarted.rearmStatus('grok')).length,1);
 await assert.rejects(restarted.completeAndRearm('claude',w.id,c.work!.attemptId!,c.work!.leaseGeneration,
   'full raw findings',true,'2025-11-25'),/Work not found/);
}));

test('concurrent standing pickups never obtain two execution claims for one work',()=>fixture(async m=>{
 await m.setProfile('gpt-a',grok,0);
 const w=await m.delegate('gpt-a',{missionId:'parallel',target:'grok',role:'reviewer',
   instruction:'Do not execute twice',idempotencyKey:'single'});
 const outcomes=await Promise.all([m.pickup('grok'),m.pickup('grok')]);
 assert.deepEqual(outcomes.map(x=>x.status).sort(),['CLAIMED','EMPTY']);
 const claim=outcomes.find(x=>x.status==='CLAIMED')!;
 assert.equal(claim.work?.id,w.id);
 assert.equal((await m.pending('grok')).length,0);
}));

test('bridge pointer becomes CONSUMED after fenced claim and does not permit stale pickup',()=>fixture(async m=>{
 await m.setProfile('gpt-a',grok,0);
 const task=await m.taskBridgeArm('grok','2026-07-28');
 const w=await m.delegate('gpt-a',{missionId:'m-consumed',target:'grok',
 role:'reviewer',instruction:'Do once',idempotencyKey:'consumed'});
 assert.equal((await m.taskBridgeGet('grok',task.taskId)).workId,w.id);
 const claimed=await m.pickup('grok');
 assert.equal(claimed.status,'CLAIMED');
 const stale=await m.taskBridgeGet('grok',task.taskId);
 assert.equal(stale.status,'CONSUMED');
 assert.equal(stale.workId,null);
 assert.equal((await m.pickup('grok')).status,'EMPTY');
}));

test('failed rearm cannot replay a committed result and can resume after recovery',()=>fixture(async (m,dir)=>{
 await m.setProfile('gpt-a',grok,0);
 const w=await m.delegate('gpt-a',{missionId:'m-rearmfail',target:'grok',
 role:'reviewer',instruction:'Audit once',idempotencyKey:'one'});
 const c=await m.pickup('grok');
 assert.equal(c.status,'CLAIMED');
 m.taskBridgeArm=async()=>{throw new Error('transient transport error')};
 const result=await m.completeAndRearm('grok',w.id,c.work!.attemptId!,
 c.work!.leaseGeneration,'final output',true,'2026-07-28');
 assert.equal(result.receipt.state,'COMPLETED');
 assert.equal(result.rearm.status,'PENDING_RETRY');
 const reopened=await MeshEngine.open(dir);
 assert.equal((await reopened.resultGet('gpt-a',w.id)).result,'final output');
 assert.equal((await reopened.rearmStatus('grok'))[0]!.status,'PENDING');
 await reopened.taskBridgeArm('grok','2026-07-28');
 assert.equal((await reopened.rearmStatus('grok'))[0]!.status,'ACKED');
 assert.equal((await reopened.inbox('gpt-a')).messages.filter(x=>x.workId===w.id&&x.kind==='RESULT').length,1);
}));
