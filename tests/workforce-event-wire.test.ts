import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {McpServer} from '@modelcontextprotocol/server';
import {MeshEngine} from '../src/core/mesh.js';
import {WorkforceEvents} from '../src/core/workforce-events.js';
import {registerWorkforceEventWire,subscribeWorkEvents} from '../src/core/workforce-event-wire.js';
import {WORK_EVENT,type EventPost} from '../src/core/workforce-events.js';

test('MCP 2025/2026 server advertises native events at top level (not a tool)',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'panter-event-wire-sdk-'));
  try{
    for(const host of ['gpt-b','gemini'] as const){
      const server=new McpServer({name:'panter-events-test',version:'1'},{
        capabilities:{resources:{subscribe:true},events:{}} as any
      });
      const mesh=await MeshEngine.open(dir);
      const events=new WorkforceEvents(dir,async()=>({status:200,body:'{}'}));
      registerWorkforceEventWire(server,events,()=>host,mesh);
      const capabilities=server.server.getCapabilities() as Record<string,unknown>;
      assert.ok(capabilities.events,'native events must be advertised for Work discovery');
      assert.equal(events.list(host).events[0]!.inputSchema.properties.host.enum[0],host);
      assert.equal(events.hasActive(host),false,'a capability is not a subscription');
    }
  }finally{await rm(dir,{recursive:true,force:true})}
});

test('a connection revoked while its subscribe request was in flight keeps no subscription',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'panter-event-wire-revoke-'));
  try{
    const verify:EventPost=async(_u,_h,b)=>{const x=JSON.parse(b) as {challenge?:string};return {status:200,body:JSON.stringify({challenge:x.challenge})};};
    const events=new WorkforceEvents(dir,verify);
    const mesh=await MeshEngine.open(dir);
    const input={name:WORK_EVENT,arguments:{host:'gpt-b'},delivery:{mode:'webhook',
      url:'https://connectors.api.openai.com/mcp-events/wire-revoke',secret:'whsec_'+Buffer.alloc(32,9).toString('base64')}} as const;
    await assert.rejects(subscribeWorkEvents(events,mesh,'gpt-b',input as any,async()=>false),/revoked during subscription/);
    assert.equal(events.hasActive('gpt-b'),false);
    const ok=await subscribeWorkEvents(events,mesh,'gpt-b',input as any,async()=>true);
    assert.ok(ok.id);
    assert.equal(events.hasActive('gpt-b'),true);
  }finally{await rm(dir,{recursive:true,force:true})}
});
