import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MeshEngine } from '../src/core/mesh.js';

async function harness(run: (mesh: MeshEngine, dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'panter-listen-'));
  try { await run(await MeshEngine.open(dir), dir); } finally { await rm(dir, { recursive: true, force: true }); }
}
const grok = { host: 'grok' as const, actorId: 'actor-grok-live', modelRequest: 'host-default', effortRequest: 'high', roles: ['reviewer' as const] };

test('shared notification never contains actor ids, receipts or instructions', () => harness(async mesh => {
  const changed: string[] = [];
  mesh.events.on('changed', () => { changed.push(JSON.stringify(mesh.changeResource())); });
  await mesh.setProfile('gpt-a', grok, 0);
  const work = await mesh.delegate('gpt-a', { missionId: 'm-test', target: 'grok', role: 'reviewer', instruction: 'private instruction 42', idempotencyKey: 'rev' });
  const claimed = await mesh.claim('grok', work.id);
  await mesh.complete('grok', work.id, claimed.attemptId!, claimed.leaseGeneration, 'private result 43');
  assert.ok(changed.length >= 3);
  for (const change of changed) { assert.match(change, /panter:\/\/mesh\/changed/); assert.doesNotMatch(change, /grok|private|receipt|m-test/); }
  const inbox = await mesh.inbox('gpt-a');
  assert.equal(inbox.messages[0]?.text, 'private result 43');
}));

test('actor-specific revision cursors do not skip another host messages', () => harness(async mesh => {
  await mesh.setProfile('gpt-a', grok, 0);
  const work = await mesh.delegate('gpt-a', { missionId: 'm2', target: 'grok', role: 'reviewer', instruction: 'Audit', idempotencyKey: 'b' });
  const before = (await mesh.inbox('gpt-a')).revision;
  await mesh.message('grok', { missionId: 'm2', to: 'gpt-a', workId: work.id, text: 'Question?', kind: 'QUESTION' });
  const unread = await mesh.inbox('gpt-a', before);
  assert.equal(unread.messages.length, 1);
  assert.equal(unread.messages[0]?.text, 'Question?');
  assert.equal((await mesh.inbox('gpt-a', unread.revision)).messages.length, 0);
}));

test('only GPT-A can assign coordinator profile and worker cannot gain that role', () => harness(async mesh => {
  await assert.rejects(mesh.setProfile('gpt-a', { ...grok, roles: ['orchestrator'] }, 0), /Only GPT-A/);
  await assert.rejects(mesh.setProfile('gpt-a', { ...grok, host: 'gpt-a', roles: ['reviewer'] }, 0), /coordinator/);
  const leader = await mesh.setProfile('gpt-a', { host: 'gpt-a', actorId: 'actor-gpt-a', modelRequest: 'gpt-6', effortRequest: 'max', roles: ['orchestrator'] }, 0);
  assert.equal(leader.revision, 1);
}));

test('v0.3 messages without revision migrate in memory, preserving durable history', () => harness(async (mesh, dir) => {
  await mesh.setProfile('gpt-a', grok, 0);
  const work = await mesh.delegate('gpt-a', { missionId: 'legacy', target: 'grok', role: 'reviewer', instruction: 'Audit', idempotencyKey: 'l' });
  const dataPath = join(dir, 'mesh.json');
  const data = JSON.parse(await readFile(dataPath, 'utf8'));
  data.messages.push({ id: 'legacy1', missionId: 'legacy', from: 'grok', to: 'gpt-a', workId: work.id, kind: 'QUESTION', text: 'old', createdAt: new Date().toISOString() });
  await writeFile(dataPath, JSON.stringify(data));
  const reopened = await MeshEngine.open(dir);
  assert.equal((await reopened.inbox('gpt-a', 0)).messages[0]?.text, 'old');
}));
