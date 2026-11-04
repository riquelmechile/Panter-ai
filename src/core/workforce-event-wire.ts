/** MCP Events draft wire methods. These are native protocol methods,
 * not tools; host identity comes from Panter's authenticated OAuth principal.
 */
import type {McpServer} from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import {WORK_EVENT,WorkforceEvents} from './workforce-events.js';
import type {MeshEngine} from './mesh.js';
import {isAppEventHost} from './leadership.js';

const eventName=z.literal(WORK_EVENT);
const args=z.object({host:z.enum(['gpt-a','gpt-b','gemini'])}).strict();
const callback=z.object({mode:z.literal('webhook'),url:z.string().max(2048),
  secret:z.string().max(256)}).strict();
const unsubCallback=z.object({mode:z.literal('webhook').optional(),
  url:z.string().max(2048)}).strict();

type SubscribeInput=Parameters<WorkforceEvents['subscribe']>[1];
/** events/subscribe body. The bearer was checked when the request arrived; `stillAuthorized` re-checks
 *  it after the subscription is stored, so a connection revoked while its request was still in flight
 *  (slow body, slow callback verification) never keeps a subscription. */
export async function subscribeWorkEvents(events:Pick<WorkforceEvents,'subscribe'|'unsubscribe'|'queue'|'flush'>,
  mesh:Pick<MeshEngine,'pending'>,host:string,input:SubscribeInput,stillAuthorized:()=>Promise<boolean>){
  const result=await events.subscribe(host,input);
  if(!(await stillAuthorized())){
    events.unsubscribe(host,{name:input.name,arguments:input.arguments,delivery:{url:input.delivery.url}});
    throw Error('Connection revoked during subscription');
  }
  // The actor is the authenticated MCP principal, not the client-supplied filter.
  if(!isAppEventHost(host))throw Error('Unsupported event actor');
  const pending=await mesh.pending(host as Parameters<MeshEngine['pending']>[0]);
  events.queue(host as Parameters<WorkforceEvents['queue']>[0],pending.map(w=>w.workId));
  void events.flush().catch(()=>{/* durable retry queue remains */});
  return result;
}

export function registerWorkforceEventWire(server:McpServer,events:WorkforceEvents,
  actor:()=>string,mesh:MeshEngine,stillAuthorized:()=>Promise<boolean>=async()=>true){
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
  },async input=>subscribeWorkEvents(events,mesh,actor(),input,stillAuthorized));

  server.server.setRequestHandler('events/unsubscribe',{
    params:z.object({name:eventName,arguments:args,delivery:unsubCallback}).strict(),
    result:z.object({}).strict()
  },async input=>events.unsubscribe(actor(),input));
}
