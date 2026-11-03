import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {WorkforceEvents,WORK_EVENT,publicIp,validCallback,webhookHeaders,
  type EventPost} from '../src/core/workforce-events.js';

const callback='https://connectors.api.openai.com/mcp-events/test-callback';
const secret='whsec_'+Buffer.alloc(32,7).toString('base64');
const workId='00000000-0000-4000-8000-000000000001';
const args={name:WORK_EVENT,arguments:{host:'gpt-b'},delivery:{mode:'webhook',url:callback,secret}};
const fixture=async(fn:(dir:string)=>Promise<void>)=>{
  const dir=await mkdtemp(join(tmpdir(),'panter-mcp-events-'));
  try{await fn(dir)}finally{await rm(dir,{recursive:true,force:true})}
};

test('native MCP events are GPT-B actor-bound and advertise only opaque pointer',()=>fixture(async dir=>{
  const e=new WorkforceEvents(dir,async()=>({status:200,body:'{}'}));
  assert.throws(()=>e.list('gpt-a'),/GPT-B OAuth/);
  const catalog=e.list('gpt-b').events[0]!;
  assert.equal(catalog.name,WORK_EVENT);
  assert.deepEqual(Object.keys(catalog.payloadSchema.properties),['workId']);
  assert.equal(e.hasActive('gpt-b'),false);
  await assert.rejects(e.subscribe('gemini',args),/GPT-B OAuth/);
  await assert.rejects(e.subscribe('gpt-b',{...args,arguments:{host:'gpt-a'}}),/Only GPT-B/);
}));

test('callback validation rejects private, loopback, credentials, redirects and non-HTTPS',()=>{
  const bad=[
    'http://connectors.api.openai.com/callback',
    'https://127.0.0.1/callback',
    'https://[::1]/callback',
    'https://localhost/callback',
    'https://api.local/callback',
    'https://api.internal/callback',
    'https://user:secret@connectors.api.openai.com/callback',
    'https://connectors.api.openai.com:444/callback',
    'https://connectors.api.openai.com/callback#frag',
  ];
  for(const url of bad)assert.throws(()=>validCallback(url),/public HTTPS|Invalid/);
  for(const ip of ['127.0.0.1','10.0.0.1','169.254.169.254',
    '192.168.1.3','100.64.1.2','::1','fc00::1','2001:db8::1'])
    assert.equal(publicIp(ip),false,ip);
  for(const ip of ['8.8.8.8','1.1.1.1','2606:4700:4700::1111'])
    assert.equal(publicIp(ip),true,ip);
  assert.equal(validCallback(callback).toString(),callback);
});

test('subscription verifies challenge, signs Standard Webhooks, deduplicates delivery, and unsubscribes',()=>fixture(async dir=>{
  let verificationCount=0;
  const received: Array<{body:unknown;headers:Record<string,string>}> = [];
  const post:EventPost=async(url,headers,body)=>{
    assert.equal(url,callback);
    assert.deepEqual(headers,webhookHeaders(secret,headers['webhook-id']!,
      headers['X-MCP-Subscription-Id']!,body,Number(headers['webhook-timestamp'])));
    assert.ok(!JSON.stringify(headers).includes('whsec_'));
    const parsed=JSON.parse(body) as {type?:string;challenge?:string;data?:{workId:string}};
    if(parsed.type==='verification'){
      verificationCount++;
      return {status:200,body:JSON.stringify({challenge:parsed.challenge})};
    }
    received.push({body:parsed,headers});
    return {status:204,body:''};
  };
  const engine=new WorkforceEvents(dir,post);
  const sub=await engine.subscribe('gpt-b',args);
  assert.equal(engine.hasActive('gpt-b'),true);
  assert.ok(sub.id.startsWith('sub_'));
  assert.equal(verificationCount,1);
  const again=await engine.subscribe('gpt-b',args);
  assert.equal(again.id,sub.id);
  assert.equal(verificationCount,1,'refresh should not cause needless callback challenge');
  assert.equal(engine.queue([workId,workId]),1);
  assert.equal(engine.queue([workId]),0);
  assert.equal(await engine.flush(),1);
  assert.equal(engine.status('gpt-a').accepted,1);
  assert.equal(await engine.flush(),0);
  assert.equal(received.length,1);
  const event=received[0]!.body as {name:string;data:{workId:string};eventId:string};
  assert.equal(event.name,WORK_EVENT);
  assert.deepEqual(event.data,{workId});
  assert.equal(received[0]!.headers['webhook-id'],event.eventId);
  const restored=new WorkforceEvents(dir,post);
  assert.equal(restored.hasActive('gpt-b'),true);
  assert.equal(restored.status('gpt-a').accepted,1);
  assert.deepEqual(restored.unsubscribe('gpt-b',{
    name:WORK_EVENT,arguments:{host:'gpt-b'},delivery:{url:callback}}),{});
  assert.equal(restored.hasActive('gpt-b'),false);
  assert.equal(restored.queue(['00000000-0000-4000-8000-000000000002']),0);
  assert.equal(await restored.flush(),0);
  assert.throws(()=>restored.status('gpt-b'),/Only GPT-A/);
}));

test('verification fails closed for wrong or unconfirmed callback; no subscription',()=>fixture(async dir=>{
  const bad=new WorkforceEvents(dir,async()=>({status:200,body:JSON.stringify({challenge:'wrong'})}));
  await assert.rejects(bad.subscribe('gpt-b',args),/challenge_failed/);
  assert.equal(bad.hasActive('gpt-b'),false);
  const fail=new WorkforceEvents(dir,async()=>({status:403,body:''}));
  await assert.rejects(fail.subscribe('gpt-b',args),/CallbackEndpointError/);
  assert.equal(fail.hasActive('gpt-b'),false);
  const malformed=new WorkforceEvents(dir,async()=>({status:200,body:'nope'}));
  await assert.rejects(malformed.subscribe('gpt-b',args),/verification response/);
  for(const s of ['whsec_ABC','whsec_$$$','sk-ant-api-key','whsec_'+randomBytes(8).toString('base64')])
    await assert.rejects(bad.subscribe('gpt-b',{...args,delivery:{...args.delivery,secret:s}}),
      /signing secret/);
}));

test('transient delivery attempts preserve event ID and never falsely record a completed host task',()=>fixture(async dir=>{
  let calls=0;let observedId='';
  const post:EventPost=async(_u,_h,b)=>{
    const body=JSON.parse(b) as {type?:string;challenge?:string;eventId?:string};
    if(body.type==='verification')return {status:200,body:JSON.stringify({challenge:body.challenge})};
    calls++;if(!observedId)observedId=body.eventId!;
    assert.equal(body.eventId,observedId);
    return {status:503,body:''};
  };
  const engine=new WorkforceEvents(dir,post);
  await engine.subscribe('gpt-b',args);
  engine.queue([workId]);
  assert.equal(await engine.flush(),1);
  assert.equal(calls,1);
  assert.equal(engine.status('gpt-a').accepted,0);
  assert.equal(engine.status('gpt-a').pending,1);
  // Bounded backoff; no immediate duplicate call.
  assert.equal(await engine.flush(),0);
  assert.equal(calls,1);
}));
