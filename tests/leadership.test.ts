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

test('a non-ChatGPT leader gets the host-native policy, never the OpenAI model request', async () => {
  const { planHostNative } = await import('../src/core/native-fallback.js');
  const plan = planHostNative({
    signals: { requirementsClear: true, resumableFromDiff: true, risk: 'low', unknownCodeArea: false, independentWorkUnits: 1, writesAuthorized: true },
    assignments: [{ agentId: 'gentle-ai-explore', objective: 'Inspect scoped code' }],
    bindings: [], peerStates: {},
    capabilities: { nativeSubagents: false, maxParallelSubagents: 0, toolsAvailable: true, evidence: 'HOST_REPORTED_UNVERIFIED' },
  });
  const text = JSON.stringify(plan);
  assert.ok(!text.includes('gpt-6-astra'), 'Claude leader must not be asked for an OpenAI model');
  assert.ok(text.includes('host-selected'));
  process.env.PANTER_LEAD_HOST = 'gpt-a';
  assert.ok(JSON.stringify(planHostNative({
    signals: { requirementsClear: true, resumableFromDiff: true, risk: 'low', unknownCodeArea: false, independentWorkUnits: 1, writesAuthorized: true },
    assignments: [{ agentId: 'gentle-ai-explore', objective: 'Inspect scoped code' }],
    bindings: [], peerStates: {},
    capabilities: { nativeSubagents: false, maxParallelSubagents: 0, toolsAvailable: true, evidence: 'HOST_REPORTED_UNVERIFIED' },
  })).includes('gpt-6-astra'), 'ChatGPT leader keeps its policy');
});

test('after switching leader, review bindings that target the new leader are inactive', () => withMesh(async m => {
  // Configured under the historical GPT-A leader: Claude was a 4R reviewer.
  process.env.PANTER_LEAD_HOST = 'gpt-a';
  await m.setProfile('gpt-a', { host: 'claude', actorId: 'actor-claude', modelRequest: 'host-default', effortRequest: 'max', roles: ['reviewer'] }, 0);
  for (const agentId of ['review-risk', 'review-readability', 'review-reliability', 'review-resilience'])
    await m.bindSpecialist('gpt-a', { agentId, host: 'claude', modelRequest: 'host-default', effortRequest: 'max', skillIds: ['gentle-ai'] }, 0);
  assert.equal((await m.specialistBindings()).length, 4);
  // Restart with Claude as leader: those bindings must not route work back to it.
  process.env.PANTER_LEAD_HOST = 'claude';
  assert.equal((await m.specialistBindings()).length, 0);
  await assert.rejects(m.startReview('claude', { missionId: 'switch', kind: '4r', objective: 'Review', candidateSha: 'b'.repeat(40), idempotencyKey: 'rev-1' }),
    /All review specialists must be configured first/);
  assert.equal((await m.pending('claude')).length, 0);
}));

