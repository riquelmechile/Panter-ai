import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MeshEngine } from '../src/core/mesh.js';
import { WorkforceLongPoll } from '../src/core/workforce-long-poll.js';

async function fixture(fn: (mesh: MeshEngine, service: WorkforceLongPoll) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'panter-wait-'));
  try {
    const mesh = await MeshEngine.open(dir);
    await fn(mesh, new WorkforceLongPoll(mesh));
  } finally { await rm(dir, { recursive: true, force: true }); }
}
const grok = {host: 'grok' as const, actorId: 'actor-grok-verified-session', modelRequest: 'host-native',
  effortRequest: 'max', roles: ['reviewer' as const]};

test('long-poll wakes on actual durable delegate, returns only an opaque own pointer', () => fixture(async (m, live) => {
  await m.setProfile('gpt-a', grok, 0);
  const pending = live.wait('grok', '2025-11-25', 2000);
  // Listener is installed synchronously, before the first durable queue read.
  assert.equal(m.events.listenerCount('grok'), 1);
  const work = await m.delegate('gpt-a', {missionId: 'wake-1', target: 'grok',
    role: 'reviewer', instruction: 'private repo details', idempotencyKey: 'wake-1'});
  const received = await pending;
  assert.equal(received.status, 'CANDIDATE');
  assert.equal(received.next?.workId, work.id);
  assert.equal(received.waitOutcome, 'CANDIDATE');
  assert.equal(received.autonomousWakeVerified, false);
  assert.equal(received.routeEvidence, 'REPORTED_UNVERIFIED');
  assert.ok(!JSON.stringify(received).includes('private repo details'));
  assert.equal(m.events.listenerCount('grok'), 0);
  assert.equal((await m.pending('grok')).length, 1); // Never claims a work item.
}));

test('one worker cannot wake another worker or see its opaque pointer', () => fixture(async (m, live) => {
  await m.setProfile('gpt-a', { ...grok, host: 'claude', actorId: 'actor-claude' }, 0);
  const waiting = live.wait('claude', '2026-07-28', 60);
  assert.equal(m.events.listenerCount('claude'), 1);
  await m.setProfile('gpt-a', grok, 0); // Does not have Claude work.
  const forGrok = await m.delegate('gpt-a', {missionId: 'wake-2', target: 'grok',
    role: 'reviewer', instruction: 'grok secret', idempotencyKey: 'wake-2'});
  const outcome = await waiting;
  assert.equal(outcome.waitOutcome, 'TIMED_OUT');
  assert.equal(outcome.next, null);
  assert.ok(!JSON.stringify(outcome).includes(forGrok.id));
  assert.equal(m.events.listenerCount('claude'), 0);
}));

test('duplicate live waits for one worker are rejected without a second listener', () => fixture(async (m, live) => {
  const wait = live.wait('gemini', '2025-11-25', 50);
  assert.equal(m.events.listenerCount('gemini'), 1);
  await assert.rejects(live.wait('gemini', '2025-11-25', 50), /already active/);
  assert.equal(m.events.listenerCount('gemini'), 1);
  assert.equal((await wait).waitOutcome, 'TIMED_OUT');
  assert.equal(m.events.listenerCount('gemini'), 0);
}));

test('immediate wait sees queued work and does not allocate a live listener', () => fixture(async (m, live) => {
  await m.setProfile('gpt-a', grok, 0);
  const work = await m.delegate('gpt-a', {missionId: 'wake-immediate',target:'grok',
    role:'reviewer',instruction:'check SHA',idempotencyKey:'one'});
  const got = await live.wait('grok', 'UNKNOWN', 0);
  assert.equal(got.next?.workId, work.id);
  assert.equal(got.waitOutcome, 'CANDIDATE');
  assert.equal(m.events.listenerCount('grok'), 0);
  assert.equal((await m.pending('grok')).length, 1);
}));

test('unprivileged coordinator and invalid waits cannot allocate listeners or claim', () => fixture(async (m, live) => {
  await assert.rejects(live.wait('gpt-a', 'UNKNOWN', 20), /Only authenticated workers/);
  for (const ms of [-1, 3600001, 1.2, NaN])
    await assert.rejects(live.wait('grok','UNKNOWN',ms), /0..3600000/);
  await assert.rejects(live.wait('grok','unsupported' as 'UNKNOWN',0), /protocol era/);
  assert.equal(m.events.listenerCount('grok'), 0);
  assert.equal(m.events.listenerCount('gpt-a'), 0);
}));

test('profile-only change does not claim work or return a false candidate', () => fixture(async (m, live) => {
  const wait = live.wait('gpt-b', '2026-07-28', 60);
  await m.setProfile('gpt-a', {host:'gpt-b',actorId:'actor-gpt-b',modelRequest:'host-default',
    effortRequest:'high',roles:['verifier']}, 0);
  const got = await wait;
  assert.equal(got.waitOutcome, 'TIMED_OUT');
  assert.equal(got.status, 'EMPTY');
  assert.equal(got.autonomousWakeVerified, false);
  assert.equal(m.events.listenerCount('gpt-b'), 0);
}));


test('a stopped host aborts its listener immediately, cleans the slot and can re-arm', () => fixture(async (_mesh, live) => {
  const controller = new AbortController();
  const pending = live.wait('grok','2026-07-28',3600000,controller.signal);
  controller.abort();
  await assert.rejects(pending,/cancelled/);
  assert.equal(_mesh.events.listenerCount('grok'),0);
  const next=await live.wait('grok','2026-07-28',0);
  assert.equal(next.status,'EMPTY');
}));
