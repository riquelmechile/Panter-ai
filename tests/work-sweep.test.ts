import assert from 'node:assert/strict';
import { test, before } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MeshEngine } from '../src/core/mesh.js';
import { SqliteLedger } from '../src/core/sqlite-ledger.js';
import { GitHubWorkforce } from '../src/core/github-workforce.js';
import { leaderHost } from '../src/core/leadership.js';
import { sweepExpiredWork, parseSweepGrace, SWEEP_GRACE_SECONDS, SWEEP_SETTLE_SECONDS, type SweepGitHub } from '../src/core/work-sweep.js';
import { orderByAvailability, RECENT_ACTIVITY_MS } from '../src/core/owner-routing.js';

before(() => { process.env.PANTER_LEAD_HOST = 'claude'; });
const worker = { host: 'gpt-a' as const, actorId: 'actor-gpt-a', modelRequest: 'm', effortRequest: 'max', roles: ['reviewer' as const, 'implementer' as const] };
const HOUR = 3600_000;
const GRACE = 6 * HOUR;

async function fixture(fn: (m: MeshEngine, dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'panter-sweep-'));
  try { const m = await MeshEngine.open(dir); await m.setProfile('claude', worker, 0); await fn(m, dir); }
  finally { await rm(dir, { recursive: true, force: true }); }
}
async function withOwner<T>(value: '0' | '1', fn: () => Promise<T>): Promise<T> {
  const prior = process.env.PANTER_OWNER_MODE;
  process.env.PANTER_OWNER_MODE = value;
  try { return await fn(); } finally { if (prior === undefined) delete process.env.PANTER_OWNER_MODE; else process.env.PANTER_OWNER_MODE = prior; }
}
/** Set one work's lease end to fromNowMs from now (negative: already expired). */
function setLease(dir: string, workId: string, fromNowMs: number) {
  const db = SqliteLedger.open(dir);
  db.mutate('mesh', {} as any, (d: any) => { d.works.find((w: any) => w.id === workId).leaseUntil = new Date(Date.now() + fromNowMs).toISOString(); });
  db.close();
}
const work = (key: string, role: 'reviewer' | 'implementer') => ({ missionId: 'm-' + key, target: 'gpt-a' as const, role, instruction: 'do the work', idempotencyKey: key });
const delegateWriter = (m: MeshEngine, key: string) => withOwner('1', () => m.delegate('claude', work(key, 'implementer')));
const stateOf = async (m: MeshEngine, id: string) => (await m.workTarget('claude', id)).state;
const leaderUpdates = async (m: MeshEngine, id: string) => (await m.inbox('claude')).messages.filter(x => x.workId === id && x.kind === 'UPDATE').map(x => JSON.parse(x.text));
type Seen = Awaited<ReturnType<SweepGitHub['effects']>>;
/** Fake GitHub side of the sweep: scripted answers per work, and a record of what was revoked. */
function fakeGitHub(answers: Record<string, Seen | Error>) {
  const revoked: string[] = [], asked: string[] = [];
  const github: SweepGitHub = {
    effects: async id => { asked.push(id); const a = answers[id]; if (a instanceof Error) throw a; return a ?? { known: false, reason: 'The work has no GitHub grant with a working branch' }; },
    revokeEnded: id => { revoked.push(id); return true; },
  };
  return { github, revoked, asked };
}
const nothing = (branch: string): Seen => ({ known: true, repository: 'acme/site', branch, branchExists: false, pulls: [], writes: 0, createdBranch: false, opened: 0 });
/** One pass that looks at uncertain writers at once (no settle time): the verdict rules are tested apart from the wait. */
const sweepNow = (m: MeshEngine, github: SweepGitHub) => sweepExpiredWork(m, github, SWEEP_GRACE_SECONDS, 0);
/** Move the moment a writer became uncertain into the past. */
function ageUncertain(dir: string, workId: string, agoMs: number) {
  const db = SqliteLedger.open(dir);
  db.mutate('mesh', {} as any, (d: any) => { d.works.find((w: any) => w.id === workId).uncertainAt = new Date(Date.now() - agoMs).toISOString(); });
  db.close();
}

