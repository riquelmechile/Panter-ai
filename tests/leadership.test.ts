import assert from 'node:assert/strict';
import { test, beforeEach, after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MeshEngine } from '../src/core/mesh.js';
import { appWorkforceTurn } from '../src/core/workforce-app-turn.js';
import { WorkforceLongPoll } from '../src/core/workforce-long-poll.js';
import { appEventHosts, isLeader, leaderHost, leaderLabel, parseLeaderHost, workerHosts } from '../src/core/leadership.js';

// node --test runs each file in its own process, so switching the leader here
// cannot leak into the default-leader (GPT-A) suites.
const previous = process.env.PANTER_LEAD_HOST;
beforeEach(() => { process.env.PANTER_LEAD_HOST = 'claude'; });
after(() => { if (previous === undefined) delete process.env.PANTER_LEAD_HOST; else process.env.PANTER_LEAD_HOST = previous; });

async function withMesh(fn: (mesh: MeshEngine) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'panter-leader-'));
  try { await fn(await MeshEngine.open(dir)); } finally { await rm(dir, { recursive: true, force: true }); }
}
const worker = (host: 'gpt-a' | 'gpt-b' | 'grok' | 'gemini', roles: Array<'reviewer' | 'verifier'> = ['reviewer']) =>
  ({ host, actorId: `actor-${host}`, modelRequest: 'host-default', effortRequest: 'max', roles });

test('leader parsing defaults to GPT-A and rejects unknown hosts', () => {
  assert.equal(parseLeaderHost(undefined), 'gpt-a');
  assert.equal(parseLeaderHost(' claude '), 'claude');
  assert.throws(() => parseLeaderHost('kimi'), /PANTER_LEAD_HOST must be one of/);
  assert.throws(() => parseLeaderHost(''), /PANTER_LEAD_HOST must be one of/);
});

test('with PANTER_LEAD_HOST=claude the four app hosts are the workforce', () => {
  assert.equal(leaderHost(), 'claude');
  assert.equal(leaderLabel(), 'Claude');
  assert.ok(isLeader('claude') && !isLeader('gpt-a'));
  assert.deepEqual(workerHosts(), ['gpt-a', 'gpt-b', 'grok', 'gemini']);
  assert.deepEqual(appEventHosts(), ['gpt-a', 'gpt-b', 'gemini']);
});

test('Claude configures, delegates to GPT-A and reads the result; GPT-A cannot lead', () => withMesh(async m => {
  await assert.rejects(m.setProfile('gpt-a', worker('gpt-b'), 0), /Only orchestrator/);
  await assert.rejects(m.setProfile('claude', { ...worker('gpt-a'), roles: ['orchestrator'] as never }, 0), /Only Claude is the coordinator/);
  await m.setProfile('claude', worker('gpt-a'), 0);
  await assert.rejects(m.delegate('gpt-a', { missionId: 'm1', target: 'gpt-b', role: 'reviewer', instruction: 'x', idempotencyKey: 'k-0' }), /Only Claude can delegate/);
  await assert.rejects(m.delegate('claude', { missionId: 'm1', target: 'claude', role: 'reviewer', instruction: 'x', idempotencyKey: 'k-self' }), /Invalid target/);
  const work = await m.delegate('claude', { missionId: 'm1', target: 'gpt-a', role: 'reviewer', instruction: 'Review read-only', idempotencyKey: 'k-1' });
  assert.equal(work.from, 'claude');
  assert.equal(work.target, 'gpt-a');
  const claimed = await m.claim('gpt-a', work.id);
  await assert.rejects(m.claim('claude', work.id), /./);
  const done = await m.complete('gpt-a', work.id, claimed.attemptId!, claimed.leaseGeneration, 'REVIEW_OK');
  assert.equal(done.state, 'COMPLETED');
  await assert.rejects(m.resultGet('gpt-a', work.id), /Only Claude may read Workforce results/);
  const full = await m.resultGet('claude', work.id);
  assert.match(JSON.stringify(full), /REVIEW_OK/);
  const inbox = await m.inbox('claude');
  assert.ok(inbox.works.some(w => w.id === work.id));
}));

test('Workforce status lists GPT-A, GPT-B, Grok and Gemini only to the Claude leader', () => withMesh(async m => {
  await assert.rejects(m.workforceStatus('gpt-a'), /Only Claude may inspect Workforce/);
  const status = await m.workforceStatus('claude');
  const hosts = JSON.stringify(status);
  for (const h of ['gpt-a', 'gpt-b', 'grok', 'gemini']) assert.ok(hosts.includes(`"${h}"`), h);
  assert.ok(!hosts.includes('"host":"claude"'));
}));

test('GPT-A as worker uses in-app turns; the leader cannot take worker turns or long-poll', () => withMesh(async m => {
  await m.setProfile('claude', worker('gpt-a'), 0);
  const work = await m.delegate('claude', { missionId: 'app', target: 'gpt-a', role: 'reviewer', instruction: 'Read-only check', idempotencyKey: 'app-1' });
  const turn = await appWorkforceTurn(m, 'gpt-a', '2025-11-25', 300);
  assert.equal(turn.status, 'CLAIMED');
  if (turn.status !== 'CLAIMED') throw Error('GPT-A did not claim');
  assert.equal(turn.work.id, work.id);
  await assert.rejects(appWorkforceTurn(m, 'claude', '2025-11-25', 300), /Native ChatGPT\/Gemini app OAuth worker required/);
  const poll = new WorkforceLongPoll(m);
  await assert.rejects(poll.wait('claude', '2025-11-25', 0), /Only authenticated workers may wait for work/);
  await assert.rejects(m.pickup('claude'), /Only workers may pick up delegated work/);
}));
