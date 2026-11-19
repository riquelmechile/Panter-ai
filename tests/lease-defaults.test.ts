import assert from 'node:assert/strict';
import { test, before } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MeshEngine, WRITER_LEASE_SECONDS, READ_ONLY_LEASE_SECONDS, defaultLeaseSeconds } from '../src/core/mesh.js';
import { SqliteLedger } from '../src/core/sqlite-ledger.js';
import { GitHubWorkforce } from '../src/core/github-workforce.js';
import { leaderHost } from '../src/core/leadership.js';

before(() => { process.env.PANTER_LEAD_HOST = 'claude'; });
const worker = { host: 'gpt-a' as const, actorId: 'actor-gpt-a', modelRequest: 'm', effortRequest: 'max', roles: ['reviewer' as const, 'implementer' as const] };

async function fixture(fn: (m: MeshEngine, dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'panter-lease-defaults-'));
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
const leftSeconds = (leaseUntil: string | null) => Math.round((Date.parse(leaseUntil ?? '') - Date.now()) / 1000);
const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) <= 5, `${actual} is not about ${expected}`);
const work = (key: string, role: 'reviewer' | 'implementer') => ({ missionId: 'm-' + key, target: 'gpt-a' as const, role, instruction: 'do the work', idempotencyKey: key });
/** A writer can only be delegated directly in owner mode; the lease rules under test apply in every mode. */
const delegateWriter = (m: MeshEngine, key: string) => withOwner('1', () => m.delegate('claude', work(key, 'implementer')));
const leaseOf = async (m: MeshEngine, id: string) => (await m.workTarget('claude', id)).leaseUntil;

test('a claim without leaseSeconds gets the role default: an hour for a writer, 15 minutes for read-only work', () => fixture(async m => {
  assert.equal(defaultLeaseSeconds('implementer'), WRITER_LEASE_SECONDS);
  assert.equal(defaultLeaseSeconds('reviewer'), READ_ONLY_LEASE_SECONDS);
  assert.equal(WRITER_LEASE_SECONDS, 3600);
  assert.equal(READ_ONLY_LEASE_SECONDS, 900);
  const review = await m.delegate('claude', work('r', 'reviewer'));
  near(leftSeconds((await m.claim('gpt-a', review.id)).leaseUntil), 900);
  const writer = await delegateWriter(m, 'w');
  near(leftSeconds((await m.claim('gpt-a', writer.id)).leaseUntil), 3600);
}));

test('an explicit leaseSeconds is still honoured and still bounded', () => fixture(async m => {
  const review = await m.delegate('claude', work('explicit', 'reviewer'));
  await assert.rejects(m.claim('gpt-a', review.id, 29), /Invalid lease/);
  await assert.rejects(m.claim('gpt-a', review.id, 3601), /Invalid lease/);
  const c = await m.claim('gpt-a', review.id, 120);
  near(leftSeconds(c.leaseUntil), 120);
  await assert.rejects(m.heartbeat('gpt-a', review.id, c.attemptId!, c.leaseGeneration, 3601), /Invalid lease/);
  near(leftSeconds((await m.heartbeat('gpt-a', review.id, c.attemptId!, c.leaseGeneration, 300)).leaseUntil), 300);
  // A heartbeat that names no lease renews for the role default.
  near(leftSeconds((await m.heartbeat('gpt-a', review.id, c.attemptId!, c.leaseGeneration)).leaseUntil), 900);
}));

test('pickup without leaseSeconds uses the default of the role it picked up', () => fixture(async m => {
  const writer = await delegateWriter(m, 'pick-w');
  const picked = await m.pickup('gpt-a');
  assert.equal(picked.status, 'CLAIMED');
  assert.equal((picked as any).work.id, writer.id);
  near(leftSeconds((picked as any).work.leaseUntil), 3600);
  await assert.rejects(m.pickup('gpt-a', 10), /Invalid lease/);
}));

