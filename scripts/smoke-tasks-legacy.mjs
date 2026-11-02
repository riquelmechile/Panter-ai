/** Official SDK legacy 2025-11-25 Task operation wire and actor isolation. */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {z} from 'zod/v4';
const dataDir=await mkdtemp(join(tmpdir(),'panter-tasks-2025-'));
const port=String(21000+Math.floor(Math.random()*18000));
const tokens={'gpt-a':'panter-legacy-a-token-unique-2025-123456789',
 'gemini':'panter-legacy-gemini-token-unique-2025-123456789'};
const proc=spawn(process.execPath,['dist/server.js'],{env:{...process.env,
 PANTER_PORT:port,PANTER_BIND_HOST:'127.0.0.1',
 PANTER_TOKEN:'panter-legacy-owner-token-unique-123456789',
 PANTER_PEER_TOKENS:JSON.stringify(tokens),PANTER_DATA_DIR:dataDir},
 stdio:['ignore','ignore','pipe']});
let stderr='';
proc.stderr.on('data',chunk=>stderr+=String(chunk));
const url=new URL('http://127.0.0.1:'+port+'/mcp');
const clients=[];
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function connect(host){
 const client=new Client({name:'panter-tasks-legacy-'+host,version:'1.0.0'},
   {versionNegotiation:{mode:{pin:'2025-11-25'}}});
 await client.connect(new StreamableHTTPClientTransport(url,{authProvider:{token:async()=>tokens[host]}}));
 clients.push(client);
 assert.equal(client.getProtocolEra(),'legacy');
 return client;
}
const unpack=result=>JSON.parse(result.content.find(x=>x.type==='text').text);
const taskSchema=z.object({taskId:z.string(),status:z.string(),ttl:z.number().nullable()}).passthrough();
try{
 let ready=false;
 for(let i=0;i<80;i++){
  if(proc.exitCode!==null)throw Error('server exited: '+stderr);
  try{if((await fetch('http://127.0.0.1:'+port+'/health')).ok){ready=true;break;}}catch{}
  await sleep(100);
 }
 assert.ok(ready,'server startup: '+stderr);
 const gpt=await connect('gpt-a');
 const gemini=await connect('gemini');
 const configured=await gpt.callTool({name:'panter_mesh_profile_set',arguments:{
   host:'gemini',actorId:'argon-4-test',modelRequest:'host-default',
   effortRequest:'high',roles:['reviewer'],expectedRevision:0}});
 assert.ok(!configured.isError);
 const arm=await gemini.callTool({name:'panter_workforce_task_bridge',arguments:{
   action:'arm',protocolEra:'2025-11-25',ttlSeconds:120}});
 assert.ok(!arm.isError);
 const taskId=unpack(arm).taskId;
 const pending=await gemini.request({method:'tasks/get',params:{taskId}},taskSchema);
 assert.equal(pending.status,'working');
 await assert.rejects(gpt.request({method:'tasks/get',params:{taskId}},taskSchema));
 const list=await gemini.request({method:'tasks/list',params:{}},
   z.object({tasks:z.array(taskSchema)}).passthrough());
 assert.equal(list.tasks.length,1);
 const delegated=await gpt.callTool({name:'panter_mesh_delegate',arguments:{
   missionId:'legacy-task-mission',target:'gemini',role:'reviewer',
   instruction:'Private internal analysis',idempotencyKey:'legacy-task-1'}});
 assert.ok(!delegated.isError);
 const work=unpack(delegated);
 const done=await gemini.request({method:'tasks/get',params:{taskId}},taskSchema);
 assert.equal(done.status,'completed');
 const payload=await gemini.request({method:'tasks/result',params:{taskId}},
   z.object({content:z.array(z.object({type:z.string(),text:z.string()}))}).passthrough());
 const pointer=JSON.parse(payload.content[0].text);
 assert.equal(pointer.workId,work.id);
 assert.ok(!JSON.stringify(payload).includes('Private internal analysis'));
 const cancelled=await gemini.request({method:'tasks/cancel',params:{taskId}},taskSchema);
 assert.equal(cancelled.status,'cancelled');
 assert.equal(unpack(await gemini.callTool({name:'panter_mesh_pending',arguments:{}}))[0].workId,work.id);
 console.log('PASS MCP 2025 Tasks get/list/result/cancel + OAuth actor isolation + durable Work unaffected');
}finally{
 for(const c of clients)await c.close().catch(()=>{});
 proc.kill('SIGTERM');
 await rm(dataDir,{recursive:true,force:true});
}
