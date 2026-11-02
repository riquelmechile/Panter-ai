import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MeshEngine} from '../src/core/mesh.js';
import {McpServer} from '@modelcontextprotocol/server';
import {registerTaskWire} from '../src/core/workforce-task-wire.js';

async function fixture(fn:(m:MeshEngine)=>Promise<void>){
 const dir=await mkdtemp(join(tmpdir(),'panter-wire-'));
 try{await fn(await MeshEngine.open(dir));}finally{await rm(dir,{recursive:true,force:true})}
}
const profile={host:'grok' as const,actorId:'grok-wire',modelRequest:'host-default',effortRequest:'high',roles:['reviewer' as const]};
test('2025 task wire projections use durable actor-scoped bridge, no task-content leak',()=>fixture(async m=>{
 await m.setProfile('gpt-a',profile,0);
 const task=await m.taskBridgeArm('grok','2025-11-25',60);
 const before=await m.wireTaskGet('grok',task.taskId,'2025-11-25');
 assert.equal(before.status,'working');
 assert.equal(before.ttlMs,60000);
 await assert.rejects(m.wireTaskGet('claude',task.taskId,'2025-11-25'),/not found/);
 await assert.rejects(m.wireTaskGet('gpt-a',task.taskId,'2025-11-25'),/Only workers/);
 await assert.rejects(m.wireTaskGet('grok',task.taskId,'2026-07-28'),/not found/);
 const w=await m.delegate('gpt-a',{missionId:'w',target:'grok',role:'reviewer',
   instruction:'private task payload',idempotencyKey:'one'});
 const delivered=await m.wireTaskGet('grok',task.taskId,'2025-11-25');
 assert.equal(delivered.status,'completed');
 assert.equal(delivered.workId,w.id);
 assert.ok(!JSON.stringify(delivered).includes('private task payload'));
 const listed=await m.wireTaskList('grok','2025-11-25');
 assert.deepEqual(listed.taskIds,[task.taskId]);
 assert.deepEqual((await m.wireTaskList('claude','2025-11-25')).taskIds,[]);
 await assert.rejects(m.wireTaskList('grok','2025-11-25','00000000-0000-4000-8000-000000000001'),/Invalid task cursor/);
}));
test('cancel is actor-bound and does not cancel or claim authoritative delegated work',()=>fixture(async m=>{
 await m.setProfile('gpt-a',profile,0);
 const task=await m.taskBridgeArm('grok','2026-07-28',60);
 const w=await m.delegate('gpt-a',{missionId:'w',target:'grok',role:'reviewer',
   instruction:'audit',idempotencyKey:'one'});
 await assert.rejects(m.taskBridgeCancel('claude',task.taskId),/not found/);
 await m.taskBridgeCancel('grok',task.taskId);
 assert.equal((await m.wireTaskGet('grok',task.taskId,'2026-07-28')).status,'cancelled');
 assert.equal((await m.pending('grok'))[0]!.workId,w.id);
}));
test('SDK provides explicit custom method registration without Tasks capability claims',async()=>{
 const server = new McpServer({name:'wire-isolation',version:'1.0.0'});
 const dir=await mkdtemp(join(tmpdir(),'panter-wire-sdk-'));
 try{
  const m=await MeshEngine.open(dir);
  registerTaskWire(server,m,()=> 'grok','legacy');
  assert.equal(server.server.getCapabilities().tasks,undefined);
  assert.ok(server.server);
 }finally{await rm(dir,{recursive:true,force:true})}
});
