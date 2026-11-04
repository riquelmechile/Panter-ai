import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutomaticHarness, type HarnessHostHooks } from '../src/core/auto-harness.js';
import { MeshEngine } from '../src/core/mesh.js';
import { NativeSubagentReview } from '../src/core/native-review-workflow.js';

const sha = 'a'.repeat(40);
const all = { nativeSubagents: true, maxParallelSubagents: 8, toolsAvailable: true,
  peerStates: { 'gpt-b': 'CONNECTED' as const, grok: 'CONNECTED' as const, gemini: 'CONNECTED' as const } };

async function withHosts<T>(fn: (h: AutomaticHarness, m: MeshEngine, ctx: { dispatched: any[]; timeout: { ms: number } }) => Promise<T>) {
  const dir = await mkdtemp(join(tmpdir(), 'panter-hosts-'));
  try {
    const m = await MeshEngine.open(dir), n = await NativeSubagentReview.open(dir), h = await AutomaticHarness.open(dir, m, n);
    let rev = 0;
    for (const host of ['gpt-b', 'grok', 'gemini'] as const)
      await m.setProfile('gpt-a', { host, actorId: `actor-${host}`, modelRequest: 'host-default', effortRequest: 'max', roles: ['explorer', 'verifier', 'reviewer'] }, 0);
    const bind = async (agentId: string, host: 'gpt-b' | 'grok' | 'gemini') => {
      await m.bindSpecialist('gpt-a', { agentId, host, modelRequest: 'host-default', effortRequest: 'max', skillIds: ['gentle-ai'] } as any, 0); rev++;
    };
    await bind('gentle-ai-explore', 'gpt-b');
    await bind('review-risk', 'grok'); await bind('review-readability', 'gemini');
    await bind('review-reliability', 'gpt-b'); await bind('review-resilience', 'grok');
    const dispatched: any[] = []; const timeout = { ms: 3_600_000 };
    const hooks: HarnessHostHooks = {
      materialFor: async (_run, host) => host === 'gemini' ? 'DIFF-MATERIAL-FOR-MAIL' : undefined,
      afterDispatch: async (x) => { dispatched.push({ phase: x.phase, host: x.host, workId: x.workId }); },
      pickupTimeoutMs: () => timeout.ms,
    };
    h.setHostHooks(hooks);
    return await fn(h, m, { dispatched, timeout });
  } finally { await rm(dir, { recursive: true, force: true }); }
}

test('a bound host gets its phase, with a dispatch hook; a host that never starts it loses it to native', () => withHosts(async (h, m, { dispatched, timeout }) => {
  const s = await h.start({ project: 'app', objective: 'Repair unknown issue', idempotencyKey: 'p1', writesAuthorized: true });
  const first = await h.tick(s.id, all);
  assert.equal(first.status, 'REMOTE_A2A_DISPATCHED');
  assert.equal((first.next[0] as any).host, 'gpt-b');
  assert.deepEqual(dispatched.map(d => [d.phase, d.host]), [['DISCOVER', 'gpt-b']]);
  assert.equal((await h.tick(s.id, all)).status, 'WAITING_REMOTE_PEER');
  timeout.ms = 0;
  await new Promise(r => setTimeout(r, 5));
  const fb = await h.tick(s.id, all);
  assert.deepEqual((fb as any).fallback?.from, 'gpt-b');
  assert.equal(fb.status, 'GPT_A_NATIVE', 'the phase now runs native');
  const work = (await m.inbox('gpt-a')).works.find(w => w.id === first.next[0]!.workId);
  assert.equal(work?.state, 'ABORTED_NO_EFFECTS');
  assert.equal((await h.tick(s.id, all)).status, 'WAITING_HOST_PHASE_REPORT', 'never redispatched to the slow host');
}));

