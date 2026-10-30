import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MeshEngine } from '../src/core/mesh.js';
async function withMesh(fn:(mesh:MeshEngine)=>Promise<void>){const dir=await mkdtemp(join(tmpdir(),'panter-mesh-'));try{await fn(await MeshEngine.open(dir))}finally{await rm(dir,{recursive:true,force:true})}}
const profile={host:'grok' as const,actorId:'actor-grok-001',modelRequest:'host-default',effortRequest:'max',roles:['reviewer' as const]};
test('only GPT-A may configure and profiles are revision fenced',()=>withMesh(async m=>{await assert.rejects(m.setProfile('grok',profile,0),/Only orchestrator/);const a=await m.setProfile('gpt-a',profile,0);assert.equal(a.revision,1);await assert.rejects(m.setProfile('gpt-a',profile,0),/Stale/)}));
test('authenticated target boundaries, idempotent delegation and durable return',()=>withMesh(async m=>{await m.setProfile('gpt-a',profile,0);const payload={missionId:'mission-1',target:'grok' as const,role:'reviewer' as const,instruction:'Review the candidate',idempotencyKey:'scope-1'};await assert.rejects(m.delegate('claude',payload),/GPT-A/);const w=await m.delegate('gpt-a',payload);assert.equal((await m.delegate('gpt-a',payload)).id,w.id);await assert.rejects(m.claim('gemini',w.id),/not found/);const claimed=await m.claim('grok',w.id);assert.equal(claimed.state,'RUNNING');await assert.rejects(m.complete('gemini',w.id,claimed.attemptId!,claimed.leaseGeneration,'bad'),/not found/);const result=await m.complete('grok',w.id,claimed.attemptId!,claimed.leaseGeneration,'One security issue');assert.equal(result.receiptDigest?.length,64);assert.equal((await m.complete('grok',w.id,claimed.attemptId!,claimed.leaseGeneration,'One security issue')).receiptDigest,result.receiptDigest);await assert.rejects(m.complete('grok',w.id,claimed.attemptId!,claimed.leaseGeneration,'altered'),/Conflicting/);const inbox=await m.inbox('gpt-a');assert.equal(inbox.messages[0]?.text,'One security issue');assert.ok((await m.resource('gpt-a')).revision>0)}));
test('questions and answers have actor-bound messaging, never cross-mission',()=>withMesh(async m=>{await m.setProfile('gpt-a',profile,0);const w=await m.delegate('gpt-a',{missionId:'m1',target:'grok',role:'reviewer',instruction:'Audit',idempotencyKey:'a'});await assert.rejects(m.message('claude',{missionId:'m1',to:'gpt-a',workId:w.id,text:'hello',kind:'QUESTION'}),/Not a member/);await assert.rejects(m.message('grok',{missionId:'other',to:'gpt-a',workId:w.id,text:'hello',kind:'QUESTION'}),/Known work/);await m.message('grok',{missionId:'m1',to:'gpt-a',workId:w.id,text:'Which SHA?',kind:'QUESTION'});await m.message('gpt-a',{missionId:'m1',to:'grok',workId:w.id,text:'abcd1234',kind:'ANSWER'});assert.equal((await m.inbox('grok')).messages[0]?.text,'abcd1234')}));
test('state persists and notification emission follows durable commit',()=>withMesh(async m=>{await m.setProfile('gpt-a',profile,0);let event=0;m.events.on('gpt-a',n=>event=n);const w=await m.delegate('gpt-a',{missionId:'m2',target:'grok',role:'reviewer',instruction:'Check',idempotencyKey:'b'});const c=await m.claim('grok',w.id);await m.complete('grok',w.id,c.attemptId!,c.leaseGeneration,'done');assert.ok(event>0);const reopened=await MeshEngine.open((m as any).file.replace(/\/mesh.json$/,''));assert.equal((await reopened.inbox('gpt-a')).messages[0]?.text,'done')}));

test('direct implementer is denied without operator authorization',()=>withMesh(async m=>{await m.setProfile('gpt-a',{...profile,roles:['implementer']},0);m.setWriteGuard(async()=>{throw Error('operator grant required')});await assert.rejects(m.delegate('gpt-a',{missionId:'m1',target:'grok',role:'implementer',instruction:'Edit',idempotencyKey:'w1'}),/operator grant required/)}));

test('identical bounded builder delegation is idempotent before writer overlap checks',()=>withMesh(async m=>{
  await m.setProfile('gpt-a',{...profile,roles:['implementer']},0);
  await m.bindSpecialist('gpt-a',{agentId:'gentle-ai-worker',host:'grok',modelRequest:'host-default',effortRequest:'max',skillIds:['gentle-ai']},0);
  m.setWriteGuard(async (_mission,paths)=>{assert.deepEqual(paths,['src/auth.ts']);});
  const make=(key:string,objective='Fix authentication')=>m.delegateBoundSpecialist('gpt-a',{
    missionId:'mission-overlap',agentId:'gentle-ai-worker',objective,
    idempotencyKey:key,allowedEditSurfaces:['src/auth.ts']
  });
  const first=await make('writer-attempt-one');
  assert.equal(first.state,'QUEUED');
  const retry=await make('writer-attempt-one');
  assert.equal(retry.id,first.id);
  assert.equal((await m.pending('grok')).length,1);
  await assert.rejects(make('writer-attempt-one','Change credentials'),/Idempotency conflict/);
  await assert.rejects(make('distinct-writer-attempt'),/Overlapping active writer edit surfaces/);
  const claimed=await m.claim('grok',first.id);
  assert.equal(claimed.state,'RUNNING');
  assert.equal((await make('writer-attempt-one')).id,first.id);
  assert.equal((await m.inbox('gpt-a')).works.filter(w=>w.id===first.id).length,1);
}));

