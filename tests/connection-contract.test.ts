import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildConnectionContract } from '../src/core/connection-contract.js';

test('connection contract states the worker requirements delivered at MCP initialize', () => {
  const text = buildConnectionContract('gpt-a', false, { host: 'gpt-a', actorId: 'panter-oauth-gpt-a', modelRequest: 'gpt-6.1-sol', effortRequest: 'max',
    roles: ['implementer'], revision: 1, executionRequest: { serviceTier: 'ultrafast', stream: true, parallelToolCalls: true, maxNativeSubagents: 16 } });
  assert.match(text, /connected as gpt-a, a Panter worker/);
  assert.match(text, /REQUIRES model gpt-6\.1-sol, reasoning effort max, service tier ultrafast, streaming on, parallel tool calls on, up to 16 concurrent native subagents/);
  assert.match(text, /never claim values you did not observe/);
});

test('connection contract for the leader and for an unconfigured host', () => {
  assert.match(buildConnectionContract('claude', true, undefined), /claude, the Panter leader \(orchestrator\)\. No execution profile/);
  const b = buildConnectionContract('gpt-b', false, { host: 'gpt-b', actorId: 'x-gpt-b', modelRequest: 'gpt-6-astra', effortRequest: 'ultra', roles: ['reviewer'], revision: 2 });
  assert.match(b, /REQUIRES model gpt-6-astra, reasoning effort ultra\./);
  assert.doesNotMatch(b, /service tier|subagents/);
});