test('claimedAt records when the worker itself claimed; a transport claim is not the worker showing up', () => fixture(async (m, dir) => {
  const review = await m.delegate('claude', work('claimed', 'reviewer'));
  assert.equal((await m.workTarget('claude', review.id)).claimedAt, null);
  const held = await m.claim('gpt-a', review.id, 300, true, true, true);
  assert.equal((await m.workTarget('claude', review.id)).claimedAt, null, 'a transport holding the task is not a worker claim');
  await m.releaseUnsentClaim('gpt-a', review.id, held.attemptId!, held.leaseGeneration);
  const started = Date.now();
  await m.claim('gpt-a', review.id);
  const claimedAt = (await m.workTarget('claude', review.id)).claimedAt;
  assert.ok(claimedAt && Math.abs(Date.parse(claimedAt) - started) < 5000);
  assert.equal((await m.inbox('claude')).works.find(w => w.id === review.id)?.claimedAt, claimedAt);
  // Back in the queue, nobody holds it: the old claim time is gone.
  setLease(dir, review.id, -60_000);
  assert.deepEqual(await m.requeueExpiredReadOnly('gpt-a'), [review.id]);
  assert.equal((await m.workTarget('claude', review.id)).claimedAt, null);
}));

test('implicit heartbeat renews a lease that is running low, with the same fence as an explicit one', () => fixture(async (m, dir) => {
  const review = await m.delegate('claude', work('implicit', 'reviewer'));
  const c = await m.claim('gpt-a', review.id);
  // Plenty of lease left: nothing is written.
  const untouched = await leaseOf(m, review.id);
  assert.equal(await m.renewOnActivity('gpt-a', review.id, c.attemptId!, c.leaseGeneration), false);
  assert.equal(await leaseOf(m, review.id), untouched);
  // Less than half the default left: renewed for the role default, never shortened.
  setLease(dir, review.id, 60_000);
  assert.equal(await m.renewOnActivity('gpt-a', review.id, c.attemptId!, c.leaseGeneration), true);
  near(leftSeconds(await leaseOf(m, review.id)), 900);
  // Another attempt, another host or the leader never renews it.
  setLease(dir, review.id, 60_000);
  assert.equal(await m.renewOnActivity('gpt-a', review.id, crypto.randomUUID(), c.leaseGeneration), false);
  assert.equal(await m.renewOnActivity('gpt-a', review.id, c.attemptId!, c.leaseGeneration + 1), false);
  assert.equal(await m.renewOnActivity('gpt-b', review.id, c.attemptId!, c.leaseGeneration), false);
  assert.equal(await m.renewOnActivity('claude', review.id, c.attemptId!, c.leaseGeneration), false);
  near(leftSeconds(await leaseOf(m, review.id)), 60);
  // Read-only work whose lease already ran out is revived, like an explicit heartbeat.
  setLease(dir, review.id, -60_000);
  assert.equal(await m.renewOnActivity('gpt-a', review.id, c.attemptId!, c.leaseGeneration), true);
  near(leftSeconds(await leaseOf(m, review.id)), 900);
  // Finished work is never touched.
  await m.complete('gpt-a', review.id, c.attemptId!, c.leaseGeneration, 'done');
  assert.equal(await m.renewOnActivity('gpt-a', review.id, c.attemptId!, c.leaseGeneration), false);
}));

test('outside owner mode an expired writer stays strict: no implicit renewal either', () => fixture(async (m, dir) => {
  const writer = await delegateWriter(m, 'strict');
  const c = await m.claim('gpt-a', writer.id);
  await withOwner('0', async () => {
    setLease(dir, writer.id, 60_000);
    assert.equal(await m.renewOnActivity('gpt-a', writer.id, c.attemptId!, c.leaseGeneration), true, 'a live writer lease is renewed');
    near(leftSeconds(await leaseOf(m, writer.id)), 3600);
    setLease(dir, writer.id, -60_000);
    assert.equal(await m.renewOnActivity('gpt-a', writer.id, c.attemptId!, c.leaseGeneration), false);
    await assert.rejects(m.heartbeat('gpt-a', writer.id, c.attemptId!, c.leaseGeneration), /Lease expired/);
    await assert.rejects(m.complete('gpt-a', writer.id, c.attemptId!, c.leaseGeneration, '{}'), /Lease expired/);
  });
}));

