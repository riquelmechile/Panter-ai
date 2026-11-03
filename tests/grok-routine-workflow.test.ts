import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MeshEngine} from '../src/core/mesh.js';

const profile={host:'grok' as const,actorId:'oauth-grok',roles:['reviewer' as const],
 modelRequest:'host-native',effortRequest:'max'};
async function fresh(fn:(m:MeshEngine,dir:string)=>Promise<void>){
 const dir=await mkdtemp(join(tmpdir(),'panter-grok-wake-'));
 try{await fn(await MeshEngine.open(dir),dir)}
 finally{await rm(dir,{recursive:true,force:true})}
}
test('Grok wake: at most one outstanding signal, no reroute or duplicate completion',()=>fresh(async(m,dir)=>{
 await m.setProfile('gpt-a',profile,0);
 const args={missionId:'wake-test',target:'grok' as const,role:'reviewer' as const,
   instruction:'private reviewer context',idempotencyKey:'once',wakeOnly:true};
 const w=await m.delegate('gpt-a',args);
 const reserved=await m.reserveGrokWake('gpt-a',w.id);
 assert.equal(reserved.send,true);
 const repeated=await m.delegate('gpt-a',args);
 assert.equal(repeated.id,w.id);
 assert.equal((await m.reserveGrokWake('gpt-a',w.id)).send,false);
 await assert.rejects(m.delegate('gpt-a',{...args,idempotencyKey:'twice'}),/busy/);
 let record=await m.grokWakeStatus('gpt-a',w.id);
 assert.equal(record.state,'RESERVED');
 assert.equal(record.wakeObserved,false);
 // A claim made before the signal is accepted must not prove wake.
 const preSignal=await m.claim('grok',w.id,300,true);
 await m.finishGrokWake('gpt-a',w.id,true,200);
 record=await m.grokWakeStatus('gpt-a',w.id);
 assert.equal(record.state,'SIGNAL_ACCEPTED');
 assert.equal(record.wakeObserved,false);
 await assert.rejects(m.grokWakeStatus('claude',w.id),/Only GPT-A/);
 const receipt=await m.complete('grok',w.id,preSignal.attemptId!,preSignal.leaseGeneration,'done',true);
 assert.equal(receipt.resultAvailable,true);
 assert.equal((await m.resultGet('gpt-a',w.id)).result,'done');
 const reloaded=await MeshEngine.open(dir);
 assert.equal((await reloaded.grokWakeStatus('gpt-a',w.id)).state,'SIGNAL_ACCEPTED');
 assert.equal((await reloaded.reserveGrokWake('gpt-a',w.id)).send,false);
}));
test('Grok wake: post-accepted claim is observed, but does not prove autonomous cold start',()=>fresh(async m=>{
 await m.setProfile('gpt-a',profile,0);
 const w=await m.delegate('gpt-a',{missionId:'wake-claim',target:'grok',role:'reviewer',
   instruction:'test',idempotencyKey:'one',wakeOnly:true});
 await m.reserveGrokWake('gpt-a',w.id);
 await m.finishGrokWake('gpt-a',w.id,true,202);
 assert.equal((await m.grokWakeStatus('gpt-a',w.id)).wakeObserved,false);
 await m.pickup('grok',60);
 const status=await m.grokWakeStatus('gpt-a',w.id);
 assert.equal(status.wakeObserved,true);
 assert.equal(status.state,'SIGNAL_ACCEPTED');
 assert.ok(status.claimedAt);
}));
test('Grok wake only routes read-only roles and never bypasses GPT-A solo mode',()=>fresh(async m=>{
 await m.setProfile('gpt-a',profile,0);
 await assert.rejects(m.delegate('gpt-a',{missionId:'x',target:'grok',role:'implementer',
   instruction:'edit repo',idempotencyKey:'write',wakeOnly:true}),/not configured|remote writes/);
 await m.setCoordinationMode('gpt-a','GPT_A_ONLY',0);
 await assert.rejects(m.delegate('gpt-a',{missionId:'y',target:'grok',role:'reviewer',
   instruction:'review',idempotencyKey:'one',wakeOnly:true}),/GPT_A_ONLY/);
}));
