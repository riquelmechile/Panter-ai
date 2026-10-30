import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EngramMemory, type EngramClient } from '../src/core/engram-memory.js';

function fake() {
  const calls: Array<{name:string;arguments:Record<string, unknown>}> = [];
  let opens=0, closes=0, fail=false;
  const memory=new EngramMemory({project:'panter-ai',openClient:async()=>{
    opens++;
    const client:EngramClient={
      async callTool(req) { calls.push(req); return fail?{isError:true,content:[{type:'text',text:'rejected'}]}:{content:[{type:'text',text:'{}'}]}; },
      async close(){closes++;}
    };return client;
  }});
  return {memory,calls,get opens(){return opens},get closes(){return closes},setError(b:boolean){fail=b}};
}

test('only GPT-A accesses curated memory; no worker can write or read',async()=>{
  const x=fake();
  await assert.rejects(x.memory.context('grok'),/Only GPT-A/);
  await assert.rejects(x.memory.search('claude','auth'),/Only GPT-A/);
  await assert.rejects(x.memory.save('gpt-b',{title:'a',type:'decision',topicKey:'a',content:'bad'}),/Only GPT-A/);
  assert.equal(x.opens,0);
});

test('search and context are strictly project-scoped with bounded output',async()=>{
  const x=fake();
  await x.memory.search('gpt-a','oauth security',5);
  await x.memory.context('gpt-a',8192);
  assert.equal(x.opens,1);
  assert.deepEqual(x.calls[0],{name:'mem_search',arguments:{query:'oauth security',project:'panter-ai',scope:'project',limit:5}});
  assert.deepEqual(x.calls[1],{name:'mem_context',arguments:{project:'panter-ai',scope:'project',compact:true,max_bytes:8192}});
  assert.throws(()=>x.memory.search('gpt-a','q',50),/Invalid search limit/);
  assert.throws(()=>x.memory.context('gpt-a',1000000),/Invalid memory budget/);
});

test('saves require canonical topic and omit automatic prompt capture',async()=>{
  const x=fake();
  const input={title:'Chosen auth design',type:'architecture' as const,topicKey:'architecture/oauth',content:'**What**: Built-in consent.\n**Why**: No external provider.\n**Where**: src/core.\n**Learned**: verify token audience.'};
  await x.memory.save('gpt-a',input);
  const req=x.calls[0]!;
  assert.equal(req.name,'mem_save');
  assert.equal(req.arguments.capture_prompt,false);
  assert.equal(req.arguments.project,'panter-ai');
  assert.equal(req.arguments.topic_key,'architecture/oauth');
  assert.throws(()=>x.memory.save('gpt-a',{...input,topicKey:'../other'}),/Invalid topic/);
  assert.throws(()=>x.memory.save('gpt-a',{...input,content:'-----BEGIN PRIVATE KEY----- secret'}),/Credential material/);
  await x.memory.close(); assert.equal(x.closes,1);
});

test('backend errors are surfaced without claiming a successful save',async()=>{
  const x=fake();x.setError(true);
  await assert.rejects(x.memory.save('gpt-a',{title:'Decision',type:'decision',topicKey:'decision/a',content:'No change'}),/Engram mem_save failed/);
  assert.equal(x.opens,1);
});
