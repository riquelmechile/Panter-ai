import assert from 'node:assert/strict';
import {test} from 'node:test';
import {ClaudeRoutineWake} from '../src/core/claude-routine-wake.js';

const endpoint='https://api.anthropic.com/v1/claude_code/routines/trig_test1234567890/fire';
const token='sk-ant-oat01-'+'x'.repeat(48);
const id='00000000-0000-4000-8000-000000000001';
const success={status:200,body:{type:'routine_fire',claude_code_session_id:'session_01HJKLMNOPQRSTUVWXYZ',
 claude_code_session_url:'https://claude.ai/code/session/session_01HJKLMNOPQRSTUVWXYZ'}};
test('Claude disabled has no outgoing network',async()=>{
 let calls=0;const x=new ClaudeRoutineWake('','',async()=>{calls++;return success});
 assert.equal((await x.dispatch(id)).state,'DELIVERY_ONLY');
 assert.equal(calls,0);
});
test('Claude Code subscription Routine sends pointer-only text and native headers',async()=>{
 const calls:Array<{url:string;body:string;headers:Record<string,string>}>=[];
 const x=new ClaudeRoutineWake(endpoint,token,async(url,body,headers)=>{
   calls.push({url,body,headers});return success;
 });
 const result=await x.dispatch(id);
 assert.equal(result.accepted,true);
 assert.equal(result.sessionId,'session_01HJKLMNOPQRSTUVWXYZ');
 assert.equal(calls.length,1);
 assert.equal(calls[0]!.url,endpoint);
 assert.equal(calls[0]!.headers.authorization,'Bearer '+token);
 assert.equal(calls[0]!.headers['anthropic-version'],'2026-10-21');
 assert.deepEqual(JSON.parse(JSON.parse(calls[0]!.body).text),
  {source:'panter-ai',event:'workforce_task_ready',work_id:id});
 assert.ok(!calls[0]!.body.includes('instruction'));
 assert.ok(!JSON.stringify(x.describe()).includes(token));
});
test('Claude fire HTTP accepted but missing session receipt is NOT accepted',async()=>{
 for(const bad of [
   {status:200},{status:200,body:{type:'routine_fire'}},
   {status:200,body:{type:'success',claude_code_session_id:'session_abcdefghijklmnopqrst'}},
   ...[301,302,400,401,403,429,500,503].map(status=>({status}))
 ]){
   const x=new ClaudeRoutineWake(endpoint,token,async()=>bad);
   const r=await x.dispatch(id);
   assert.equal(r.accepted,false);
   assert.equal(r.state,'SIGNAL_FAILED');
 }
 const x=new ClaudeRoutineWake(endpoint,token,async()=>{throw Error(token)});
 const r=await x.dispatch(id);assert.equal(r.state,'SIGNAL_FAILED');
 assert.ok(!JSON.stringify(r).includes(token));
});
test('Claude tokens never sent to operator-chosen hosts, paths, userinfo or query URLs',async()=>{
 const bad=['http://api.anthropic.com/v1/claude_code/routines/trig_12345678/fire',
  'https://127.0.0.1/v1/claude_code/routines/trig_12345678/fire',
  'https://api.anthropic.com.evil.org/v1/claude_code/routines/trig_12345678/fire',
  'https://operator:pass@api.anthropic.com/v1/claude_code/routines/trig_12345678/fire',
  'https://api.anthropic.com:8443/v1/claude_code/routines/trig_12345678/fire',
  'https://api.anthropic.com/v1/claude_code/routines/trig_12345678/fire?q=1',
  'https://api.anthropic.com/v1/messages',
  'https://api.anthropic.com/v1/claude_code/routines/trig_12345678/fire#frag'];
 for(const url of bad)assert.throws(()=>new ClaudeRoutineWake(url,token),/official Anthropic/);
 assert.throws(()=>new ClaudeRoutineWake(endpoint,''),/URL and token/);
 assert.throws(()=>new ClaudeRoutineWake(endpoint,'sk-ant-api03-key'),/per-routine/);
 const wake=new ClaudeRoutineWake(endpoint,token,async()=>success);
 await assert.rejects(wake.dispatch('invalid'),/work ID/);
});
