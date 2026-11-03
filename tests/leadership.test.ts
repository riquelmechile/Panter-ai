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
  await assert.rejects(m.claim('claude', work.id), /Only workers may claim delegated work/);
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

test('leader switch migration: stuck work closed, messages re-addressed, profiles cleaned, rebinding works', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'panter-switch2-'));
  try {
    process.env.PANTER_LEAD_HOST = 'gpt-a';
    const a = await MeshEngine.open(dir);
    assert.equal(a.leaderSwitch, null);
    await a.setCoordinationMode('gpt-a', 'AUTO', 0);
    await a.setProfile('gpt-a', { host: 'claude', actorId: 'actor-claude', modelRequest: 'host-default', effortRequest: 'max', roles: ['reviewer', 'implementer'] }, 0);
    await a.setProfile('gpt-a', worker('gpt-b'), 0);
    await a.bindSpecialist('gpt-a', { agentId: 'review-risk', host: 'claude', modelRequest: 'host-default', effortRequest: 'max', skillIds: ['gentle-ai'] }, 0);
    const queued = await a.delegate('gpt-a', { missionId: 'm', target: 'claude', role: 'reviewer', instruction: 'q', idempotencyKey: 'q-1' });
    const running = await a.delegate('gpt-a', { missionId: 'm', target: 'claude', role: 'reviewer', instruction: 'r', idempotencyKey: 'r-1' });
    await a.claim('claude', running.id);
    const forB = await a.delegate('gpt-a', { missionId: 'm', target: 'gpt-b', role: 'reviewer', instruction: 'b', idempotencyKey: 'b-1' });
    await a.message('gpt-b', { missionId: 'm', workId: forB.id, to: 'gpt-a', kind: 'QUESTION', text: 'Which file?' });

    process.env.PANTER_LEAD_HOST = 'claude';
    const m = await MeshEngine.open(dir);
    assert.deepEqual(m.leaderSwitch, { from: 'gpt-a', to: 'claude' });
    const works = (await m.inbox('claude')).works;
    assert.equal(works.find(w => w.id === queued.id)?.state, 'ABORTED_NO_EFFECTS');
    assert.equal(works.find(w => w.id === running.id)?.state, 'FAILED');
    assert.equal((await m.pending('claude')).length, 0);
    assert.ok((await m.inbox('claude')).messages.some(x => x.kind === 'QUESTION' && x.text === 'Which file?'));
    const profiles = await m.profiles();
    const oldLead = profiles.find(p => p.host === 'gpt-a')!;
    assert.equal(oldLead.coordinationMode, undefined);
    assert.equal(oldLead.preferNativeSubagents, undefined);
    assert.deepEqual(profiles.find(p => p.host === 'claude')?.roles, ['orchestrator']);
    // The hidden binding to the new leader is rebound as if unbound.
    assert.equal((await m.specialistBindings()).length, 0);
    const rebound = await m.bindSpecialist('claude', { agentId: 'review-risk', host: 'gpt-b', modelRequest: 'host-default', effortRequest: 'max', skillIds: ['gentle-ai'] }, 0);
    assert.equal(rebound.host, 'gpt-b');
    assert.equal(rebound.revision, 2);
    // Reopening with the same leader is not another switch.
    assert.equal((await MeshEngine.open(dir)).leaderSwitch, null);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('leader switch creates the leader profile when missing and keeps old native reviews and phases usable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'panter-switch3-'));
  try {
    process.env.PANTER_LEAD_HOST = 'gpt-a';
    const { NativeSubagentReview } = await import('../src/core/native-review-workflow.js');
    const before = await NativeSubagentReview.open(dir);
    const review = await before.create({ missionId: 'm', kind: '4r', objective: 'Review exact candidate', candidateSha: 'c'.repeat(40), idempotencyKey: 'nr-1' });
    await (await MeshEngine.open(dir)).setProfile('gpt-a', worker('gpt-b'), 0);
    process.env.PANTER_LEAD_HOST = 'claude';
    const m = await MeshEngine.open(dir);
    assert.deepEqual(m.leaderSwitch, { from: 'gpt-a', to: 'claude' });
    assert.deepEqual((await m.profiles()).find(p => p.host === 'claude')?.roles, ['orchestrator']);
    const after = await NativeSubagentReview.open(dir);
    const packet = await after.packet(review.reviewId, review.slots[0]!.slotId);
    assert.equal(packet.digest, review.slots[0]!.packetDigest);
    const { AgentEngine } = await import('../src/core/agents.js');
    const { PanterStore } = await import('../src/core/store.js');
    const store = await PanterStore.open(dir);
    const agents = await AgentEngine.open(dir, store);
    assert.equal(await agents.adoptLeaderPhases('gpt-a', 'claude'), 0);
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
