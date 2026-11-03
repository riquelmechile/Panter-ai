import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MeshEngine} from '../src/core/mesh.js';

const profile={host:'claude' as const,actorId:'claude-oauth-worker',
 roles:['reviewer' as const],modelRequest:'host-native',effortRequest:'max'};
async function fresh(fn:(m:MeshEngine,dir:string)=>Promise<void>){
 const dir=await mkdtemp(join(tmpdir(),'panter-claude-wake-'));
 try{await fn(await MeshEngine.open(dir),dir)}
 finally{await rm(dir,{recursive:true,force:true})}
}
test('Claude Routine one-shot reservation prevents duplicate paid cloud sessions',()=>fresh(async(m,dir)=>{
 await m.setProfile('gpt-a',profile,0);
 const input={missionId:'claude-routine-test',target:'claude' as const,
   role:'reviewer' as const,instruction:'Review current candidate',
   idempotencyKey:'review-once',wakeOnly:true};
 const w=await m.delegate('gpt-a',input);
 const reservation=await m.reserveClaudeWake('gpt-a',w.id);
 assert.equal(reservation.send,true);
 assert.equal((await m.reserveClaudeWake('gpt-a',w.id)).send,false);
 assert.equal((await m.delegate('gpt-a',input)).id,w.id);
 await assert.rejects(m.delegate('gpt-a',{...input,idempotencyKey:'review-again'}),/busy/);
 assert.equal((await m.claudeWakeStatus('gpt-a',w.id)).state,'RESERVED');
 const reopened=await MeshEngine.open(dir);
 assert.equal((await reopened.reserveClaudeWake('gpt-a',w.id)).send,false);
 await m.finishClaudeWake('gpt-a',w.id,true,200,'session_abc123');
 assert.equal((await m.claudeWakeStatus('gpt-a',w.id)).sessionId,'session_abc123');
 assert.equal((await m.claudeWakeStatus('gpt-a',w.id)).wakeObserved,false);
 await assert.rejects(m.claudeWakeStatus('grok',w.id),/Only GPT-A/);
 const claim=await m.pickup('claude',60);
 assert.equal(claim.status,'CLAIMED');
 const status=await m.claudeWakeStatus('gpt-a',w.id);
 assert.equal(status.wakeObserved,true);
 if(claim.status!=='CLAIMED')throw Error('no claim');
 const receipt=await m.complete('claude',w.id,claim.work.attemptId!,claim.work.leaseGeneration,
   'review completed by host',true);
 assert.equal(receipt.resultAvailable,true);
 assert.equal((await m.resultGet('gpt-a',w.id)).result,'review completed by host');
}));
test('Claude accepted HTTP after a prior claim does not fabricate observed external wake',()=>fresh(async m=>{
 await m.setProfile('gpt-a',profile,0);
 const w=await m.delegate('gpt-a',{missionId:'before-send',target:'claude',
   role:'reviewer',instruction:'test',idempotencyKey:'one',wakeOnly:true});
 await m.reserveClaudeWake('gpt-a',w.id);
 const claim=await m.claim('claude',w.id,300,true);
 assert.equal(claim.state,'RUNNING');
 await m.finishClaudeWake('gpt-a',w.id,true,200,'session_abc123');
 assert.equal((await m.claudeWakeStatus('gpt-a',w.id)).wakeObserved,false);
}));
test('Claude external wake cannot dispatch a writer or bypass solo mode',()=>fresh(async m=>{
 await m.setProfile('gpt-a',profile,0);
 await assert.rejects(m.delegate('gpt-a',{missionId:'write',target:'claude',role:'implementer',
   instruction:'edit',idempotencyKey:'write',wakeOnly:true}),/not configured|remote writes/);
 await m.setCoordinationMode('gpt-a','GPT_A_ONLY',0);
 await assert.rejects(m.delegate('gpt-a',{missionId:'solo',target:'claude',role:'reviewer',
   instruction:'review',idempotencyKey:'one',wakeOnly:true}),/GPT_A_ONLY/);
}));
