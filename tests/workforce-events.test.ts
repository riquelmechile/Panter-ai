import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {WorkforceEvents,WORK_EVENT,publicIp,validCallback,webhookHeaders,pinnedAddressLookup,reconcileWorkforceEventOutbox,
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
  assert.deepEqual(e.list('gpt-a'),{events:[]});
  const catalog=e.list('gpt-b').events[0]!;
  assert.equal(catalog.name,WORK_EVENT);
  assert.deepEqual(Object.keys(catalog.payloadSchema.properties),['workId']);
  assert.equal(e.hasActive('gpt-b'),false);
  await assert.rejects(e.subscribe('gpt-a',args),/Only GPT-B or Gemini/);
  await assert.rejects(e.subscribe('gpt-b',{...args,arguments:{host:'gpt-a'}}),/Event filter must match authenticated actor/);
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
  assert.equal(engine.queue('gpt-b',[workId,workId]),1);
  assert.equal(engine.queue('gpt-b',[workId]),0);
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
  assert.equal(restored.queue('gpt-b',['00000000-0000-4000-8000-000000000002']),0);
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
  engine.queue('gpt-b',[workId]);
  assert.equal(await engine.flush(),1);
  assert.equal(calls,1);
  assert.equal(engine.status('gpt-a').accepted,0);
  assert.equal(engine.status('gpt-a').pending,1);
  // Bounded backoff; no immediate duplicate call.
  assert.equal(await engine.flush(),0);
  assert.equal(calls,1);
}));


test('Gemini and GPT-B callbacks are separate OAuth actor subscriptions, not aliases',()=>fixture(async dir=>{
  const received: Array<{subscriber:string;workId:string}>=[];
  const post:EventPost=async(_url,headers,body)=>{
    const parsed=JSON.parse(body) as {type?:string;challenge?:string;data?:{workId:string}};
    if(parsed.type==='verification')
      return {status:200,body:JSON.stringify({challenge:parsed.challenge})};
    received.push({subscriber:headers['X-MCP-Subscription-Id']!,workId:parsed.data!.workId});
    return {status:200,body:''};
  };
  const engine=new WorkforceEvents(dir,post);
  const chat=await engine.subscribe('gpt-b',args);
  const gemini=await engine.subscribe('gemini',{...args,arguments:{host:'gemini'}});
  assert.notEqual(chat.id,gemini.id);
  assert.equal(engine.list('gemini').events[0]!.inputSchema.properties.host.enum[0],'gemini');
  await assert.rejects(engine.subscribe('gemini',args),/Event filter must match/);
  assert.equal(engine.queue('gemini',[workId]),1);
  await engine.flush();
  assert.deepEqual(received,[{subscriber:gemini.id,workId}]);
  assert.equal(engine.queue('gpt-b',[workId]),1);
  await engine.flush();
  assert.deepEqual(received.map(x=>x.subscriber),[gemini.id,chat.id]);
  assert.equal(engine.status('gpt-a').hosts.length,2);
}));

test('pinned TLS lookup honors both Node address-family callback modes',async()=>{
  const pinned=pinnedAddressLookup('2606:4700:4700::1111',6);
  const all=await new Promise<unknown>((resolve,reject)=>{
    pinned('events.example.org',{all:true},(error,result)=>{
      if(error)reject(error);else resolve(result);
    });
  });
  assert.deepEqual(all,[{address:'2606:4700:4700::1111',family:6}]);
  const single=await new Promise<unknown>((resolve,reject)=>{
    pinned('events.example.org',{all:false},(error,result,family)=>{
      if(error)reject(error);else resolve({result,family});
    });
  });
  assert.deepEqual(single,{result:'2606:4700:4700::1111',family:6});
});

test('lifetime webhook successes cannot exhaust the active backlog limit',()=>fixture(async dir=>{
  const post:EventPost=async(_url,_headers,body)=>{
    const payload=JSON.parse(body) as {type?:string;challenge?:string};
    return payload.type==='verification'
      ?{status:200,body:JSON.stringify({challenge:payload.challenge})}
      :{status:204,body:''};
  };
  const events=new WorkforceEvents(dir,post);
  const sub=await events.subscribe('gpt-b',args);
  const {SqliteLedger}=await import('../src/core/sqlite-ledger.js');
  const ledger=SqliteLedger.open(dir);
  const old=Date.now()-10_000;
  const historic=Array.from({length:2150},(_,i)=>({
    id:'evt_historical_'+i,subId:sub.id,
    workId:'00000000-0000-4000-8000-'+String(i+100).padStart(12,'0'),
    state:'ACCEPTED' as const,attempts:1,nextAt:old,
    lastStatus:204,terminalAt:old
  }));
  const seed:any={version:1,subscriptions:[],deliveries:[]};
  ledger.mutate('events',seed,(data:any)=>{data.deliveries.push(...historic);});
  assert.equal(events.queue('gpt-b',[workId]),1);
  assert.equal(events.queue('gpt-b',[workId]),0);
  assert.ok(events.status('gpt-a').accepted<=2000);
  assert.equal(await events.flush(),1);
  assert.equal(events.queue('gpt-b',[workId]),0,
    'terminal dedup remains while corresponding work is still queued');
  assert.equal(events.status('gpt-a').pending,0);
}));


test('reconcile drains existing deliveries despite another host enqueue failure',async()=>{
  let flushCount=0;
  const called:string[]=[];
  const result=await reconcileWorkforceEventOutbox(['gpt-b','gemini'],
    async host=>[{workId:host==='gpt-b'?workId:'00000000-0000-4000-8000-000000000002'}],
    {
      queue:(host)=>{
        called.push(host);
        if(host==='gpt-b')throw Error('MCP event backlog limit reached');
        return 1;
      },
      flush:async()=>{flushCount++;return 1;}
    });
  assert.deepEqual(called,['gpt-b','gemini']);
  assert.deepEqual(result,{enqueueFailures:1,flushed:1});
  assert.equal(flushCount,1);
});

test('renewed subscription retries expiration-failed events for still-queued work',()=>fixture(async dir=>{
  let deliveries=0,verifications=0;
  const post:EventPost=async(_url,_headers,body)=>{
    const payload=JSON.parse(body) as {type?:string;challenge?:string};
    if(payload.type==='verification'){
      verifications++;
      return {status:200,body:JSON.stringify({challenge:payload.challenge})};
    }
    deliveries++;
    return {status:204,body:''};
  };
  const engine=new WorkforceEvents(dir,post);
  await engine.subscribe('gpt-b',args);
  assert.equal(engine.queue('gpt-b',[workId]),1);
  const {SqliteLedger}=await import('../src/core/sqlite-ledger.js');
  const ledger=SqliteLedger.open(dir);
  const seed:any={version:1,subscriptions:[],deliveries:[]};
  ledger.mutate('events',seed,(d:any)=>{
    const sub=d.subscriptions.find((x:any)=>x.owner==='gpt-b');
    sub.expiresAt=new Date(Date.now()-60_000).toISOString();
  });
  assert.equal(await engine.flush(),0);
  assert.equal(engine.status('gpt-a').failed,1);
  assert.equal(deliveries,0);
  await engine.subscribe('gpt-b',args);
  assert.equal(verifications,2);
  assert.equal(engine.queue('gpt-b',[workId]),1);
  assert.equal(engine.queue('gpt-b',[workId]),0);
  assert.equal(await engine.flush(),1);
  assert.equal(deliveries,1);
  assert.equal(engine.queue('gpt-b',[workId]),0);
}));
