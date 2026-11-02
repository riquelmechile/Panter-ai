/** Native MCP task operation handlers, using official SDK custom method schemas.
 * This is *wire-level get/cancel/list/result* for durable listener handles.
 * It DOES NOT enable the 2026 Tasks extension or replace core tools/call.
 */
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { MeshEngine, Host } from './mesh.js';

const idSchema = z.object({taskId:z.string().uuid()}).strict();
const statusSchema = z.enum(['working','completed','cancelled','failed']);
const base2025 = z.object({taskId:z.string(),status:statusSchema,createdAt:z.string(),
  lastUpdatedAt:z.string(),ttl:z.number().int().nonnegative().nullable(),
  pollInterval:z.number().int().nonnegative().optional()}).passthrough();
const base2026 = z.object({taskId:z.string(),status:statusSchema,createdAt:z.string(),
  lastUpdatedAt:z.string(),ttlMs:z.number().int().nonnegative().nullable(),
  pollIntervalMs:z.number().int().nonnegative().optional()}).passthrough();
const wireTask = (task: Awaited<ReturnType<MeshEngine['wireTaskGet']>>, era:'2025-11-25'|'2026-07-28') => {
  const common={taskId:task.taskId,status:task.status,createdAt:task.createdAt,
    lastUpdatedAt:task.lastUpdatedAt};
  if(era==='2025-11-25')return {...common,ttl:task.ttlMs,pollInterval:task.pollIntervalMs};
  const base={...common,ttlMs:task.ttlMs,pollIntervalMs:task.pollIntervalMs};
  if(task.status==='completed') return {...base,result:{
    content:[{type:'text',text:JSON.stringify({status:task.workId?'CANDIDATE':'CONSUMED',workId:task.workId})}]
  }};
  if(task.status==='failed')return {...base,error:{code:-32000,message:'Listener expired'}};
  return base;
};
export function registerTaskWire(server:McpServer,mesh:MeshEngine,actor:()=>Host,mode:'legacy'|'modern'){
  const era=mode==='modern'?'2026-07-28':'2025-11-25';
  server.server.setRequestHandler('tasks/get',
    {params:idSchema,result:mode==='modern'?base2026:base2025},
    async params => wireTask(await mesh.wireTaskGet(actor(),params.taskId,era),era));
  server.server.setRequestHandler('tasks/cancel',
    {params:idSchema,result:mode==='modern'?z.object({}).passthrough():base2025},
    async params => {
      // Access validated in the same durable ledger before mutating listener only.
      await mesh.wireTaskGet(actor(),params.taskId,era);
      await mesh.taskBridgeCancel(actor(),params.taskId);
      if(mode==='modern')return {};
      return wireTask(await mesh.wireTaskGet(actor(),params.taskId,era),era);
    });
  if(mode==='legacy'){
    server.server.setRequestHandler('tasks/list',{
      params:z.object({cursor:z.string().uuid().optional()}).passthrough(),
      result:z.object({tasks:z.array(base2025),nextCursor:z.string().optional()}).passthrough()
    },async params=>{
      const listing=await mesh.wireTaskList(actor(),era,params.cursor);
      const tasks=await Promise.all(listing.taskIds.map(id=>mesh.wireTaskGet(actor(),id,era)));
      return {tasks:tasks.map(t=>wireTask(t,era)),...(listing.nextCursor?{nextCursor:listing.nextCursor}:{})};
    });
    server.server.setRequestHandler('tasks/result',{
      params:idSchema,result:z.object({content:z.array(z.object({type:z.literal('text'),text:z.string()}))}).passthrough()
    },async params=>{
      const task=await mesh.wireTaskGet(actor(),params.taskId,era);
      if(task.status!=='completed')throw Error('Task result is not complete');
      return {content:[{type:'text' as const,text:JSON.stringify({
        status:task.workId?'CANDIDATE':'CONSUMED',workId:task.workId})}]};
    });
  }
}
