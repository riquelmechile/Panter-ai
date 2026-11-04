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
