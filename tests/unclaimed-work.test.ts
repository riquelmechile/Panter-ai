import assert from 'node:assert/strict';
import { test, before } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MeshEngine, type Host } from '../src/core/mesh.js';
import { SqliteLedger } from '../src/core/sqlite-ledger.js';
import { GitHubWorkforce } from '../src/core/github-workforce.js';
import { leaderHost } from '../src/core/leadership.js';
import { sweepUnclaimedWork, UNCLAIMED_AFTER_SECONDS, type UnclaimedGitHub, type UnclaimedWork } from '../src/core/work-sweep.js';

before(() => { process.env.PANTER_LEAD_HOST = 'claude'; });
const AFTER = UNCLAIMED_AFTER_SECONDS * 1000;
const profile = (host: 'gpt-a' | 'gpt-b' | 'grok', model: string, roles: Array<'reviewer' | 'implementer'> = ['reviewer', 'implementer']) =>
  ({ host, actorId: 'actor-' + host, modelRequest: model, effortRequest: 'max', roles });

async function fixture(fn: (m: MeshEngine, dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'panter-unclaimed-'));
  try {
    const m = await MeshEngine.open(dir);
    await m.setProfile('claude', profile('gpt-a', 'model-a'), 0);
    await m.setProfile('claude', profile('gpt-b', 'model-b'), 0);
    await fn(m, dir);
  } finally { await rm(dir, { recursive: true, force: true }); }
}
async function withOwner<T>(value: '0' | '1', fn: () => Promise<T>): Promise<T> {
  const prior = process.env.PANTER_OWNER_MODE;
  process.env.PANTER_OWNER_MODE = value;
  try { return await fn(); } finally { if (prior === undefined) delete process.env.PANTER_OWNER_MODE; else process.env.PANTER_OWNER_MODE = prior; }
}
/** Rewrite one work in the ledger (to age it, or to shape a state the public interface reaches only over time). */
function patch(dir: string, workId: string, fn: (w: any) => void) {
  const db = SqliteLedger.open(dir);
  db.mutate('mesh', {} as any, (d: any) => { fn(d.works.find((w: any) => w.id === workId)); });
  db.close();
}
const age = (dir: string, workId: string, agoMs: number, field: 'createdAt' | 'reassignedAt' = 'createdAt') =>
  patch(dir, workId, w => { w[field] = new Date(Date.now() - agoMs).toISOString(); });
const work = (key: string, role: 'reviewer' | 'implementer' = 'reviewer', target: 'gpt-a' | 'gpt-b' = 'gpt-a') =>
  ({ missionId: 'm-' + key, target, role, instruction: 'do the work', idempotencyKey: key });
const leaderUpdates = async (m: MeshEngine, id: string) => (await m.inbox('claude')).messages.filter(x => x.workId === id && x.kind === 'UPDATE').map(x => JSON.parse(x.text));
const noGitHub: UnclaimedGitHub = { rehost: () => 'NONE' };
const to = (...hosts: Host[]) => async (_w: UnclaimedWork) => hosts;

test('queued work counts as unclaimed after three rings worth of time; harness work and scheduled hosts are treated apart', () => fixture(async (m, dir) => {
  assert.equal(UNCLAIMED_AFTER_SECONDS, 1800);
  const fresh = await m.delegate('claude', work('fresh'));
  const old = await m.delegate('claude', work('old'));
  age(dir, fresh.id, AFTER - 60_000);
  age(dir, old.id, AFTER + 60_000);
  assert.deepEqual((await m.unclaimedQueued(AFTER)).map(w => w.workId), [old.id]);
  const seen = (await m.unclaimedQueued(AFTER))[0]!;
  assert.deepEqual({ target: seen.target, role: seen.role, neverClaimed: seen.neverClaimed, reassignedFrom: seen.reassignedFrom },
    { target: 'gpt-a', role: 'reviewer', neverClaimed: true, reassignedFrom: null });
  // Work bound to a specialist belongs to the harness, which has its own pickup timeouts.
  patch(dir, old.id, w => { w.specialist = { agentId: 'x', skillIds: [], packetDigest: 'd', assetDigests: {}, modelRequest: 'm', effortRequest: 'max', bindingRevision: 1, allowedEditSurfaces: [] }; });
  assert.deepEqual(await m.unclaimedQueued(AFTER), []);
  patch(dir, old.id, w => { delete w.specialist; });
  // A host that only polls every hour is not late after 30 minutes: it gets two of its intervals.
  await m.setProfile('claude', { ...profile('gpt-a', 'model-a'), scheduledPickupEnabled: true, scheduledPollIntervalSeconds: 3600 }, 1);
  assert.deepEqual(await m.unclaimedQueued(AFTER), []);
  age(dir, old.id, 2 * 3600_000 + 60_000);
  assert.deepEqual((await m.unclaimedQueued(AFTER)).map(w => w.workId), [old.id]);
  // Claimed work is not queued; neither is finished work.
  const c = await m.claim('gpt-a', old.id);
  assert.deepEqual(await m.unclaimedQueued(AFTER), []);
  await m.complete('gpt-a', old.id, c.attemptId!, c.leaseGeneration, 'done');
  assert.deepEqual(await m.unclaimedQueued(AFTER), []);
}));

