import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MeshEngine, GROK_RING_STALE_MS } from '../src/core/mesh.js';
import { SqliteLedger } from '../src/core/sqlite-ledger.js';
import { ringNextGrokWork } from '../src/core/harness-wake.js';

const grok = { host: 'grok' as const, actorId: 'actor-grok', modelRequest: 'm', effortRequest: 'max', roles: ['reviewer' as const, 'implementer' as const] };

async function fixture(fn: (m: MeshEngine, dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'panter-lease-'));
  try { const m = await MeshEngine.open(dir); await m.setProfile('gpt-a', grok, 0); await fn(m, dir); }
  finally { await rm(dir, { recursive: true, force: true }); }
}
/** Move one work's lease end into the past by agoMs, as if its worker ran long. */
function expire(dir: string, workId: string, agoMs: number) {
  const db = SqliteLedger.open(dir);
  db.mutate('mesh', {} as any, (d: any) => { d.works.find((w: any) => w.id === workId).leaseUntil = new Date(Date.now() - agoMs).toISOString(); });
  db.close();
}
const review = (key: string) => ({ missionId: 'm', target: 'grok' as const, role: 'reviewer' as const, instruction: 'review the PR', idempotencyKey: key });

test('a review that outlives its lease still records its result when nobody took the work over', () => fixture(async (m, dir) => {
  const w = await m.delegate('gpt-a', review('late'));
  const c = await m.claim('grok', w.id, 300) as any;
  expire(dir, w.id, 60_000);
  // Renewing late works too, so a slow worker can extend before publishing.
  await m.heartbeat('grok', w.id, c.attemptId, c.leaseGeneration, 600);
  expire(dir, w.id, 60_000);
  const r = await m.complete('grok', w.id, c.attemptId, c.leaseGeneration, '{"verdict":"APPROVE"}');
  assert.equal(r.state, 'COMPLETED');
  // Idempotent: the same receipt again is accepted, a different one is not.
  assert.equal((await m.complete('grok', w.id, c.attemptId, c.leaseGeneration, '{"verdict":"APPROVE"}')).state, 'COMPLETED');
  await assert.rejects(m.complete('grok', w.id, c.attemptId, c.leaseGeneration, '{"verdict":"REJECT"}'), /Conflicting terminal receipt/);
}));

test('a late result is refused once the work was requeued and claimed again (the fence moved)', () => fixture(async (m, dir) => {
  const w = await m.delegate('gpt-a', review('fenced'));
  const first = await m.claim('grok', w.id, 300) as any;
  expire(dir, w.id, 60_000);
  assert.deepEqual(await m.requeueExpiredReadOnly('grok'), [w.id]);
  const second = await m.claim('grok', w.id, 300) as any;
  assert.notEqual(second.attemptId, first.attemptId);
  await assert.rejects(m.complete('grok', w.id, first.attemptId, first.leaseGeneration, '{}'), /Stale work lease/);
  await assert.rejects(m.heartbeat('grok', w.id, first.attemptId, first.leaseGeneration), /Stale work lease/);
  assert.equal((await m.complete('grok', w.id, second.attemptId, second.leaseGeneration, '{}')).state, 'COMPLETED');
}));

test('an expired writer stays strict: no late renewal or completion', () => fixture(async (m, dir) => {
  const w = await m.delegate('gpt-a', { ...review('writer'), role: 'implementer' });
  const c = await m.claim('grok', w.id, 300) as any;
  expire(dir, w.id, 60_000);
  await assert.rejects(m.heartbeat('grok', w.id, c.attemptId, c.leaseGeneration), /Lease expired/);
  await assert.rejects(m.complete('grok', w.id, c.attemptId, c.leaseGeneration, '{}'), /Lease expired/);
}));

test('an expired read-only claim stops holding Grok busy after the stale window; a writer never does', () => fixture(async (m, dir) => {
  const rung: string[] = [];
  const bell = { configured: true, dispatch: async (id: string) => { rung.push(id); return { accepted: true, statusCode: 200 }; } };
  const a = await m.delegate('gpt-a', review('a'));
  assert.equal((await ringNextGrokWork(m, bell)).workId, a.id);
  await m.claim('grok', a.id, 300);
  const b = await m.delegate('gpt-a', review('b'));
  assert.equal((await ringNextGrokWork(m, bell)).reason, 'PEER_BUSY', 'a is running');
  expire(dir, a.id, 60_000);
  assert.equal((await ringNextGrokWork(m, bell)).reason, 'PEER_BUSY', 'recently expired: its routine may still be finishing');
  expire(dir, a.id, GROK_RING_STALE_MS + 1000);
  assert.deepEqual(await ringNextGrokWork(m, bell), { rung: true, reason: 'RUNG', accepted: true, workId: b.id });
  assert.deepEqual(rung, [a.id, b.id]);

  // The same age on an expired writer still blocks: its outcome is unknown.
  const dir2 = await mkdtemp(join(tmpdir(), 'panter-lease-w-'));
  try {
    const m2 = await MeshEngine.open(dir2); await m2.setProfile('gpt-a', grok, 0);
    const w = await m2.delegate('gpt-a', { ...review('w'), role: 'implementer' });
    await m2.claim('grok', w.id, 300);
    expire(dir2, w.id, GROK_RING_STALE_MS + 1000);
    await m2.delegate('gpt-a', review('after-writer'));
    assert.equal((await ringNextGrokWork(m2, bell)).reason, 'PEER_BUSY');
  } finally { await rm(dir2, { recursive: true, force: true }); }
}));

test('workforce status shows read-only work whose lease ran out instead of hiding it', () => fixture(async (m, dir) => {
  const w = await m.delegate('gpt-a', review('visible'));
  await m.claim('grok', w.id, 300);
  expire(dir, w.id, 60_000);
  const view = (await m.workforceStatus('gpt-a')).find(h => h.host === 'grok') as any;
  assert.ok(view, 'grok row present');
  assert.equal(view.running, 0);
  assert.equal(view.leaseExpired, 1);
  assert.equal(view.outcomesUnknown, 0);
}));