test('owner mode: a writer whose lease ran out finishes late while its fence holds; a second claim never adopts it', () => fixture(async (m, dir) => {
  await withOwner('1', async () => {
    const late = await m.delegate('claude', work('late', 'implementer'));
    const c = await m.claim('gpt-a', late.id);
    setLease(dir, late.id, -60_000);
    near(leftSeconds((await m.heartbeat('gpt-a', late.id, c.attemptId!, c.leaseGeneration)).leaseUntil), 3600);
    setLease(dir, late.id, -60_000);
    assert.equal((await m.complete('gpt-a', late.id, c.attemptId!, c.leaseGeneration, '{"pr":1}')).state, 'COMPLETED');

    const lost = await m.delegate('claude', work('lost', 'implementer'));
    const first = await m.claim('gpt-a', lost.id);
    setLease(dir, lost.id, -60_000);
    // Claiming again is a new attempt asking to adopt an uncertain write: still refused, in every mode.
    assert.equal((await m.claim('gpt-a', lost.id)).state, 'OUTCOME_UNKNOWN');
    await assert.rejects(m.complete('gpt-a', lost.id, first.attemptId!, first.leaseGeneration, '{}'), /Stale work lease/);
    await assert.rejects(m.heartbeat('gpt-a', lost.id, first.attemptId!, first.leaseGeneration), /Stale work lease/);
    assert.equal(await m.renewOnActivity('gpt-a', lost.id, first.attemptId!, first.leaseGeneration), false);
  });
}));

test('a worker message about its own running work renews the lease; the leader answering does not', () => fixture(async (m, dir) => {
  const review = await m.delegate('claude', work('msg', 'reviewer'));
  await m.claim('gpt-a', review.id);
  setLease(dir, review.id, 60_000);
  await m.message('claude', { missionId: review.missionId, to: 'gpt-a', workId: review.id, kind: 'UPDATE', text: 'any news?' });
  near(leftSeconds(await leaseOf(m, review.id)), 60);
  await m.message('gpt-a', { missionId: review.missionId, to: 'claude', workId: review.id, kind: 'UPDATE', text: 'halfway there' });
  near(leftSeconds(await leaseOf(m, review.id)), 900);
  // A longer lease the worker asked for is never shortened by a message.
  setLease(dir, review.id, 3_000_000);
  await m.message('gpt-a', { missionId: review.missionId, to: 'claude', workId: review.id, kind: 'UPDATE', text: 'still going' });
  near(leftSeconds(await leaseOf(m, review.id)), 3000);
}));

test('a GitHub call through the work grant is an implicit heartbeat; a strict expired writer is still refused', () => fixture(async (m, dir) => {
  const fetcher = (async () => new Response(JSON.stringify({ name: 'README.md' }), { status: 200 })) as unknown as typeof fetch;
  const env = { PANTER_GITHUB_WORKFORCE_TOKEN: 'ghs_' + 'x'.repeat(36), PANTER_GITHUB_WORKFORCE_REPOS: 'acme/*' };
  const gh = new GitHubWorkforce(dir, m, leaderHost, env, fetcher);
  const writer = await delegateWriter(m, 'gh');
  const c = await m.claim('gpt-a', writer.id);
  const claim = { workId: writer.id, attemptId: c.attemptId!, leaseGeneration: c.leaseGeneration };
  await gh.grant('claude', { workId: writer.id, repository: 'acme/site', ops: ['commit', 'pr'] });
  setLease(dir, writer.id, 60_000);
  await gh.read('gpt-a', claim, 'contents/README.md');
  near(leftSeconds(await leaseOf(m, writer.id)), 3600);
  await withOwner('0', async () => {
    setLease(dir, writer.id, -60_000);
    await assert.rejects(gh.read('gpt-a', claim, 'contents/README.md'), /Lease expired/);
  });
  // Owner mode: the same attempt, fence intact, simply carries on.
  await withOwner('1', async () => {
    await gh.read('gpt-a', claim, 'contents/README.md');
    near(leftSeconds(await leaseOf(m, writer.id)), 3600);
  });
}));
