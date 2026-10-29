import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PanterStore } from '../src/core/store.js';

async function fixture<T>(fn: (store: PanterStore, dir: string) => Promise<T>) {
  const dir = await mkdtemp(join(tmpdir(), 'panter-test-'));
  try { return await fn(await PanterStore.open(dir), dir); }
  finally { await rm(dir, { recursive: true, force: true }); }
}

test('mission lifecycle persists through reopening and rejects stale writes', () => fixture(async (store, dir) => {
  const m = await store.createMission('demo', 'make something reliable');
  assert.equal(m.status, 'DRAFT');
  await assert.rejects(store.transitionMission(m.id, 'DONE', 1), /Invalid mission transition/);
  const ready = await store.transitionMission(m.id, 'READY', 1);
  assert.equal(ready.revision, 2);
  await assert.rejects(store.transitionMission(m.id, 'RUNNING', 1), /Stale mission revision/);
  assert.equal((await PanterStore.open(dir)).getMission(m.id) instanceof Promise, true);
  assert.equal((await (await PanterStore.open(dir)).getMission(m.id))?.status, 'READY');
}));

test('deduplicates work and fences stale claims', () => fixture(async store => {
  const m = await store.createMission('demo', 'job');
  const a = await store.enqueueWork(m.id, 'worker-a', 'task', 'stable-key');
  const b = await store.enqueueWork(m.id, 'worker-a', 'task', 'stable-key');
  assert.equal(a.id, b.id);
  await assert.rejects(store.enqueueWork(m.id, 'worker-a', 'DIFFERENT', 'stable-key'), /Idempotency conflict/);
  const claimed = await store.claimWork('worker-a');
  assert.equal(claimed?.leaseGeneration, 1);
  assert.equal(await store.claimWork('worker-a'), null);
  await assert.rejects(store.completeWork(a.id, 'worker-a', 2, 'done'), /Stale lease/);
  assert.equal((await store.completeWork(a.id, 'worker-a', 1, 'done')).state, 'COMPLETED');
}));

test('serializes concurrent mission writes', () => fixture(async store => {
  await Promise.all(Array.from({ length: 12 }, (_, i) => store.createMission('demo', `mission ${i}`)));
  assert.equal((await store.listMissions()).length, 12);
}));