test('worker execution requests are worker-only, validated and frozen into each work', () => withMesh(async m => {
  process.env.PANTER_LEAD_HOST = 'claude';
  const gptA = { ...worker('gpt-a', ['reviewer']), modelRequest: 'gpt-6.1-sol', effortRequest: 'max',
    executionRequest: { serviceTier: 'ultrafast', stream: true, parallelToolCalls: true, maxNativeSubagents: 16 } };
  await m.setProfile('claude', gptA, 0);
  await m.setProfile('claude', { ...worker('gpt-b', ['reviewer']), modelRequest: 'gpt-6-astra', effortRequest: 'ultra',
    executionRequest: { serviceTier: 'ultrafast', stream: true, parallelToolCalls: true } }, 0);
  await assert.rejects(m.setProfile('claude', { host: 'claude', actorId: 'actor-claude', modelRequest: 'x', effortRequest: 'max', roles: ['orchestrator'],
    executionRequest: { maxNativeSubagents: 4 } }, 0), /Execution requests are worker-only/);
  await assert.rejects(m.setProfile('claude', { ...gptA, executionRequest: { maxNativeSubagents: 33 } }, 1), /Invalid native subagent count/);
  await assert.rejects(m.setProfile('claude', { ...gptA, executionRequest: { serviceTier: 'Ultra Fast!' } }, 1), /Invalid service tier/);
  await assert.rejects(m.setProfile('claude', { ...gptA, executionRequest: { apiKey: 'x' } as never }, 1), /Invalid execution request/);
  const w = await m.delegate('claude', { missionId: 'exec', target: 'gpt-a', role: 'reviewer', instruction: 'Read-only', idempotencyKey: 'exec-1' });
  assert.deepEqual(w.executionRequest, { status: 'REQUESTED_UNVERIFIED', model: 'gpt-6.1-sol', reasoningEffort: 'max',
    serviceTier: 'ultrafast', stream: true, parallelToolCalls: true, maxNativeSubagents: 16 });
  const claimed = await m.claim('gpt-a', w.id);
  assert.equal(claimed.executionRequest?.maxNativeSubagents, 16);
  // Later profile edits do not rewrite requirements already frozen into delegated work.
  await m.setProfile('claude', { ...gptA, executionRequest: { maxNativeSubagents: 2 } }, 1);
  assert.equal((await m.claim('gpt-a', w.id)).executionRequest?.maxNativeSubagents, 16);
  const b = await m.delegate('claude', { missionId: 'exec', target: 'gpt-b', role: 'reviewer', instruction: 'Read-only', idempotencyKey: 'exec-2' });
  assert.equal(b.executionRequest?.reasoningEffort, 'ultra');
  assert.equal(b.executionRequest?.maxNativeSubagents, undefined);
}));
test('switching gpt-a -> claude with persisted data: no leader worker paths, old results readable, roles normalized', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'panter-switch-'));
  try {
    process.env.PANTER_LEAD_HOST = 'gpt-a';
    const before = await MeshEngine.open(dir);
    await before.setCoordinationMode('gpt-a', 'AUTO', 0);
    await before.setProfile('gpt-a', { host: 'claude', actorId: 'actor-claude', modelRequest: 'host-default', effortRequest: 'max', roles: ['reviewer'] }, 0);
    await before.setProfile('gpt-a', worker('gpt-b'), 0);
    const toClaude = await before.delegate('gpt-a', { missionId: 'old', target: 'claude', role: 'reviewer', instruction: 'Old review', idempotencyKey: 'old-claude' });
    const toB = await before.delegate('gpt-a', { missionId: 'old', target: 'gpt-b', role: 'reviewer', instruction: 'Old check', idempotencyKey: 'old-b' });
    const c = await before.claim('gpt-b', toB.id);
    await before.complete('gpt-b', toB.id, c.attemptId!, c.leaseGeneration, 'OLD_RESULT');

    process.env.PANTER_LEAD_HOST = 'claude';
    const m = await MeshEngine.open(dir);
    const profiles = await m.profiles();
    assert.deepEqual(profiles.find(p => p.host === 'claude')?.roles, ['orchestrator']);
    assert.ok(!profiles.find(p => p.host === 'gpt-a')?.roles.includes('orchestrator'));
    await assert.rejects(m.claim('claude', toClaude.id), /Only workers may claim delegated work/);
    await assert.rejects(m.heartbeat('claude', toClaude.id, 'x', 0), /Only workers may renew delegated work/);
    await assert.rejects(m.complete('claude', toClaude.id, 'x', 0, 'r'), /Only workers may complete delegated work/);
    assert.match(JSON.stringify(await m.resultGet('claude', toB.id)), /OLD_RESULT/);
    assert.ok((await m.inbox('claude')).works.some(w => w.id === toB.id));
    const mode = await m.setCoordinationMode('claude', 'AUTO', profiles.find(p => p.host === 'claude')!.revision);
    assert.deepEqual(mode.roles, ['orchestrator']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// Keep last: freezing is process-wide by design.
test('freezeLeaderHost pins the leader for the process', async () => {
  const mod = await import('../src/core/leadership.js');
  process.env.PANTER_LEAD_HOST = 'claude';
  assert.equal(mod.freezeLeaderHost(), 'claude');
  process.env.PANTER_LEAD_HOST = 'gpt-a';
  assert.equal(mod.leaderHost(), 'claude');
});
