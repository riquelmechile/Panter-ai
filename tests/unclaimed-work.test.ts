import assert from 'node:assert/strict';
import { test, before } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MeshEngine, type Host } from '../src/core/mesh.js';
import { SqliteLedger } from '../src/core/sqlite-ledger.js';
import { GitHubWorkforce } from '../src/core/github-workforce.js';
import { leaderHost } from '../src/core/leadership.js';
import { WorkforceEvents, WORK_EVENT, reconcileWorkforceEventOutbox, type EventPost } from '../src/core/workforce-events.js';
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
const noGitHub: UnclaimedGitHub = { rehostable: () => 'NONE', rehost: () => 'NONE' };
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
    const github: UnclaimedGitHub = { rehostable: () => 'OK', rehost: (id, from, dest) => { moves.push(`${id}:${from}>${dest}`); return 'MOVED'; } };
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
    assert.equal(await m.noteUnclaimed(w.id), false, 'claimed work is not unclaimed');
    assert.equal(await m.settleReassignment({ workId: w.id, grant: 'MOVED' }), false, 'a move is settled once');
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
    // Review of a mission never moves to the worker that writes that mission, nor the other way round.
    const author = await m.delegate('claude', { ...work('pair-write', 'implementer', 'gpt-b'), missionId: 'm-pair' });
    const review = await m.delegate('claude', { ...work('pair-review', 'reviewer', 'gpt-a'), missionId: 'm-pair' });
    assert.deepEqual(await m.reassignUnclaimed({ workId: review.id, to: 'gpt-b' }), { workId: review.id, reassigned: false, reason: 'NOT_INDEPENDENT' });
    assert.deepEqual(await m.reassignUnclaimed({ workId: author.id, to: 'gpt-a' }), { workId: author.id, reassigned: false, reason: 'NOT_INDEPENDENT' });
    assert.equal((await m.reassignUnclaimed({ workId: review.id, to: 'grok' })).reassigned, true);
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
    assert.equal(gh.rehost(w.id, 'gpt-b', 'grok'), 'NOT_MOVED', 'the grant is not that worker\'s');
    assert.equal(gh.rehost(w.id, 'gpt-b', 'gpt-a'), 'MOVED', 'already with that worker: nothing to do');
    assert.equal((gh as any).current(w.id).host, 'gpt-a');
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

test('a move the server could not finish is finished by the next pass: the grant follows and the leader is told once', () => fixture(async (m, dir) => {
  await withOwner('1', async () => {
    const fetcher = (async () => new Response(JSON.stringify({ name: 'README.md' }), { status: 200 })) as unknown as typeof fetch;
    const env = { PANTER_GITHUB_WORKFORCE_TOKEN: 'ghs_' + 'x'.repeat(36), PANTER_GITHUB_WORKFORCE_REPOS: 'acme/*' };
    const gh = new GitHubWorkforce(dir, m, leaderHost, env, fetcher);
    // The server stops right after the work moved: the grant is still the old worker's and nobody was told.
    const stopped = await m.delegate('claude', work('stopped', 'implementer'));
    await gh.grant('claude', { workId: stopped.id, repository: 'acme/site', ops: ['commit'] });
    assert.equal((await m.reassignUnclaimed({ workId: stopped.id, to: 'gpt-b' })).reassigned, true);
    assert.equal((gh as any).current(stopped.id).host, 'gpt-a');
    assert.deepEqual(await m.unsettledReassignments(), [{ workId: stopped.id, from: 'gpt-a', to: 'gpt-b' }]);
    assert.equal((await leaderUpdates(m, stopped.id)).length, 0);
    // A new process on the same data finishes it, whoever claimed in the meantime.
    const m2 = await MeshEngine.open(dir), gh2 = new GitHubWorkforce(dir, m2, leaderHost, env, fetcher);
    const c = await m2.claim('gpt-b', stopped.id);
    assert.deepEqual(await sweepUnclaimedWork(m2, gh2, to('gpt-b'), true), { reassigned: [{ workId: stopped.id, from: 'gpt-a', to: 'gpt-b' }], reported: [] });
    assert.equal((gh2 as any).current(stopped.id).host, 'gpt-b');
    await gh2.read('gpt-b', { workId: stopped.id, attemptId: c.attemptId!, leaseGeneration: c.leaseGeneration }, 'contents/README.md');
    assert.deepEqual((await leaderUpdates(m2, stopped.id)).map(x => [x.event, x.githubGrant]), [['REASSIGNED_UNCLAIMED', 'MOVED']]);
    assert.deepEqual(await m2.unsettledReassignments(), []);
    assert.deepEqual(await sweepUnclaimedWork(m2, gh2, to('gpt-b'), true), { reassigned: [], reported: [] });
    assert.equal((await leaderUpdates(m2, stopped.id)).length, 1);

    // The grant write fails once: the pass fails, the work stays marked unfinished, the next pass completes it.
    const flaky = await m.delegate('claude', work('flaky', 'implementer'));
    await gh.grant('claude', { workId: flaky.id, repository: 'acme/site', ops: ['commit'] });
    age(dir, flaky.id, AFTER + 60_000);
    let fail = true;
    const failing: UnclaimedGitHub = { rehostable: (id, from) => gh.rehostable(id, from),
      rehost: (id, from, dest) => { if (fail) { fail = false; throw new Error('ledger busy'); } return gh.rehost(id, from, dest); } };
    await assert.rejects(sweepUnclaimedWork(m, failing, to('gpt-b'), true), /ledger busy/);
    assert.equal((await m.workTarget('claude', flaky.id)).target, 'gpt-b');
    assert.equal((gh as any).current(flaky.id).host, 'gpt-a');
    assert.deepEqual((await sweepUnclaimedWork(m, failing, to('gpt-b'), true)).reassigned, [{ workId: flaky.id, from: 'gpt-a', to: 'gpt-b' }]);
    assert.equal((gh as any).current(flaky.id).host, 'gpt-b');
    assert.deepEqual((await leaderUpdates(m, flaky.id)).map(x => [x.event, x.githubGrant]), [['REASSIGNED_UNCLAIMED', 'MOVED']]);
    // Moving the grant is safe to repeat: same answer, nothing changes, one audit row.
    assert.equal(gh.rehost(flaky.id, 'gpt-a', 'gpt-b'), 'MOVED');
    const ledger = SqliteLedger.open(dir);
    assert.equal((ledger.read('github_workforce', {} as any) as any).audit.filter((a: any) => a.workId === flaky.id && a.op === 'rehost').length, 1);
    ledger.close();
  });
}));