test('the sweep grace is 6 hours by default and bounded when configured', () => {
  assert.equal(SWEEP_GRACE_SECONDS, 21600);
  assert.equal(parseSweepGrace(undefined), 21600);
  assert.equal(parseSweepGrace(' '), 21600);
  assert.equal(parseSweepGrace('900'), 900);
  assert.equal(parseSweepGrace('604800'), 604800);
  for (const bad of ['899', '604801', '0', '-1', '1.5', 'soon']) assert.throws(() => parseSweepGrace(bad), /PANTER_SWEEP_GRACE_SECONDS/, bad);
});

test('read-only work whose lease ran out long ago is ended without effects and the leader is told once', () => fixture(async (m, dir) => {
  const old = await m.delegate('claude', work('old', 'reviewer'));
  const recent = await m.delegate('claude', work('recent', 'reviewer'));
  const live = await m.delegate('claude', work('live', 'reviewer'));
  const queued = await m.delegate('claude', work('queued', 'reviewer'));
  const c = await m.claim('gpt-a', old.id);
  const r = await m.claim('gpt-a', recent.id);
  await m.claim('gpt-a', live.id);
  setLease(dir, old.id, -(GRACE + 60_000));
  setLease(dir, recent.id, -HOUR);
  const { github, revoked } = fakeGitHub({});
  const report = await sweepExpiredWork(m, github);
  assert.deepEqual(report, { abandoned: [old.id], uncertain: [], cleared: [], reported: [], deferred: [] });
  assert.equal(await stateOf(m, old.id), 'ABORTED_NO_EFFECTS');
  assert.deepEqual(revoked, [old.id], 'its GitHub grant, if any, is closed');
  const seen = await leaderUpdates(m, old.id);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].event, 'SWEPT_EXPIRED_READ_ONLY');
  assert.equal(seen[0].target, 'gpt-a');
  // The swept attempt is fenced out: a result that arrives after the sweep is refused.
  await assert.rejects(m.complete('gpt-a', old.id, c.attemptId!, c.leaseGeneration, 'late'), /Stale work lease/);
  // Inside the grace the same attempt still finishes late; live and queued work are never touched.
  assert.equal(await stateOf(m, recent.id), 'RUNNING');
  assert.equal((await m.complete('gpt-a', recent.id, r.attemptId!, r.leaseGeneration, 'late but in time')).state, 'COMPLETED');
  assert.equal(await stateOf(m, live.id), 'RUNNING');
  assert.equal(await stateOf(m, queued.id), 'QUEUED');
  // A second pass finds nothing and tells nobody again.
  assert.deepEqual(await sweepExpiredWork(m, github), { abandoned: [], uncertain: [], cleared: [], reported: [], deferred: [] });
  assert.equal((await leaderUpdates(m, old.id)).length, 1);
}));

test('work held by a transport is left to that transport', () => fixture(async (m, dir) => {
  const mailed = await m.delegate('claude', work('mailed', 'reviewer'));
  await m.claim('gpt-a', mailed.id, 300, true, true, true);
  setLease(dir, mailed.id, -(GRACE + 60_000));
  const { github } = fakeGitHub({});
  assert.deepEqual((await sweepExpiredWork(m, github)).abandoned, []);
  assert.equal(await stateOf(m, mailed.id), 'RUNNING');
}));