test('outside owner mode nothing moves: the leader is told once and decides', () => fixture(async (m, dir) => {
  const w = await m.delegate('claude', work('strict'));
  age(dir, w.id, AFTER + 60_000);
  await assert.rejects(m.reassignUnclaimed({ workId: w.id, to: 'gpt-b' }), /only in owner mode/);
  const first = await sweepUnclaimedWork(m, noGitHub, to('gpt-b'), false);
  assert.deepEqual(first, { reassigned: [], reported: [w.id] });
  assert.equal((await m.workTarget('claude', w.id)).target, 'gpt-a');
  const seen = await leaderUpdates(m, w.id);
  assert.equal(seen.length, 1);
  assert.deepEqual({ event: seen[0].event, target: seen[0].target, role: seen[0].role }, { event: 'UNCLAIMED_QUEUED', target: 'gpt-a', role: 'reviewer' });
  assert.deepEqual(await sweepUnclaimedWork(m, noGitHub, to('gpt-b'), false), { reassigned: [], reported: [] });
  assert.equal((await leaderUpdates(m, w.id)).length, 1);
  // The work is still there for its worker.
  assert.equal((await m.claim('gpt-a', w.id)).state, 'RUNNING');
}));

test('owner mode: never-claimed work moves once to another worker, with that worker\'s settings; then the leader is told', () => fixture(async (m, dir) => {
  await withOwner('1', async () => {
    const w = await m.delegate('claude', work('move', 'implementer'));
    assert.equal(w.executionRequest?.model, 'model-a');
    age(dir, w.id, AFTER + 60_000);
    const moves: string[] = [];
    const github: UnclaimedGitHub = { rehost: (id, from, dest) => { moves.push(`${id}:${from}>${dest}`); return 'MOVED'; } };
    // The first candidate is the worker that already has it: skipped.
    const first = await sweepUnclaimedWork(m, github, to('gpt-a', 'gpt-b'), true);
    assert.deepEqual(first, { reassigned: [{ workId: w.id, from: 'gpt-a', to: 'gpt-b' }], reported: [] });
    assert.deepEqual(moves, [`${w.id}:gpt-a>gpt-b`]);
    assert.equal((await m.workTarget('claude', w.id)).target, 'gpt-b');
    const moved = await leaderUpdates(m, w.id);
    assert.deepEqual({ event: moved[0].event, target: moved[0].target, reassignedFrom: moved[0].reassignedFrom, githubGrant: moved[0].githubGrant },
      { event: 'REASSIGNED_UNCLAIMED', target: 'gpt-b', reassignedFrom: 'gpt-a', githubGrant: 'MOVED' });
    // It is the new worker's work now, with the new worker's frozen settings.
    assert.deepEqual((await m.pending('gpt-a')).map(x => x.workId), []);
    assert.deepEqual((await m.pending('gpt-b')).map(x => x.workId), [w.id]);
    await assert.rejects(m.claim('gpt-a', w.id), /Work not found/);
    // The clock restarts with the move: the new worker gets its own rings before anything else happens.
    assert.deepEqual(await sweepUnclaimedWork(m, github, to('gpt-a'), true), { reassigned: [], reported: [] });
    // Still unclaimed after that: it never moves a second time; the leader is told, once.
    age(dir, w.id, AFTER + 60_000, 'reassignedAt');
    assert.deepEqual(await sweepUnclaimedWork(m, github, to('gpt-a'), true), { reassigned: [], reported: [w.id] });
    assert.equal((await m.workTarget('claude', w.id)).target, 'gpt-b');
    assert.deepEqual(await sweepUnclaimedWork(m, github, to('gpt-a'), true), { reassigned: [], reported: [] });
    const all = await leaderUpdates(m, w.id);
    assert.deepEqual(all.map(x => x.event), ['REASSIGNED_UNCLAIMED', 'UNCLAIMED_QUEUED']);
    assert.equal(moves.length, 1);
    const claimed = await m.claim('gpt-b', w.id);
    assert.equal(claimed.state, 'RUNNING');
    assert.equal(claimed.executionRequest?.model, 'model-b');
  });
}));

