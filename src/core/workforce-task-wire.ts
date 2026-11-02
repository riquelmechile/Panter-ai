/** Official MCP SDK explicit-schema Tasks method adapters.
 * Operates only on actor-owned durable listener handles, not inferred client wake.
 * Neither Tasks v1 creation nor v2 extension task creation is claimed.
 */
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { MeshEngine, Host } from './mesh.js';

type BridgeTask = Awaited<ReturnType<MeshEngine['wireTaskGet']>>;
const taskIdSchema=z.object({taskId:z.string().uuid()}).strict();
const stateSchema=z.enum(['working','completed','cancelled','failed']);
const v1TaskSchema=z.object({
 taskId:z.string(),status:stateSchema,createdAt:z.string(),lastUpdatedAt:z.string(),
 ttl:z.number().int().nonnegative().nullable(),pollInterval:z.number().int().nonnegative().optional()
}).passthrough();
const v2TaskSchema=z.object({
 taskId:z.string(),status:stateSchema,createdAt:z.string(),lastUpdatedAt:z.string(),
 ttlMs:z.number().int().nonnegative().nullable(),pollIntervalMs:z.number().int().nonnegative().optional()
}).passthrough();

function legacy(t:BridgeTask):z.output<typeof v1TaskSchema>{
 return {taskId:t.taskId,status:t.status,createdAt:t.createdAt,lastUpdatedAt:t.lastUpdatedAt,
  ttl:t.ttlMs,pollInterval:t.pollIntervalMs};
}
function modern(t:BridgeTask):z.output<typeof v2TaskSchema>{
 const base={taskId:t.taskId,status:t.status,createdAt:t.createdAt,
  lastUpdatedAt:t.lastUpdatedAt,ttlMs:t.ttlMs,pollIntervalMs:t.pollIntervalMs};
 if(t.status==='completed')return {...base,result:{
   content:[{type:'text',text:JSON.stringify({status:t.workId?'CANDIDATE':'CONSUMED',workId:t.workId})}]
 }};
 if(t.status==='failed')return {...base,error:{code:-32000,message:'Listener expired'}};
 return base;
}
export function registerTaskWire(server:McpServer,mesh:MeshEngine,actor:()=>Host,mode:'legacy'|'modern'){
 if(mode==='modern'){
   // Extension method interoperability, but *not* the full 2026 Tasks extension.
   server.server.setRequestHandler('tasks/get',
     {params:taskIdSchema,result:v2TaskSchema},
     async params=>modern(await mesh.wireTaskGet(actor(),params.taskId,'2026-07-28')));
   server.server.setRequestHandler('tasks/cancel',
     {params:taskIdSchema,result:z.object({}).passthrough()},
     async params=>{
       await mesh.wireTaskGet(actor(),params.taskId,'2026-07-28');
       await mesh.taskBridgeCancel(actor(),params.taskId);
       return {};
     });
   return;
 }
 server.server.setRequestHandler('tasks/get',
   {params:taskIdSchema,result:v1TaskSchema},
   async params=>legacy(await mesh.wireTaskGet(actor(),params.taskId,'2025-11-25')));
 server.server.setRequestHandler('tasks/cancel',
   {params:taskIdSchema,result:v1TaskSchema},
   async params=>{
     await mesh.wireTaskGet(actor(),params.taskId,'2025-11-25');
     await mesh.taskBridgeCancel(actor(),params.taskId);
     return legacy(await mesh.wireTaskGet(actor(),params.taskId,'2025-11-25'));
   });
 server.server.setRequestHandler('tasks/list',{
   params:z.object({cursor:z.string().uuid().optional()}).passthrough(),
   result:z.object({tasks:z.array(v1TaskSchema),nextCursor:z.string().optional()}).passthrough()
 },async params=>{
   const list=await mesh.wireTaskList(actor(),'2025-11-25',params.cursor);
   const tasks=await Promise.all(list.taskIds.map(id=>mesh.wireTaskGet(actor(),id,'2025-11-25')));
   return {tasks:tasks.map(legacy),...(list.nextCursor?{nextCursor:list.nextCursor}:{})};
 });
 server.server.setRequestHandler('tasks/result',{
   params:taskIdSchema,
   result:z.object({content:z.array(z.object({type:z.literal('text'),text:z.string()}))}).passthrough()
 },async params=>{
   const task=await mesh.wireTaskGet(actor(),params.taskId,'2025-11-25');
   if(task.status!=='completed')throw Error('Task result is not complete');
   return {content:[{type:'text' as const,text:JSON.stringify({
     status:task.workId?'CANDIDATE':'CONSUMED',workId:task.workId})}]};
 });
}