test('a grant that cannot follow keeps its work where it is; a taken branch name never blocks a move', () => fixture(async (m, dir) => {
  await withOwner('1', async () => {
    const fetcher = (async () => new Response(JSON.stringify({ name: 'README.md' }), { status: 200 })) as unknown as typeof fetch;
    const env = { PANTER_GITHUB_WORKFORCE_TOKEN: 'ghs_' + 'x'.repeat(36), PANTER_GITHUB_WORKFORCE_REPOS: 'acme/*' };
    const gh = new GitHubWorkforce(dir, m, leaderHost, env, fetcher);
    // The grant already wrote something (not reachable for never-claimed work, but never trusted): nothing moves.
    const wrote = await m.delegate('claude', work('wrote', 'implementer'));
    await gh.grant('claude', { workId: wrote.id, repository: 'acme/site', ops: ['commit'] });
    const ledger = SqliteLedger.open(dir);
    ledger.mutate('github_workforce', {} as any, (d: any) => { d.grants.find((g: any) => g.workId === wrote.id).writes = 1; });
    ledger.close();
    assert.equal(gh.rehostable(wrote.id, 'gpt-a'), 'BLOCKED');
    age(dir, wrote.id, AFTER + 60_000);
    assert.deepEqual(await sweepUnclaimedWork(m, gh, to('gpt-b'), true), { reassigned: [], reported: [wrote.id] });
    assert.equal((await m.workTarget('claude', wrote.id)).target, 'gpt-a');
    assert.deepEqual((await leaderUpdates(m, wrote.id)).map(x => x.event), ['UNCLAIMED_QUEUED']);
    assert.deepEqual(await m.unsettledReassignments(), []);

    // Another grant in the repository already uses the name the branch would take: the grant keeps its own name.
    const taken = await m.delegate('claude', work('taken', 'implementer'));
    const other = await m.delegate('claude', { ...work('other', 'implementer', 'gpt-b'), missionId: 'm-other' });
    await gh.grant('claude', { workId: taken.id, repository: 'acme/site', ops: ['commit'] });
    await gh.grant('claude', { workId: other.id, repository: 'acme/site', ops: ['commit'], branch: `panter/gpt-b-${taken.id.slice(0, 8)}` });
    assert.equal(gh.rehostable(taken.id, 'gpt-a'), 'OK');
    age(dir, taken.id, AFTER + 60_000);
    assert.deepEqual((await sweepUnclaimedWork(m, gh, to('gpt-b'), true)).reassigned, [{ workId: taken.id, from: 'gpt-a', to: 'gpt-b' }]);
    const moved = (gh as any).current(taken.id);
    assert.deepEqual({ host: moved.host, branch: moved.branch }, { host: 'gpt-b', branch: `panter/gpt-a-${taken.id.slice(0, 8)}` });
    const c = await m.claim('gpt-b', taken.id);
    await gh.read('gpt-b', { workId: taken.id, attemptId: c.attemptId!, leaseGeneration: c.leaseGeneration }, 'contents/README.md');
    assert.equal((await leaderUpdates(m, taken.id))[0].githubGrant, 'MOVED');
    // If the grant changed between the check and the move, the leader is told what to do: nothing is left silent.
    const raced = await m.delegate('claude', work('raced', 'implementer'));
    age(dir, raced.id, AFTER + 60_000);
    const racing: UnclaimedGitHub = { rehostable: () => 'OK', rehost: () => 'NOT_MOVED' };
    assert.deepEqual((await sweepUnclaimedWork(m, racing, to('gpt-b'), true)).reassigned, [{ workId: raced.id, from: 'gpt-a', to: 'gpt-b' }]);
    const told = (await leaderUpdates(m, raced.id))[0];
    assert.equal(told.githubGrant, 'NOT_MOVED');
    assert.match(told.action, /Grant GitHub access to the new worker again/);
  });
}));