test('owner mode: work is not moved when it was ever claimed, is bound, or has nowhere to go', () => fixture(async (m, dir) => {
  await withOwner('1', async () => {
    // Claimed once and back in the queue: its first worker may have started; the leader decides.
    const touched = await m.delegate('claude', work('touched'));
    await m.claim('gpt-a', touched.id);
    patch(dir, touched.id, w => { w.leaseUntil = new Date(Date.now() - 60_000).toISOString(); });
    assert.deepEqual(await m.requeueExpiredReadOnly('gpt-a'), [touched.id]);
    age(dir, touched.id, AFTER + 60_000);
    assert.deepEqual(await m.reassignUnclaimed({ workId: touched.id, to: 'gpt-b' }), { workId: touched.id, reassigned: false, reason: 'ALREADY_CLAIMED' });
    assert.deepEqual(await sweepUnclaimedWork(m, noGitHub, to('gpt-b'), true), { reassigned: [], reported: [touched.id] });
    // No candidate at all, or only one without the role: reported.
    const alone = await m.delegate('claude', work('alone'));
    age(dir, alone.id, AFTER + 60_000);
    assert.deepEqual(await sweepUnclaimedWork(m, noGitHub, to(), true), { reassigned: [], reported: [alone.id] });
    await m.setProfile('claude', profile('grok', 'model-g', ['reviewer']), 0);
    const writer = await m.delegate('claude', work('writer', 'implementer'));
    assert.deepEqual(await m.reassignUnclaimed({ workId: writer.id, to: 'grok' }), { workId: writer.id, reassigned: false, reason: 'ROLE_NOT_CONFIGURED' });
    assert.deepEqual(await m.reassignUnclaimed({ workId: writer.id, to: 'gpt-a' }), { workId: writer.id, reassigned: false, reason: 'SAME_WORKER' });
    await assert.rejects(m.reassignUnclaimed({ workId: writer.id, to: 'claude' }), /Invalid worker/);
    // A second candidate is tried when the first is refused.
    age(dir, writer.id, AFTER + 60_000);
    assert.deepEqual((await sweepUnclaimedWork(m, noGitHub, to('grok', 'gpt-b'), true)).reassigned, [{ workId: writer.id, from: 'gpt-a', to: 'gpt-b' }]);
    assert.deepEqual(await m.reassignUnclaimed({ workId: writer.id, to: 'gpt-a' }), { workId: writer.id, reassigned: false, reason: 'ALREADY_REASSIGNED' });
    const done = await m.delegate('claude', work('done'));
    const c = await m.claim('gpt-a', done.id);
    await m.complete('gpt-a', done.id, c.attemptId!, c.leaseGeneration, 'ok');
    assert.deepEqual(await m.reassignUnclaimed({ workId: done.id, to: 'gpt-b' }), { workId: done.id, reassigned: false, reason: 'NOT_QUEUED' });
  });
}));

test('work queued behind a busy worker is waiting its turn: it may move to a free worker, but it is not reported', () => fixture(async (m, dir) => {
  const running = await m.delegate('claude', work('running'));
  const behind = await m.delegate('claude', work('behind'));
  const c = await m.claim('gpt-a', running.id);
  age(dir, behind.id, AFTER + 60_000);
  assert.equal((await m.unclaimedQueued(AFTER))[0]!.targetBusy, true);
  assert.deepEqual(await sweepUnclaimedWork(m, noGitHub, to('gpt-b'), false), { reassigned: [], reported: [] });
  assert.equal((await leaderUpdates(m, behind.id)).length, 0);
  // Once its worker is free and it is still there, it is reported like any other.
  await m.complete('gpt-a', running.id, c.attemptId!, c.leaseGeneration, 'done');
  assert.deepEqual(await sweepUnclaimedWork(m, noGitHub, to('gpt-b'), false), { reassigned: [], reported: [behind.id] });
  await withOwner('1', async () => {
    const busy = await m.delegate('claude', work('busy'));
    const next = await m.delegate('claude', work('next'));
    await m.claim('gpt-a', busy.id);
    age(dir, next.id, AFTER + 60_000);
    assert.deepEqual((await sweepUnclaimedWork(m, noGitHub, to('gpt-b'), true)).reassigned, [{ workId: next.id, from: 'gpt-a', to: 'gpt-b' }]);
  });
}));