test('outside owner mode an expired writer becomes OUTCOME_UNKNOWN, keeps its scope and waits for the operator', () => fixture(async (m, dir) => {
  const writer = await delegateWriter(m, 'strict');
  const c = await m.claim('gpt-a', writer.id);
  setLease(dir, writer.id, -(GRACE + 60_000));
  const { github, revoked, asked } = fakeGitHub({ [writer.id]: nothing('panter/gpt-a-strict') });
  await withOwner('0', async () => {
    const report = await sweepNow(m, github);
    assert.deepEqual(report, { abandoned: [], uncertain: [writer.id], cleared: [], reported: [writer.id], deferred: [] });
    assert.equal(await stateOf(m, writer.id), 'OUTCOME_UNKNOWN', 'nothing found is not enough to release a writer here');
    assert.deepEqual(revoked, []);
    const seen = await leaderUpdates(m, writer.id);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].event, 'UNCERTAIN_WRITER_NEEDS_RECONCILIATION');
    assert.equal(seen[0].effects, 'NONE');
    assert.equal(seen[0].attemptId, c.attemptId, 'the leader gets the fence the operator needs');
    assert.equal(seen[0].leaseGeneration, c.leaseGeneration);
    await assert.rejects(m.complete('gpt-a', writer.id, c.attemptId!, c.leaseGeneration, '{}'), /Stale work lease/);
    // Looked at once: later passes neither ask GitHub nor write to the leader again.
    await sweepNow(m, github);
    assert.deepEqual(asked, [writer.id]);
    assert.equal((await leaderUpdates(m, writer.id)).length, 1);
    // The operator's fenced decision still closes it.
    const done = await m.reconcileWriter({ workId: writer.id, attemptId: c.attemptId!, leaseGeneration: c.leaseGeneration, resolution: 'CONFIRMED_NO_EFFECTS',
      evidence: 'Operator checked the repository: no branch, no pull request, no commit.', isolationEvidence: 'Operator confirmed the worker session is closed and its grant is revoked.' });
    assert.equal(done.state, 'ABORTED_NO_EFFECTS');
  });
}));