test('an event not sent yet for work that left a host\'s queue is cancelled; the new worker is rung instead', () => fixture(async (m, dir) => {
  await withOwner('1', async () => {
    const posted: Array<{ url: string; workId: string }> = [];
    let down = true;
    const post: EventPost = async (url, _headers, body) => {
      const parsed = JSON.parse(body) as { type?: string; challenge?: string; data?: { workId: string } };
      if (parsed.type === 'verification') return { status: 200, body: JSON.stringify({ challenge: parsed.challenge }) };
      if (down) return { status: 503, body: '' };
      posted.push({ url, workId: parsed.data!.workId });
      return { status: 204, body: '' };
    };
    const events = new WorkforceEvents(dir, post);
    const secret = 'whsec_' + Buffer.alloc(32, 7).toString('base64');
    const urlA = 'https://connectors.api.openai.com/mcp-events/host-a', urlB = 'https://connectors.api.openai.com/mcp-events/host-b';
    await events.subscribe('gpt-a', { name: WORK_EVENT, arguments: { host: 'gpt-a' }, delivery: { mode: 'webhook', url: urlA, secret } });
    await events.subscribe('gpt-b', { name: WORK_EVENT, arguments: { host: 'gpt-b' }, delivery: { mode: 'webhook', url: urlB, secret } });
    const reconcile = () => reconcileWorkforceEventOutbox(['gpt-a', 'gpt-b'], host => m.pending(host), events);
    // The old worker's receiver is failing: its event waits for a retry.
    const w = await m.delegate('claude', work('stale-ring'));
    await reconcile();
    assert.deepEqual({ pending: events.status('claude').pending, accepted: events.status('claude').accepted }, { pending: 1, accepted: 0 });
    // The work moves. The retry for the old worker is cancelled, not sent; the new worker gets its own event.
    assert.equal((await m.reassignUnclaimed({ workId: w.id, to: 'gpt-b' })).reassigned, true);
    down = false;
    const data = SqliteLedger.open(dir);
    data.mutate('events', {} as any, (d: any) => { for (const x of d.deliveries) x.nextAt = 0; });
    data.close();
    await reconcile();
    await reconcile();
    assert.deepEqual(posted, [{ url: urlB, workId: w.id }]);
    const status = events.status('claude');
    assert.deepEqual({ pending: status.pending, accepted: status.accepted, failed: status.failed, cancelled: status.cancelled }, { pending: 0, accepted: 1, failed: 0, cancelled: 1 });
    // Claimed work is not rung either: an event still waiting when its work is taken is cancelled the same way.
    down = true;
    const quick = await m.delegate('claude', work('quick'));
    await reconcile();
    await m.claim('gpt-a', quick.id);
    down = false;
    const again = SqliteLedger.open(dir);
    again.mutate('events', {} as any, (d: any) => { for (const x of d.deliveries) x.nextAt = 0; });
    again.close();
    await reconcile();
    assert.equal(posted.length, 1);
    // Work that comes back to the same host's queue is rung: a cancelled event is not a spent one.
    const back = await m.delegate('claude', work('back'));
    down = true;
    await reconcile();
    events.queue('gpt-a', []);
    down = false;
    await reconcile();
    assert.deepEqual(posted.at(-1), { url: urlA, workId: back.id });
  });
}));
