import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { parseRunnerIntent, InvalidRunnerIntent, runnerExecutionAvailable, RUNNER_MESSAGE_MAX_BYTES } from '../src/core/runner-protocol.js';

const base=()=>({version:1,requestId:randomUUID(),operation:'git.inspect',
  repository:'riquelmechile/Panter-ai',candidateSha:'a'.repeat(40),
  workId:'work-1',attemptId:'attempt-1',arguments:{}});
test('protocol accepts typed intent but never provides executable dispatcher',()=>{
  assert.equal(parseRunnerIntent(JSON.stringify(base())).operation,'git.inspect');
  assert.equal(runnerExecutionAvailable(),false);
});
test('protocol denies command injection fields, nested commands and unknown operations',()=>{
  for(const x of [
    {...base(),command:'sh -c curl example.com'},
    {...base(),operation:'exec'},
    {...base(),arguments:{argv:['bash','-c','id']}},
    {...base(),repository:'../../foo'},
    {...base(),candidateSha:'main'},
    {...base(),version:2},
  ])assert.throws(()=>parseRunnerIntent(JSON.stringify(x)),InvalidRunnerIntent);
});
test('rejects oversized and malformed JSON without reflecting raw content',()=>{
  assert.throws(()=>parseRunnerIntent('{"secret":"SENSITIVE_CANARY"'), (err:unknown)=>{
    assert.ok(err instanceof InvalidRunnerIntent);
    assert.ok(!err.message.includes('SENSITIVE_CANARY'));
    return true;
  });
  assert.throws(()=>parseRunnerIntent('a'.repeat(RUNNER_MESSAGE_MAX_BYTES+1)),InvalidRunnerIntent);
});