test('owner mode: an expired writer that left nothing is closed without effects; one that left something never is', () => fixture(async (m, dir) => {
  await withOwner('1', async () => {
    const clean = await m.delegate('claude', work('clean', 'implementer'));
    const dirty = await m.delegate('claude', work('dirty', 'implementer'));
    const blind = await m.delegate('claude', work('blind', 'implementer'));
    const a = await m.claim('gpt-a', clean.id), b = await m.claim('gpt-a', dirty.id);
    await m.claim('gpt-a', blind.id);
    for (const w of [clean, dirty, blind]) setLease(dir, w.id, -(GRACE + 60_000));
    const { github, revoked } = fakeGitHub({
      [clean.id]: nothing('panter/gpt-a-clean'),
      [dirty.id]: { known: true, repository: 'acme/site', branch: 'panter/gpt-a-dirty', branchExists: true, pulls: [87], writes: 3, createdBranch: true, opened: 1 },
    });
    const report = await sweepNow(m, github);
    assert.deepEqual(report.uncertain.sort(), [clean.id, dirty.id, blind.id].sort());
    assert.deepEqual(report.cleared, [clean.id]);
    assert.deepEqual(report.reported.sort(), [dirty.id, blind.id].sort());
    assert.deepEqual(revoked, [clean.id]);

    assert.equal(await stateOf(m, clean.id), 'ABORTED_NO_EFFECTS');
    const cleared = await leaderUpdates(m, clean.id);
    assert.equal(cleared[0].event, 'SWEPT_WRITER_NO_EFFECTS');
    assert.match(cleared[0].evidence, /branch panter\/gpt-a-clean does not exist; pull requests from it: none; writes reserved by its grant: 0; branch created by its grant: no; pull requests and issues it opened: 0/);
    await assert.rejects(m.complete('gpt-a', clean.id, a.attemptId!, a.leaseGeneration, '{}'), /Stale work lease/);
    // Its scope is free again: the same mission can get a new writer.
    assert.equal((await m.delegate('claude', { ...work('clean', 'implementer'), idempotencyKey: 'clean-2' })).state, 'QUEUED');

    assert.equal(await stateOf(m, dirty.id), 'OUTCOME_UNKNOWN');
    const found = await leaderUpdates(m, dirty.id);
    assert.equal(found[0].event, 'UNCERTAIN_WRITER_NEEDS_RECONCILIATION');
    assert.equal(found[0].effects, 'FOUND');
    assert.match(found[0].evidence, /branch panter\/gpt-a-dirty exists; pull requests from it: #87; writes reserved by its grant: 3; branch created by its grant: yes; pull requests and issues it opened: 1/);
    assert.equal(found[0].attemptId, b.attemptId);
    await assert.rejects(m.delegate('claude', { ...work('dirty', 'implementer'), idempotencyKey: 'dirty-2' }), /Overlapping active writer/);

    // No grant to look at: Panter cannot tell, so it never closes the work on its own.
    assert.equal(await stateOf(m, blind.id), 'OUTCOME_UNKNOWN');
    assert.equal((await leaderUpdates(m, blind.id))[0].effects, 'UNVERIFIABLE');
  });
}));

test('a GitHub failure defers the verdict to the next pass instead of guessing', () => fixture(async (m, dir) => {
  await withOwner('1', async () => {
    const writer = await m.delegate('claude', work('flaky', 'implementer'));
    await m.claim('gpt-a', writer.id);
    setLease(dir, writer.id, -(GRACE + 60_000));
    const answers: Record<string, Seen | Error> = { [writer.id]: new Error('GitHub branch lookup failed (HTTP 502)') };
    const { github } = fakeGitHub(answers);
    const first = await sweepNow(m, github);
    assert.deepEqual(first.deferred, [writer.id]);
    assert.equal(await stateOf(m, writer.id), 'OUTCOME_UNKNOWN');
    assert.equal((await leaderUpdates(m, writer.id)).length, 0);
    answers[writer.id] = nothing('panter/gpt-a-flaky');
    assert.deepEqual((await sweepNow(m, github)).cleared, [writer.id]);
  });
}));

test('a writer is looked at only after it has been uncertain for the settle time: a write in flight can still land', () => fixture(async (m, dir) => {
  assert.equal(SWEEP_SETTLE_SECONDS, 600);
  await withOwner('1', async () => {
    const writer = await m.delegate('claude', work('settle', 'implementer'));
    await m.claim('gpt-a', writer.id);
    setLease(dir, writer.id, -(GRACE + 60_000));
    // The grant looks clean now; a commit authorized just before the sweep is still on its way to GitHub.
    const answers: Record<string, Seen | Error> = { [writer.id]: nothing('panter/gpt-a-settle') };
    const { github, asked, revoked } = fakeGitHub(answers);
    const first = await sweepExpiredWork(m, github);
    assert.deepEqual(first, { abandoned: [], uncertain: [writer.id], cleared: [], reported: [], deferred: [] });
    assert.deepEqual(asked, [], 'not looked at in the pass that marked it');
    assert.equal(await stateOf(m, writer.id), 'OUTCOME_UNKNOWN');
    // Still inside the settle time on the next pass.
    ageUncertain(dir, writer.id, (SWEEP_SETTLE_SECONDS - 60) * 1000);
    await sweepExpiredWork(m, github);
    assert.deepEqual(asked, []);
    // The commit landed meanwhile. After the settle time the sweep sees it and never closes the work.
    answers[writer.id] = { known: true, repository: 'acme/site', branch: 'panter/gpt-a-settle', branchExists: true, pulls: [], writes: 1, createdBranch: true, opened: 0 };
    ageUncertain(dir, writer.id, (SWEEP_SETTLE_SECONDS + 60) * 1000);
    const later = await sweepExpiredWork(m, github);
    assert.deepEqual(asked, [writer.id]);
    assert.deepEqual(later.reported, [writer.id]);
    assert.deepEqual(revoked, []);
    assert.equal(await stateOf(m, writer.id), 'OUTCOME_UNKNOWN');
    assert.equal((await leaderUpdates(m, writer.id))[0].effects, 'FOUND');
  });
}));

test('what the grant durably recorded is enough to keep a writer from being closed, with nothing left on GitHub', () => fixture(async (m, dir) => {
  await withOwner('1', async () => {
    for (const [key, seen] of [
      ['wrote', { ...nothing('panter/gpt-a-wrote'), writes: 2 }],
      ['branched', { ...nothing('panter/gpt-a-branched'), createdBranch: true }],
      ['opened', { ...nothing('panter/gpt-a-opened'), opened: 1 }],
    ] as const) {
      const writer = await m.delegate('claude', work(key, 'implementer'));
      await m.claim('gpt-a', writer.id);
      setLease(dir, writer.id, -(GRACE + 60_000));
      const { github, revoked } = fakeGitHub({ [writer.id]: seen as Seen });
      const report = await sweepNow(m, github);
      assert.deepEqual(report.cleared, [], key);
      assert.deepEqual(report.reported, [writer.id], key);
      assert.deepEqual(revoked, [], key);
      assert.equal(await stateOf(m, writer.id), 'OUTCOME_UNKNOWN', key);
    }
  });
}));

test('a writer already of unknown outcome (claimed again after expiry) is looked at by the sweep too', () => fixture(async (m, dir) => {
  await withOwner('1', async () => {
    const writer = await m.delegate('claude', work('reclaimed', 'implementer'));
    await m.claim('gpt-a', writer.id);
    setLease(dir, writer.id, -60_000);
    assert.equal((await m.claim('gpt-a', writer.id)).state, 'OUTCOME_UNKNOWN');
    const { github, asked } = fakeGitHub({ [writer.id]: nothing('panter/gpt-a-reclaimed') });
    // It became uncertain a moment ago, so it waits like any other; a ledger from before the timestamp does not.
    assert.deepEqual((await sweepExpiredWork(m, github)).cleared, []);
    assert.deepEqual(asked, []);
    const db = SqliteLedger.open(dir);
    db.mutate('mesh', {} as any, (d: any) => { delete d.works.find((w: any) => w.id === writer.id).uncertainAt; });
    db.close();
    const report = await sweepExpiredWork(m, github);
    assert.deepEqual(report.uncertain, [], 'it was not RUNNING any more');
    assert.deepEqual(report.cleared, [writer.id]);
  });
}));

test('what a work left: its own branch and pull requests on GitHub, and what its grant durably recorded', () => fixture(async (m, dir) => {
  let branchStatus = 404, pulls: unknown = [], fail = false;
  const calls: string[] = [];
  const fetcher = (async (url: string) => {
    const u = new URL(url); calls.push(u.pathname + u.search);
    if (fail) return new Response('{}', { status: 502 });
    if (u.pathname.includes('/branches/')) return new Response(JSON.stringify(branchStatus === 200 ? { name: 'x' } : { message: 'Branch not found' }), { status: branchStatus });
    if (u.pathname.endsWith('/pulls')) return new Response(JSON.stringify(pulls), { status: 200 });
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;
  const env = { PANTER_GITHUB_WORKFORCE_TOKEN: 'ghs_' + 'x'.repeat(36), PANTER_GITHUB_WORKFORCE_REPOS: 'acme/*' };
  const gh = new GitHubWorkforce(dir, m, leaderHost, env, fetcher);
  const writer = await delegateWriter(m, 'effects');
  assert.deepEqual(await gh.effects(writer.id), { known: false, reason: 'The work has no GitHub grant with a working branch' });
  assert.equal(gh.revokeEnded(writer.id), false, 'no grant: nothing to close, and no tombstone is left behind');
  const grant = await gh.grant('claude', { workId: writer.id, repository: 'acme/site', ops: ['commit', 'pr'] });
  assert.deepEqual(await gh.effects(writer.id), { known: true, repository: 'acme/site', branch: grant.branch, branchExists: false, pulls: [], writes: 0, createdBranch: false, opened: 0 });
  assert.ok(calls.some(c => c === `/repos/acme/site/branches/${grant.branch}`));
  assert.ok(calls.some(c => c.startsWith('/repos/acme/site/pulls?') && c.includes('state=all') && c.includes(encodeURIComponent(`acme:${grant.branch}`))));
  branchStatus = 200; pulls = [{ number: 87 }, { number: 90 }];
  assert.deepEqual(await gh.effects(writer.id), { known: true, repository: 'acme/site', branch: grant.branch, branchExists: true, pulls: [87, 90], writes: 0, createdBranch: false, opened: 0 });
  // What the grant itself recorded survives everything: the branch deleted, the pull requests gone and every audit
  // row evicted (the audit keeps only its latest entries). The write budget is reserved before each write.
  branchStatus = 404; pulls = [];
  const ledger = SqliteLedger.open(dir);
  ledger.mutate('github_workforce', {} as any, (d: any) => {
    const g = d.grants.find((x: any) => x.workId === writer.id);
    g.writes = 2; g.branchCreated = true; g.createdBranch = { repository: 'acme/site', branch: g.branch, lastSha: 'c0ffee' }; g.own = [87];
    d.audit = [];
  });
  ledger.close();
  assert.deepEqual(await gh.effects(writer.id), { known: true, repository: 'acme/site', branch: grant.branch, branchExists: false, pulls: [], writes: 2, createdBranch: true, opened: 1 });
  fail = true;
  await assert.rejects(gh.effects(writer.id), /GitHub branch lookup failed \(HTTP 502\)/);
  assert.equal(gh.revokeEnded(writer.id), true);
  assert.equal(gh.revokeEnded(writer.id), false, 'idempotent');
  const off = new GitHubWorkforce(dir, m, leaderHost, {});
  assert.deepEqual(await off.effects(writer.id), { known: false, reason: 'GitHub workforce is not configured' });
  assert.equal(off.revokeEnded(writer.id), false);
}));

test('load counts only work a host really has ahead: expired claims and uncertain writers are not load', () => fixture(async (m, dir) => {
  const queued = await m.delegate('claude', work('q', 'reviewer'));
  const live = await m.delegate('claude', work('l', 'reviewer'));
  const dead = await m.delegate('claude', work('d', 'reviewer'));
  const lost = await delegateWriter(m, 'lost');
  await m.claim('gpt-a', live.id); await m.claim('gpt-a', dead.id); await m.claim('gpt-a', lost.id);
  assert.equal((await m.loadByHost())['gpt-a'], 4);
  setLease(dir, dead.id, -60_000);
  setLease(dir, lost.id, -60_000);
  assert.equal((await m.loadByHost())['gpt-a'], 2, 'the queued and the live one');
  await m.claim('gpt-a', lost.id);
  assert.equal(await stateOf(m, lost.id), 'OUTCOME_UNKNOWN');
  assert.equal((await m.loadByHost())['gpt-a'], 2);
  assert.ok(queued.id);
}));

test('auto-delegation prefers workers that answered recently, then the least loaded; nobody is excluded', async () => {
  const now = Date.parse('2026-11-19T12:00:00Z');
  const ago = (ms: number) => new Date(now - ms).toISOString();
  const order = ['gpt-a', 'gpt-b', 'grok', 'gemini'] as const;
  // The audited case: zombies made the hosts that answer look loaded, and the ones that had not answered look free.
  assert.deepEqual(orderByAvailability(order, { 'gpt-a': 2, 'gpt-b': 1, grok: 0, gemini: 0 },
    { 'gpt-a': ago(HOUR), 'gpt-b': ago(2 * HOUR), grok: ago(9 * 24 * HOUR), gemini: ago(14 * 24 * HOUR) }, order, now),
    ['gpt-b', 'gpt-a', 'grok', 'gemini']);
  // Same recency: least loaded, then the configured order.
  assert.deepEqual(orderByAvailability(order, { 'gpt-a': 1, 'gpt-b': 1 }, { 'gpt-a': ago(1), 'gpt-b': ago(1), grok: ago(1), gemini: ago(1) }, order, now),
    ['grok', 'gemini', 'gpt-a', 'gpt-b']);
  // Never seen, or seen exactly at the edge of the window.
  assert.deepEqual(orderByAvailability(['gpt-a', 'grok'] as const, {}, { grok: ago(RECENT_ACTIVITY_MS) }, order, now), ['grok', 'gpt-a']);
  assert.deepEqual(orderByAvailability(['gpt-a', 'grok'] as const, {}, {}, order, now), ['gpt-a', 'grok']);
  await fixture(async m => {
    const w = await m.delegate('claude', work('seen', 'reviewer'));
    assert.deepEqual(await m.lastWorkerActivity(), {});
    await m.claim('gpt-a', w.id, 300, true, true, true);
    assert.deepEqual(await m.lastWorkerActivity(), {}, 'a transport claim is not the worker answering');
  });
});
