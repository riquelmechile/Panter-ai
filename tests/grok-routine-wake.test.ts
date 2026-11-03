import assert from 'node:assert/strict';
import {test} from 'node:test';
import {GrokRoutineWake} from '../src/core/grok-routine-wake.js';

const endpoint='https://wake.grok.example.org/routine';
const secret='crsr_'+'X'.repeat(48);
test('no Grok route sends no signal or network call',async()=>{
  let calls=0;
  const wake=new GrokRoutineWake('','',async()=>{calls++;return 200});
  const result=await wake.dispatch('00000000-0000-4000-8000-000000000001');
  assert.equal(result.attempted,false);
  assert.equal(result.state,'DELIVERY_ONLY');
  assert.equal(calls,0);
});
test('Grok native POST uses Bearer and an opaque work ID, no prompt or results',async()=>{
  const calls:Array<{url:string;body:string;headers:Record<string,string>}>=[];
  const wake=new GrokRoutineWake(endpoint,secret,async(url,body,headers)=>{
    calls.push({url,body,headers});return 200;
  });
  const id='00000000-0000-4000-8000-000000000001';
  const result=await wake.dispatch(id);
  assert.equal(result.state,'SIGNAL_ACCEPTED');
  assert.equal(result.accepted,true);
  assert.equal(calls.length,1);
  const sent=calls[0]!;
  assert.equal(sent.url,endpoint);
  assert.equal(sent.headers.authorization,'Bearer '+secret);
  assert.deepEqual(JSON.parse(sent.body),{source:'panter-ai',event:'workforce_task_ready',work_id:id});
  assert.equal(JSON.stringify(wake.describe()).includes(secret),false);
  assert.ok(!sent.body.includes('instruction'));
  assert.ok(!sent.body.includes('result'));
});
test('HTTP errors, redirects and timeouts never claim wake observed',async()=>{
  for(const code of [301,302,400,403,429,500,503]){
    const wake=new GrokRoutineWake(endpoint,secret,async()=>code);
    const r=await wake.dispatch('00000000-0000-4000-8000-000000000001');
    assert.equal(r.state,'SIGNAL_FAILED');
    assert.equal(r.accepted,false);
  }
  const fail=new GrokRoutineWake(endpoint,secret,async()=>{throw Error('secret leaked by network')});
  const r=await fail.dispatch('00000000-0000-4000-8000-000000000001');
  assert.equal(r.state,'SIGNAL_FAILED');
  assert.ok(!JSON.stringify(r).includes('secret'));
});
test('reject unsafe URLs, invalid keys and malformed work IDs before network',async()=>{
  const bad=['http://wake.grok.example.org','https://127.0.0.1/','https://localhost/',
    'https://metadata.google.internal/path','https://user:pw@wake.grok.example.org/',
    'https://wake.grok.example.org:8443/'];
  for(const url of bad)assert.throws(()=>new GrokRoutineWake(url,secret),/public HTTPS/);
  assert.throws(()=>new GrokRoutineWake(endpoint,''),/both URL and key/);
  assert.throws(()=>new GrokRoutineWake(endpoint,'bearer-incorrect'),/crsr_/);
  const wake=new GrokRoutineWake(endpoint,secret,async()=>200);
  await assert.rejects(wake.dispatch('not-a-uuid'),/Invalid work ID/);
});
