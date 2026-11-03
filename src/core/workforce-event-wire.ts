/** MCP Events draft wire methods. These are native protocol methods,
 * not tools; host identity comes from Panter's authenticated OAuth principal.
 */
import type {McpServer} from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import {WORK_EVENT,WorkforceEvents} from './workforce-events.js';
import type {MeshEngine} from './mesh.js';

const eventName=z.literal(WORK_EVENT);
const args=z.object({host:z.literal('gpt-b')}).strict();
const callback=z.object({mode:z.literal('webhook'),url:z.string().max(2048),
  secret:z.string().max(256)}).strict();
const unsubCallback=z.object({mode:z.literal('webhook').optional(),
  url:z.string().max(2048)}).strict();

export function registerWorkforceEventWire(server:McpServer,events:WorkforceEvents,
  actor:()=>string,mesh:MeshEngine){
  server.server.setRequestHandler('events/list',{
    params:z.object({cursor:z.string().optional()}).passthrough().optional(),
    result:z.object({events:z.array(z.unknown())}).passthrough()
  },async()=>events.list(actor()));

  server.server.setRequestHandler('events/subscribe',{
    params:z.object({name:eventName,arguments:args,delivery:callback,
      cursor:z.string().nullable().optional(),
      ttlMs:z.number().int().nonnegative().nullable().optional()}).strict(),
    result:z.object({id:z.string(),refreshBefore:z.string().nullable(),
      cursor:z.null(),truncated:z.boolean()}).strict()
  },async input=>{
    const result=await events.subscribe(actor(),input);
    // This is an authenticated GPT-B subscription, not permission to execute.
    const pending=await mesh.pending('gpt-b');
    events.queue(pending.map(w=>w.workId));
    void events.flush().catch(()=>{/* durable retry queue remains */});
    return result;
  });

  server.server.setRequestHandler('events/unsubscribe',{
    params:z.object({name:eventName,arguments:args,delivery:unsubCallback}).strict(),
    result:z.object({}).strict()
  },async input=>events.unsubscribe(actor(),input));
}