test('an expired writer can be reconciled only by the exact fenced operator decision, never replayed silently',()=>withMesh(async m=>{
 await m.setProfile('gpt-a',{...profile,roles:['implementer']},0);
 await m.bindSpecialist('gpt-a',{agentId:'gentle-ai-worker',host:'grok',modelRequest:'host-default',effortRequest:'max',skillIds:['gentle-ai']},0);
 m.setWriteGuard(async()=>{});
 const work=await m.delegateBoundSpecialist('gpt-a',{missionId:'uncertain-mission',agentId:'gentle-ai-worker',
   objective:'Fix application',idempotencyKey:'uncertain-1',allowedEditSurfaces:['src/index.ts']});
 const claimed=await m.claim('grok',work.id,30);
 const oldNow=Date.now;
 try{
  Date.now=()=>oldNow()+31000;
  const lost=await m.claim('grok',work.id,30);
  assert.equal(lost.state,'OUTCOME_UNKNOWN');
  await assert.rejects(m.reconcileWriter({workId:work.id,attemptId:'00000000-0000-0000-0000-000000000000',
    leaseGeneration:claimed.leaseGeneration,resolution:'CONFIRMED_NO_EFFECTS',
    isolationEvidence:'Operator stopped the worker process and revoked its write credentials before release.',
    evidence:'Operator inspected Git HEAD and workspace and confirmed no changes.'}),/Stale writer attempt/);
  await assert.rejects(m.delegateBoundSpecialist('gpt-a',{missionId:'uncertain-mission',agentId:'gentle-ai-worker',
   objective:'Fix another task',idempotencyKey:'uncertain-2',allowedEditSurfaces:['src/index.ts']}),/Overlapping active writer/);
  const done=await m.reconcileWriter({workId:work.id,attemptId:claimed.attemptId!,
    leaseGeneration:claimed.leaseGeneration,resolution:'CONFIRMED_NO_EFFECTS',
    isolationEvidence:'Operator stopped the worker process and revoked its write credentials before release.',
    evidence:'Operator inspected Git HEAD and workspace, verified no effects and no running worker.'});
  assert.equal(done.state,'ABORTED_NO_EFFECTS');
  assert.equal((await m.delegateBoundSpecialist('gpt-a',{missionId:'uncertain-mission',agentId:'gentle-ai-worker',
   objective:'Fix another task',idempotencyKey:'uncertain-2',allowedEditSurfaces:['src/index.ts']})).state,'QUEUED');
  await assert.rejects(m.complete('grok',work.id,claimed.attemptId!,claimed.leaseGeneration,'late result'),/Stale work lease/);
 }finally{Date.now=oldNow;}
}));
test('operator-confirmed completion produces the real candidate receipt without rerunning an uncertain writer',()=>withMesh(async m=>{
 await m.setProfile('gpt-a',{...profile,roles:['implementer']},0);
 const w=await m.delegate('gpt-a',{missionId:'m-recovery',target:'grok',role:'implementer',instruction:'Write once',idempotencyKey:'recovered'});
 const claim=await m.claim('grok',w.id,30);
 const original=Date.now;
 try{
  Date.now=()=>original()+31000;
  await m.claim('grok',w.id,30);
  const result={summary:'Confirmed commit',evidence:['Checked Git history and exact diff'],candidateSha:'a'.repeat(40),runId:'grok-real-run-001'};
  const reconciled=await m.reconcileWriter({workId:w.id,attemptId:claim.attemptId!,
    leaseGeneration:claim.leaseGeneration,resolution:'CONFIRMED_COMPLETE',
    evidence:'Operator verified exact commit and live workspace with no other effects.',
    result});
  assert.equal(reconciled.state,'COMPLETED');
  const inbox=await m.inbox('gpt-a');
  assert.equal(JSON.parse(inbox.messages.find(x=>x.workId===w.id)!.text).candidateSha,result.candidateSha);
 }finally{Date.now=original;}
}));

test('operator can inspect uncertain attempt fences without unlocking the writer',()=>withMesh(async m=>{
 await m.setProfile('gpt-a',{...profile,roles:['implementer']},0);
 const w=await m.delegate('gpt-a',{missionId:'m-admin-inspection',target:'grok',role:'implementer',
   instruction:'Implement change',idempotencyKey:'inspect'});
 const c=await m.claim('grok',w.id,30);
 const original=Date.now;
 try{
  Date.now=()=>original()+31000;
  const listed=await m.uncertainWriters();
  assert.equal(listed.length,1);
  assert.equal(listed[0]!.attemptId,c.attemptId);
  assert.equal(listed[0]!.leaseGeneration,c.leaseGeneration);
  await assert.rejects(m.reconcileWriter({workId:w.id,attemptId:c.attemptId!,
    leaseGeneration:c.leaseGeneration,resolution:'CONFIRMED_NO_EFFECTS',
    evidence:'We inspected the workspace and did not observe changes'}),/Confirm peer credentials/);
  assert.equal((await m.uncertainWriters()).length,1);
 }finally{Date.now=original;}
}));