test('a started phase is never withdrawn by the timeout', () => withHosts(async (h, m, { timeout }) => {
  const s = await h.start({ project: 'app', objective: 'Repair unknown issue', idempotencyKey: 'p2', writesAuthorized: true });
  const first = await h.tick(s.id, all);
  await m.claim('gpt-b', first.next[0]!.workId as string, 600);
  timeout.ms = 0;
  await new Promise(r => setTimeout(r, 5));
  assert.equal((await h.tick(s.id, all)).status, 'WAITING_REMOTE_PEER');
}));

async function toReview(h: AutomaticHarness, key: string) {
  const s = await h.start({ project: 'app', objective: 'Fix login security', idempotencyKey: key, writesAuthorized: true, changeSurfaces: ['src/auth.ts'] });
  let t = await h.tick(s.id, all); await h.report(s.id, t.phaseId!, { summary: 'Plan', evidence: ['plan'] });
  t = await h.tick(s.id, all); await h.report(s.id, t.phaseId!, { summary: 'Done', evidence: ['tests'], candidateSha: sha, runId: 'impl-run-1' });
  t = await h.tick(s.id, all); await h.report(s.id, t.phaseId!, { summary: 'Verified', evidence: ['checks'], candidateSha: sha, runId: 'verify-run-1' });
  return s.id;
}

test('remote 4R lenses go to their hosts; the e-mail-only host gets the diff as material', () => withHosts(async (h, m, { dispatched }) => {
  const id = await toReview(h, 'r1');
  const r = await h.tick(id, all);
  assert.equal(r.status, 'WAITING_REMOTE_REVIEW');
  const lenses = dispatched.filter(d => d.phase === 'REVIEW');
  assert.deepEqual(lenses.map(d => d.host).sort(), ['gemini', 'gpt-b', 'grok', 'grok']);
  const gemini = await m.pickup('gemini', 300);
  assert.equal(gemini.status, 'CLAIMED');
  assert.match(JSON.stringify(gemini), /DIFF-MATERIAL-FOR-MAIL/);
  const grok = await m.pickup('grok', 300);
  assert.doesNotMatch(JSON.stringify(grok), /DIFF-MATERIAL-FOR-MAIL/);
}));

test('if a lens host does not show up in time, the whole review runs native instead', () => withHosts(async (h, m, { timeout }) => {
  const id = await toReview(h, 'r2');
  assert.equal((await h.tick(id, all)).status, 'WAITING_REMOTE_REVIEW');
  timeout.ms = 0;
  await new Promise(r => setTimeout(r, 5));
  const fb = await h.tick(id, all);
  assert.equal((fb as any).fallback?.reason, 'REVIEW_PICKUP_TIMEOUT');
  assert.equal(fb.status, 'READY_FOR_HOST_NATIVE_DISPATCH');
  assert.equal((await h.get(id))?.reviewTransport, 'NATIVE');
  const lensStates = (await m.inbox('gpt-a')).works.filter(w => w.role === 'reviewer').map(w => w.state);
  assert.ok(lensStates.every(s => s === 'ABORTED_NO_EFFECTS'));
}));

test('withdrawing never touches a started writer; transport-held read-only work can be withdrawn', () => withHosts(async (_h, m) => {
  await m.setProfile('gpt-a', { host: 'grok', actorId: 'actor-grok', modelRequest: 'host-default', effortRequest: 'max', roles: ['implementer', 'reviewer'] }, 1);
  const writer = await m.delegate('gpt-a', { missionId: 'm', target: 'grok', role: 'implementer', instruction: 'write', idempotencyKey: 'w' });
  await m.claim('grok', writer.id, 300);
  await assert.rejects(m.withdrawUnstarted('gpt-a', writer.id, 'x'), /never withdrawn|already started/);
  const reader = await m.delegate('gpt-a', { missionId: 'm', target: 'gemini', role: 'explorer', instruction: 'read', idempotencyKey: 'r' });
  await m.claim('gemini', reader.id, 3600, true, true, true);
  assert.equal((await m.withdrawUnstarted('gpt-a', reader.id, 'mail unanswered')).withdrawn, true);
  await assert.rejects(m.withdrawUnstarted('grok' as any, reader.id, 'x'), /Only/);
}));
