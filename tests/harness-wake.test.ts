import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MeshEngine } from '../src/core/mesh.js';
import { ringGrokForWork } from '../src/core/harness-wake.js';

test('harness work rings Grok one work at a time, never twice for the same work', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'panter-wake-'));
  try {
    const m = await MeshEngine.open(dir);
    await m.setProfile('gpt-a', { host: 'grok', actorId: 'actor-grok', modelRequest: 'm', effortRequest: 'max', roles: ['reviewer'] }, 0);
    const rung: string[] = [];
    const bell = { configured: true, dispatch: async (id: string) => { rung.push(id); return { accepted: true, statusCode: 200 }; } };
    const a = await m.delegate('gpt-a', { missionId: 'm', target: 'grok', role: 'reviewer', instruction: 'lens a', idempotencyKey: 'a' });
    const b = await m.delegate('gpt-a', { missionId: 'm', target: 'grok', role: 'reviewer', instruction: 'lens b', idempotencyKey: 'b' });
    assert.equal((await ringGrokForWork(m, { configured: false, dispatch: bell.dispatch }, a.id)).reason, 'NOT_CONFIGURED');
    assert.equal((await ringGrokForWork(m, bell, a.id)).reason, 'RUNG');
    assert.equal((await ringGrokForWork(m, bell, a.id)).reason, 'ALREADY_RUNG');
    assert.equal((await ringGrokForWork(m, bell, b.id)).reason, 'PEER_BUSY', 'a is rung and not yet picked up');
    const claimed = await m.claim('grok', a.id, 300) as any;
    assert.equal((await ringGrokForWork(m, bell, b.id)).reason, 'PEER_BUSY', 'a is running');
    await m.complete('grok', a.id, claimed.attemptId, claimed.leaseGeneration, '{}');
    assert.equal((await ringGrokForWork(m, bell, b.id)).reason, 'RUNG', 'rung once Grok is free');
    assert.deepEqual(rung, [a.id, b.id]);
    assert.equal((await m.grokWakeStatus('gpt-a', b.id)).state, 'SIGNAL_ACCEPTED');
    assert.equal((await ringGrokForWork(m, bell, a.id)).reason, 'NOT_QUEUED');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('concurrent rings never ring two Grok works; the pickup clock starts at the ring', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'panter-wake-'));
  try {
    const m = await MeshEngine.open(dir);
    await m.setProfile('gpt-a', { host: 'grok', actorId: 'actor-grok', modelRequest: 'm', effortRequest: 'max', roles: ['reviewer'] }, 0);
    const rung: string[] = [];
    const bell = { configured: true, dispatch: async (id: string) => { rung.push(id); return { accepted: true, statusCode: 200 }; } };
    const a = await m.delegate('gpt-a', { missionId: 'm', target: 'grok', role: 'reviewer', instruction: 'lens a', idempotencyKey: 'a' });
    const b = await m.delegate('gpt-a', { missionId: 'm', target: 'grok', role: 'reviewer', instruction: 'lens b', idempotencyKey: 'b' });
    const outcomes = await Promise.all([ringGrokForWork(m, bell, a.id), ringGrokForWork(m, bell, b.id)]);
    assert.equal(outcomes.filter(o => o.rung).length, 1);
    assert.equal(rung.length, 1);
    const { pickupClockStart } = await import('../src/core/harness-wake.js');
    const first = rung[0]!, second = first === a.id ? b : a;
    const w1 = await m.workTarget('gpt-a', first);
    assert.equal(await pickupClockStart(m, bell, { id: first, target: 'grok', createdAt: w1.createdAt }, 180_000), (await m.grokWakeStatus('gpt-a', first)).reservedAt);
    assert.equal(await pickupClockStart(m, bell, { id: second.id, target: 'grok', createdAt: second.createdAt }, 180_000), null, 'not rung yet: does not age');
    // A stuck blocker never stalls it forever: past the wait cap it ages from creation.
    const old = new Date(Date.now() - 5 * 60_000).toISOString();
    assert.equal(await pickupClockStart(m, bell, { id: second.id, target: 'grok', createdAt: old }, 60_000), old);
    assert.equal(await pickupClockStart(m, { configured: false, dispatch: bell.dispatch }, { id: second.id, target: 'grok', createdAt: second.createdAt }, 180_000), second.createdAt);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('any queued Grok work is rung in order (directed delegates too), one at a time', async () => {
  const { ringNextGrokWork } = await import('../src/core/harness-wake.js');
  const dir = await mkdtemp(join(tmpdir(), 'panter-wake-'));
  try {
    const m = await MeshEngine.open(dir);
    await m.setProfile('gpt-a', { host: 'grok', actorId: 'actor-grok', modelRequest: 'm', effortRequest: 'max', roles: ['reviewer'] }, 0);
    const rung: string[] = [];
    const bell = { configured: true, dispatch: async (id: string) => { rung.push(id); return { accepted: true, statusCode: 200 }; } };
    assert.equal((await ringNextGrokWork(m, bell)).reason, 'NOT_QUEUED');
    const a = await m.delegate('gpt-a', { missionId: 'm', target: 'grok', role: 'reviewer', instruction: 'a', idempotencyKey: 'a' });
    const b = await m.delegate('gpt-a', { missionId: 'm', target: 'grok', role: 'reviewer', instruction: 'b', idempotencyKey: 'b' });
    assert.deepEqual(await ringNextGrokWork(m, bell), { rung: true, reason: 'RUNG', accepted: true, workId: a.id });
    assert.equal((await ringNextGrokWork(m, bell)).reason, 'PEER_BUSY', 'a is rung and still queued');
    const claimed = await m.claim('grok', a.id, 300) as any;
    await m.complete('grok', a.id, claimed.attemptId, claimed.leaseGeneration, '{}');
    assert.deepEqual(await ringNextGrokWork(m, bell), { rung: true, reason: 'RUNG', accepted: true, workId: b.id });
    assert.deepEqual(rung, [a.id, b.id]);
    assert.equal((await ringNextGrokWork({ pending: async () => [] } as any, { configured: false, dispatch: bell.dispatch })).reason, 'NOT_CONFIGURED');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a failed or unanswered ring never blocks Grok: other work is rung, and the lost one is rung again (bounded)', async () => {
  const { ringNextGrokWork } = await import('../src/core/harness-wake.js');
  const { GROK_RING_STALE_MS, GROK_MAX_RINGS } = await import('../src/core/mesh.js');
  const dir = await mkdtemp(join(tmpdir(), 'panter-wake-'));
  const realNow = Date.now;
  try {
    const m = await MeshEngine.open(dir);
    await m.setProfile('gpt-a', { host: 'grok', actorId: 'actor-grok', modelRequest: 'm', effortRequest: 'max', roles: ['reviewer'] }, 0);
    const rung: string[] = [];
    let status = 503;
    const bell = { configured: true, dispatch: async (id: string) => { rung.push(id); return { accepted: status < 300, statusCode: status }; } };
    const a = await m.delegate('gpt-a', { missionId: 'm', target: 'grok', role: 'reviewer', instruction: 'a', idempotencyKey: 'a' });
    const b = await m.delegate('gpt-a', { missionId: 'm', target: 'grok', role: 'reviewer', instruction: 'b', idempotencyKey: 'b' });
    assert.equal((await ringNextGrokWork(m, bell)).workId, a.id);
    assert.equal((await m.grokWakeStatus('gpt-a', a.id)).state, 'SIGNAL_FAILED');
    // a's ring failed: Grok is not busy, b is rung (a is retried in order first, so ring once more to reach b).
    status = 200;
    const next = await ringNextGrokWork(m, bell);
    assert.equal(next.reason, 'RUNG');
    assert.equal(next.workId, a.id, 'the oldest work whose ring failed is rung again first');
    assert.equal((await ringNextGrokWork(m, bell)).reason, 'PEER_BUSY', 'a ring that was accepted keeps Grok busy while fresh');
    // Grok never picked a up: once stale, it no longer blocks, and it may be rung again up to the limit.
    Date.now = () => realNow() + GROK_RING_STALE_MS + 1000;
    const third = await ringNextGrokWork(m, bell);
    assert.equal(third.workId, a.id);
    Date.now = () => realNow() + 2 * (GROK_RING_STALE_MS + 1000);
    const fourth = await ringNextGrokWork(m, bell);
    assert.equal(fourth.workId, b.id, `a reached ${GROK_MAX_RINGS} rings and stops blocking; b is rung`);
    assert.deepEqual(rung, [a.id, a.id, a.id, b.id]);
    // The sweep leaves very young work to its creator.
    Date.now = realNow;
    await m.delegate('gpt-a', { missionId: 'm', target: 'grok', role: 'reviewer', instruction: 'c', idempotencyKey: 'c' });
  } finally { Date.now = realNow; await rm(dir, { recursive: true, force: true }); }
});
