import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseOwnerMode, ownerMode } from '../src/core/owner-mode.js';
import { AutomaticHarness, chooseHarness } from '../src/core/auto-harness.js';
import { GitHubDeliveryGate } from '../src/core/github-delivery.js';
import { MeshEngine } from '../src/core/mesh.js';
import { NativeSubagentReview } from '../src/core/native-review-workflow.js';
import { specialistPacket } from '../src/core/gentle-catalog.js';

/** Runs fn with PANTER_OWNER_MODE set (ownerMode() reads the environment per call when not frozen). */
async function withOwner<T>(value: '0' | '1', fn: () => Promise<T> | T): Promise<T> {
  const before = process.env.PANTER_OWNER_MODE;
  process.env.PANTER_OWNER_MODE = value;
  try { return await fn(); } finally { if (before === undefined) delete process.env.PANTER_OWNER_MODE; else process.env.PANTER_OWNER_MODE = before; }
}
async function withDir<T>(fn: (dir: string) => Promise<T>) {
  const dir = await mkdtemp(join(tmpdir(), 'panter-owner-'));
  try { return await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}
const sha = 'a'.repeat(40);
const profile = { host: 'grok' as const, actorId: 'actor-grok-001', modelRequest: 'host-default', effortRequest: 'max', roles: ['implementer' as const, 'reviewer' as const] };

test('PANTER_OWNER_MODE accepts only 0, 1 or unset', () => {
  assert.equal(parseOwnerMode(undefined), false);
  assert.equal(parseOwnerMode(''), false);
  assert.equal(parseOwnerMode('0'), false);
  assert.equal(parseOwnerMode('1'), true);
  assert.throws(() => parseOwnerMode('yes'), /0 or 1/);
});

test('owner mode: keywords and missing surfaces are advice, not a high-risk route', () => withOwner('1', () => {
  assert.equal(ownerMode(), true);
  const keyword = chooseHarness({ project: 'app', objective: 'Fix deploy permissions and security', idempotencyKey: 'k', writesAuthorized: true, changeSurfaces: ['src/auth.ts'] });
  assert.equal(keyword.risk, 'LOW');
  assert.deepEqual(keyword.phases, ['IMPLEMENT']);
  assert.ok(keyword.reasons.some(r => /not a gate/.test(r)));
  const whole = chooseHarness({ project: 'app', objective: 'Refactor everything', idempotencyKey: 'w', writesAuthorized: true });
  assert.equal(whole.risk, 'LOW');
  assert.deepEqual(whole.phases, ['IMPLEMENT']);
  assert.ok(whole.reasons.some(r => /whole repository/.test(r)));
  // An explicit observation still asks for the full route.
  const unclear = chooseHarness({ project: 'app', objective: 'Something', idempotencyKey: 'u', writesAuthorized: true, observations: { requirementsClear: false } });
  assert.equal(unclear.risk, 'HIGH');
  assert.ok(unclear.phases.includes('REVIEW'));
}));

test('without owner mode the classifier is unchanged', () => withOwner('0', () => {
  const keyword = chooseHarness({ project: 'app', objective: 'Fix deploy permissions', idempotencyKey: 'k', writesAuthorized: true, changeSurfaces: ['src/auth.ts'] });
  assert.equal(keyword.risk, 'HIGH');
}));

test('owner mode: a writable run needs no operator grant and implements on the whole repository', () => withOwner('1', () => withDir(async dir => {
  const mesh = await MeshEngine.open(dir), native = await NativeSubagentReview.open(dir);
  // requireWriteGrant=false is what the server passes in owner mode.
  const h = await AutomaticHarness.open(dir, mesh, native, undefined, undefined, undefined, false);
  const run = await h.start({ project: 'app', objective: 'Rename the helper', idempotencyKey: 'r1', writesAuthorized: true, coordinationMode: 'GPT_A_ONLY' });
  assert.equal(run.permission, 'WRITE_APPROVED');
  assert.deepEqual(run.paths, []);
  const tick = await h.tick(run.id, { nativeSubagents: true, maxParallelSubagents: 4, toolsAvailable: true });
  assert.notEqual(tick.status, 'BLOCKED_EDIT_SCOPE_OR_AUTHORIZATION');
  assert.notEqual(tick.status, 'BLOCKED_WRITE_GRANT_EXPIRED');
  await h.report(run.id, tick.phaseId!, { summary: 'Renamed', evidence: ['npm test: pass'], candidateSha: sha, runId: 'claude-native-1' });
  assert.equal((await h.get(run.id))!.candidateSha, sha);
})));

test('owner mode: implementer delegated directly, through a wake route and behind a busy peer', () => withOwner('1', () => withDir(async dir => {
  const m = await MeshEngine.open(dir);
  await m.setProfile('gpt-a', profile, 0);
  // No write guard is installed in owner mode: a direct writer is accepted.
  const first = await m.delegate('gpt-a', { missionId: 'm1', target: 'grok', role: 'implementer', instruction: 'Edit the repo', idempotencyKey: 'w1' });
  assert.equal(first.state, 'QUEUED');
  // A wake route accepts a writer and queues it behind the busy peer instead of refusing it.
  const second = await m.delegate('gpt-a', { missionId: 'm2', target: 'grok', role: 'implementer', instruction: 'Second edit', idempotencyKey: 'w2', wakeOnly: true });
  assert.equal(second.state, 'QUEUED');
  assert.equal((await m.loadByHost()).grok, 2);
  // A whole-repository writer overlaps every other writer of the same mission, in either order.
  await assert.rejects(m.delegate('gpt-a', { missionId: 'm1', target: 'grok', role: 'implementer', instruction: 'Third edit', idempotencyKey: 'w3' }), /Overlapping active writer/);
})));

test('owner mode: a scoped writer and a whole-repository writer of one mission never run together', () => withOwner('1', () => withDir(async dir => {
  const m = await MeshEngine.open(dir);
  await m.setProfile('gpt-a', profile, 0);
  await m.bindSpecialist('gpt-a', { agentId: 'gentle-ai-worker', host: 'grok', modelRequest: 'host-default', effortRequest: 'max', skillIds: ['gentle-ai'] }, 0);
  await m.delegateBoundSpecialist('gpt-a', { missionId: 'mx', agentId: 'gentle-ai-worker', objective: 'Scoped', idempotencyKey: 's1', allowedEditSurfaces: ['src/core'] });
  await assert.rejects(m.delegateBoundSpecialist('gpt-a', { missionId: 'mx', agentId: 'gentle-ai-worker', objective: 'Whole', idempotencyKey: 's2' }), /Overlapping active writer/);
  await m.delegateBoundSpecialist('gpt-a', { missionId: 'my', agentId: 'gentle-ai-worker', objective: 'Whole', idempotencyKey: 's3' });
  await assert.rejects(m.delegateBoundSpecialist('gpt-a', { missionId: 'my', agentId: 'gentle-ai-worker', objective: 'Scoped', idempotencyKey: 's4', allowedEditSurfaces: ['docs'] }), /Overlapping active writer/);
  // Disjoint scoped writers still run side by side.
  await m.delegateBoundSpecialist('gpt-a', { missionId: 'mx', agentId: 'gentle-ai-worker', objective: 'Docs', idempotencyKey: 's5', allowedEditSurfaces: ['docs'] });
})));

test('owner mode: an explicitly supplied grant is still enforced', () => withOwner('1', () => withDir(async dir => {
  const mesh = await MeshEngine.open(dir), native = await NativeSubagentReview.open(dir);
  const h = await AutomaticHarness.open(dir, mesh, native, undefined, undefined, undefined, false);
  const objective = 'Edit foo only';
  const grant = await h.grantWrite({ project: 'app', objective, allowedPaths: ['src/foo'], ttlSeconds: 600 });
  await assert.rejects(h.start({ project: 'app', objective, idempotencyKey: 'g1', writesAuthorized: true, writeGrantId: grant.grantId, changeSurfaces: ['src/bar.ts'] }), /exceeds operator grant/);
  const run = await h.start({ project: 'app', objective, idempotencyKey: 'g2', writesAuthorized: true, writeGrantId: grant.grantId });
  assert.deepEqual(run.paths, ['src/foo']);
  await assert.rejects(h.authorizeDelegatedWrite(run.id, ['src/bar.ts']), /Out-of-scope writer/);
  await h.authorizeDelegatedWrite(run.id, ['src/foo/a.ts']);
})));

test('without owner mode a wake route still refuses writers and busy peers', () => withOwner('0', () => withDir(async dir => {
  const m = await MeshEngine.open(dir);
  await m.setProfile('gpt-a', profile, 0);
  await assert.rejects(m.delegate('gpt-a', { missionId: 'm1', target: 'grok', role: 'implementer', instruction: 'Edit', idempotencyKey: 'w1', wakeOnly: true }), /External wake cannot authorize remote writes/);
  await m.delegate('gpt-a', { missionId: 'm1', target: 'grok', role: 'reviewer', instruction: 'Look', idempotencyKey: 'r1', wakeOnly: true });
  await assert.rejects(m.delegate('gpt-a', { missionId: 'm1', target: 'grok', role: 'reviewer', instruction: 'Look again', idempotencyKey: 'r2', wakeOnly: true }), /busy/);
})));

test('owner mode: activity counts what each worker finished', () => withOwner('1', () => withDir(async dir => {
  const m = await MeshEngine.open(dir);
  await m.setProfile('gpt-a', profile, 0);
  const w = await m.delegate('gpt-a', { missionId: 'm1', target: 'grok', role: 'reviewer', instruction: 'Review', idempotencyKey: 'a1' });
  const c = await m.claim('grok', w.id);
  await m.complete('grok', w.id, c.attemptId!, c.leaseGeneration, 'done');
  const activity = await m.activitySince(Date.now() - 60_000);
  assert.equal(activity.grok?.completed, 1);
  assert.equal(activity.grok?.failed, 0);
  assert.ok(activity.grok?.lastCompletedAt);
})));

test('owner mode: an implementer packet may cover the whole repository', () => withOwner('1', async () => {
  const p = await specialistPacket({ agentId: 'gentle-ai-worker', skillIds: ['gentle-ai'], objective: 'Do it', modelRequest: 'm', effortRequest: 'max' });
  assert.match(p.instruction, /whole repository \(owner mode\)/);
  await withOwner('0', () => assert.rejects(specialistPacket({ agentId: 'gentle-ai-worker', skillIds: ['gentle-ai'], objective: 'Do it', modelRequest: 'm', effortRequest: 'max' }), /explicit allowed edit surfaces/));
}));

// ---- Delivery gate ----
const pr = { state: 'open', draft: false, head: { sha, ref: 'whatever-branch', repo: { full_name: 'example/project' } }, base: { ref: 'main' }, body: 'no issue here', labels: [], additions: 900, deletions: 20, commits: 1 };
function mock(records: Record<string, unknown>): typeof fetch {
  return (async (url: string | URL | Request) => {
    const suffix = String(url).split('/repos/example/project/')[1] ?? '';
    const response = records[suffix];
    return { ok: response !== undefined, status: response === undefined ? 404 : 200, text: async () => JSON.stringify(response) } as Response;
  }) as typeof fetch;
}
function gate(checkConclusion = 'success', head = sha, reviewer: string | null = 'rev-account') {
  return new GitHubDeliveryGate({ allowedRepositories: ['example/project'], requiredChecks: ['test'], independentReviewer: reviewer ?? undefined }, mock({
    'pulls/12/reviews?per_page=100': [{ id: 1, user: { login: 'rev-account' }, state: 'APPROVED', commit_id: head }],
    '': { default_branch: 'main' }, 'pulls/12': { ...pr, head: { ...pr.head, sha: head } },
    'pulls/12/commits?per_page=100': [{ sha, commit: { message: 'Update stuff\n\nCo-Authored-By: Someone <x@y>' } }],
    [`commits/${head}/check-runs?per_page=100`]: { total_count: 1, check_runs: [{ name: 'test', status: 'completed', conclusion: checkConclusion, head_sha: head }] },
  }));
}
const input = { repository: 'example/project', prNumber: 12, expectedSha: sha };

test('owner mode: process conventions are warnings, the PR is reviewable', () => withOwner('1', async () => {
  const r = await gate().inspect(input);
  assert.deepEqual(r.blockers, []);
  assert.equal(r.state, 'REVIEWABLE');
  for (const w of ['type:*', 'Conventional Commits', 'Co-Authored-By', 'approved issue', 'delivery strategy', 'naming'])
    assert.ok(r.warnings.some(x => x.includes(w)), w);
  assert.equal(r.approvals.merge, false);
}));

test('owner mode: without an independent reviewer configured the gate blocks', () => withOwner('1', async () => {
  const r = await gate('success', sha, null).inspect(input);
  assert.equal(r.state, 'BLOCKED');
  assert.ok(r.blockers.some(b => /requires PANTER_GITHUB_INDEPENDENT_REVIEWER/.test(b)));
}));

test('owner mode: failing CI and a moved head still block', () => withOwner('1', async () => {
  assert.ok((await gate('failure').inspect(input)).blockers.some(b => /non-success/.test(b)));
  assert.ok((await gate('success', 'b'.repeat(40)).inspect(input)).blockers.some(b => /differs from frozen candidate/.test(b)));
}));

test('without owner mode the same PR is blocked by the conventions', () => withOwner('0', async () => {
  const r = await gate().inspect(input);
  assert.equal(r.state, 'BLOCKED');
  assert.ok(r.blockers.some(b => /type:\*/.test(b)));
}));

test('owner mode: whole-repository runs can split into disjoint units', () => withOwner('1', () => withDir(async dir => {
  const mesh = await MeshEngine.open(dir), native = await NativeSubagentReview.open(dir);
  const h = await AutomaticHarness.open(dir, mesh, native, undefined, undefined, undefined, false);
  const run = await h.start({ project: 'app', objective: 'Two parts', idempotencyKey: 'u1', writesAuthorized: true, coordinationMode: 'GPT_A_ONLY', observations: { independentWorkUnits: 2 } });
  assert.deepEqual(run.paths, []);
  const design = await h.tick(run.id, { nativeSubagents: true, maxParallelSubagents: 4, toolsAvailable: true });
  await h.report(run.id, design.phaseId!, { summary: 'Plan', evidence: ['two units'] });
  const now = (await h.get(run.id))!;
  const units = await h.defineUnits(run.id, [{ objective: 'A', paths: ['src/a'] }, { objective: 'B', paths: ['src/b'] }], now.revision);
  assert.equal(units.units?.length, 2);
  await assert.rejects(h.defineUnits(run.id, [{ objective: 'A', paths: ['src/a'] }, { objective: 'B', paths: ['src/a/x'] }], units.revision), /overlap|already frozen/);
})));

test('owner mode: a scheduled poll can claim writer work', () => withOwner('1', () => withDir(async dir => {
  const m = await MeshEngine.open(dir);
  await m.setProfile('gpt-a', profile, 0);
  const w = await m.delegate('gpt-a', { missionId: 'm1', target: 'grok', role: 'implementer', instruction: 'Edit', idempotencyKey: 'p1' });
  const claimed = await m.pickup('grok', 300, false) as { work?: { id: string } } | { id?: string };
  assert.ok(JSON.stringify(claimed).includes(w.id));
})));

test('owner mode: a PR with more than 100 commits is read in full and stays reviewable', () => withOwner('1', async () => {
  const commits = Array.from({ length: 120 }, (_, i) => ({ sha: i.toString(16).padStart(40, '0'), commit: { message: `feat: part ${i}` }, author: { login: 'dev' } }));
  const g = new GitHubDeliveryGate({ allowedRepositories: ['example/project'], requiredChecks: ['test'], independentReviewer: 'rev-account' }, mock({
    '': { default_branch: 'main' }, 'pulls/12': { ...pr, commits: 120 },
    'pulls/12/commits?per_page=100': commits.slice(0, 100), 'pulls/12/commits?per_page=100&page=2': commits.slice(100),
    'pulls/12/reviews?per_page=100': [{ id: 1, user: { login: 'rev-account' }, state: 'APPROVED', commit_id: sha }],
    [`commits/${sha}/check-runs?per_page=100`]: { total_count: 1, check_runs: [{ name: 'test', status: 'completed', conclusion: 'success', head_sha: sha }] },
  }));
  const r = await g.inspect(input);
  assert.deepEqual(r.blockers, []);
  assert.equal(r.state, 'REVIEWABLE');
}));