test('the GitHub grant follows work that moves, and only a grant that never wrote anything', () => fixture(async (m, dir) => {
  await withOwner('1', async () => {
    const fetcher = (async () => new Response(JSON.stringify({ name: 'README.md' }), { status: 200 })) as unknown as typeof fetch;
    const env = { PANTER_GITHUB_WORKFORCE_TOKEN: 'ghs_' + 'x'.repeat(36), PANTER_GITHUB_WORKFORCE_REPOS: 'acme/*' };
    const gh = new GitHubWorkforce(dir, m, leaderHost, env, fetcher);
    const w = await m.delegate('claude', work('grant', 'implementer'));
    assert.equal(gh.rehost(w.id, 'gpt-a', 'gpt-b'), 'NONE', 'no grant: nothing to move');
    const grant = await gh.grant('claude', { workId: w.id, repository: 'acme/site', ops: ['commit', 'pr'], paths: ['docs'] });
    assert.equal(grant.branch, `panter/gpt-a-${w.id.slice(0, 8)}`);
    assert.equal(gh.rehost(w.id, 'gpt-b', 'gpt-a'), 'NOT_MOVED', 'the grant is not that worker\'s');
    age(dir, w.id, AFTER + 60_000);
    assert.deepEqual((await sweepUnclaimedWork(m, gh, to('gpt-b'), true)).reassigned, [{ workId: w.id, from: 'gpt-a', to: 'gpt-b' }]);
    assert.equal((await leaderUpdates(m, w.id))[0].githubGrant, 'MOVED');
    // The new worker can use it at once; nothing but the worker and the default branch name changed.
    const c = await m.claim('gpt-b', w.id);
    const claim = { workId: w.id, attemptId: c.attemptId!, leaseGeneration: c.leaseGeneration };
    await gh.read('gpt-b', claim, 'contents/README.md');
    await assert.rejects(gh.read('gpt-a', claim, 'contents/README.md'), /Work not found|Stale work lease/);
    const moved = (gh as any).current(w.id);
    assert.deepEqual({ host: moved.host, branch: moved.branch, repository: moved.repository, ops: moved.ops, paths: moved.paths, revokedAt: moved.revokedAt },
      { host: 'gpt-b', branch: `panter/gpt-b-${w.id.slice(0, 8)}`, repository: 'acme/site', ops: ['commit', 'pr'], paths: ['docs'], revokedAt: null });
    // A grant that reserved a write, or a revoked one, never moves.
    const used = await m.delegate('claude', work('used', 'implementer'));
    await gh.grant('claude', { workId: used.id, repository: 'acme/site', ops: ['commit'] });
    const ledger = SqliteLedger.open(dir);
    ledger.mutate('github_workforce', {} as any, (d: any) => { d.grants.find((g: any) => g.workId === used.id).writes = 1; });
    ledger.close();
    assert.equal(gh.rehost(used.id, 'gpt-a', 'gpt-b'), 'NOT_MOVED');
    const gone = await m.delegate('claude', work('gone', 'implementer'));
    await gh.grant('claude', { workId: gone.id, repository: 'acme/site', ops: ['commit'] });
    await gh.revoke('claude', gone.id);
    assert.equal(gh.rehost(gone.id, 'gpt-a', 'gpt-b'), 'NONE');
    // A branch name the leader chose by hand is kept as it is.
    const named = await m.delegate('claude', work('named', 'implementer'));
    await gh.grant('claude', { workId: named.id, repository: 'acme/site', ops: ['commit'], branch: 'panter/fix-typo' });
    assert.equal(gh.rehost(named.id, 'gpt-a', 'gpt-b'), 'MOVED');
    assert.equal((gh as any).current(named.id).branch, 'panter/fix-typo');
    assert.equal(new GitHubWorkforce(dir, m, leaderHost, {}).rehost(w.id, 'gpt-b', 'gpt-a'), 'NONE');
  });
}));
