import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MeshEngine } from '../src/core/mesh.js';
import { summarizeWorkforce, validateRouteReport } from '../src/core/workforce-readiness.js';

async function withMesh(fn: (m: MeshEngine, dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'panter-workforce-'));
  try { await fn(await MeshEngine.open(dir), dir); }
  finally { await rm(dir, {recursive: true, force: true}); }
}
const bridge = { protocolEra: '2025-11-25' as const, deliveryMode: 'TASK_BRIDGE_2025' as const };
const profile = { host: 'grok' as const, actorId: 'actor-grok-observed',
  modelRequest: 'host-native', effortRequest: 'max', roles: ['reviewer' as const] };

test('workforce reports exactly four workers, never the coordinator or Kimi', () => withMesh(async m => {
  const status = await m.workforceStatus('gpt-a');
  assert.deepEqual(status.map(p => p.host), ['gpt-b', 'claude', 'grok', 'gemini']);
  assert.ok(status.every(p => !p.configured && p.presence === 'UNKNOWN' &&
    p.effectiveDeliveryMode === 'DELIVERY_ONLY' && !p.autonomousWakeVerified));
  await assert.rejects(m.workforceStatus('grok'), /Only GPT-A/);
}));

test('a real authenticated poll sees only actor queue pointers, never claiming work', () => withMesh(async (m, dir) => {
  await m.setProfile('gpt-a', profile, 0);
  await m.setProfile('gpt-a', { ...profile, host: 'claude', actorId: 'actor-claude-observed' }, 0);
  const grok = await m.delegate('gpt-a', {
    missionId: 'workforce-m', target: 'grok', role: 'reviewer',
    instruction: 'secret task for grok', idempotencyKey: 'grok-one',
  });
  const claude = await m.delegate('gpt-a', {
    missionId: 'workforce-m', target: 'claude', role: 'reviewer',
    instruction: 'secret task for claude', idempotencyKey: 'claude-one',
  });
  const first = await m.workforcePoll('grok', bridge);
  assert.equal(first.status, 'READY');
  assert.equal(first.next?.workId, grok.id);
  assert.ok(!JSON.stringify(first).includes('secret'));
  assert.ok(!JSON.stringify(first).includes(claude.id));
  assert.equal((await m.workforcePoll('grok', bridge)).next?.workId, grok.id);
  assert.equal((await m.pending('grok')).length, 1);
  const status = (await m.workforceStatus('gpt-a')).find(x => x.host === 'grok')!;
  assert.equal(status.presence, 'FRESH');
  assert.equal(status.pending, 1);
  assert.equal(status.reportedRoute?.deliveryMode, 'TASK_BRIDGE_2025');
  assert.equal(status.routeEvidence, 'REPORTED_UNVERIFIED');
  assert.equal(status.effectiveDeliveryMode, 'DELIVERY_ONLY');
  assert.equal(status.autonomousWakeVerified, false);
  assert.equal((await m.workforcePoll('claude', bridge)).next?.workId, claude.id);
  const claimed = await m.claim('grok', grok.id);
  assert.equal((await m.workforcePoll('grok', bridge)).status, 'EMPTY');
  await m.complete('grok', grok.id, claimed.attemptId!, claimed.leaseGeneration, 'review receipt');
  const persisted = await MeshEngine.open(dir);
  const ready = (await persisted.workforceStatus('gpt-a')).find(x => x.host === 'grok')!;
  assert.equal(ready.claimObserved, true);
  assert.equal(ready.receiptObserved, true);
  assert.equal(ready.autonomousWakeVerified, false);
  assert.equal(ready.pending, 0);
}));

test('invalid claims about modern/legacy transports fail before committing presence', () => withMesh(async m => {
  await assert.rejects(m.workforcePoll('gpt-a', bridge), /Only workers/);
  await assert.rejects(m.workforcePoll('grok', { protocolEra: '2025-11-25', deliveryMode: 'TASKS_2026' }), /modern protocol/);
  await assert.rejects(m.workforcePoll('grok', { protocolEra: 'UNKNOWN', deliveryMode: 'SCHEDULED_POLL' }), /interval required/);
  await assert.rejects(m.workforcePoll('grok', { protocolEra: '2026-07-28', deliveryMode: 'SCHEDULED_POLL', pollIntervalSeconds: 1 }), /Invalid poll interval/);
  assert.equal((await m.workforceStatus('gpt-a')).find(x => x.host === 'grok')!.presence, 'UNKNOWN');
  assert.throws(() => validateRouteReport({protocolEra:'2026-07-28', deliveryMode:'TASKS_2025'}), /legacy protocol/);
}));

test('stale presence and expired writer remain fail-closed; no false wake', () => withMesh(async m => {
  await m.setProfile('gpt-a', { ...profile, roles: ['implementer'] }, 0);
  const w = await m.delegate('gpt-a', {missionId:'m',target:'grok',role:'implementer',
    instruction:'Build',idempotencyKey:'a'});
  const c = await m.claim('grok', w.id, 30);
  const now = Date.now() + 121000;
  const observed = { grok: {lastPollAt: new Date(now - 121000).toISOString(),
    reportedRoute: {protocolEra: '2026-07-28' as const, deliveryMode: 'EXTERNAL_WAKE' as const}} };
  const original = await m.workforceStatus('gpt-a');
  const view = summarizeWorkforce([], observed, [{
    ...w, state: 'RUNNING', leaseUntil: new Date(Date.now() - 30000).toISOString(),
  }], now).find(x=>x.host==='grok')!;
  assert.equal(view.presence, 'STALE');
  assert.equal(view.outcomesUnknown, 1);
  assert.equal(view.running, 0);
  assert.equal(view.autonomousWakeVerified, false);
  assert.equal(original.find(x=>x.host==='grok')?.claimObserved, true);
  assert.ok(c.attemptId);
}));
