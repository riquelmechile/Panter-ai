import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {McpServer} from '@modelcontextprotocol/server';
import {MeshEngine} from '../src/core/mesh.js';
import {WorkforceEvents} from '../src/core/workforce-events.js';
import {registerWorkforceEventWire} from '../src/core/workforce-event-wire.js';

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
