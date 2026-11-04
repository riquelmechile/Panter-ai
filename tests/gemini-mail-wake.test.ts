import assert from 'node:assert/strict';
import { test, before } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MeshEngine } from '../src/core/mesh.js';
import { SqliteLedger } from '../src/core/sqlite-ledger.js';
import { GeminiMailWake, GEMINI_MAIL_RESULT_MARKER, mimeTexts, markedJson } from '../src/core/gemini-mail-wake.js';

before(() => { process.env.PANTER_LEAD_HOST = 'claude'; });
const env = { PANTER_GEMINI_MAIL_RELAY_URL: 'https://relay.example.com/wake', PANTER_GEMINI_MAIL_RECIPIENT: 'worker@gmail.com' };

async function fixture(fn: (ctx: { dir: string; mesh: MeshEngine; sent: any[]; status: { code: number }; listening: { on: boolean }; wake: GeminiMailWake }) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'panter-gmail-'));
  try {
    const mesh = await MeshEngine.open(dir);
    await mesh.setProfile('claude', { host: 'gemini', actorId: 'actor-gemini', modelRequest: 'gemini-4-argon', effortRequest: 'high', roles: ['explorer', 'implementer'] }, 0);
    const sent: any[] = []; const status = { code: 202 }; const listening = { on: false };
    const wake = new GeminiMailWake(dir, mesh, () => listening.on, env, async (url, body) => { sent.push({ url, payload: JSON.parse(body) }); return status.code; }, 0);
    await fn({ dir, mesh, sent, status, listening, wake });
  } finally { await rm(dir, { recursive: true, force: true }); }
}
const delegate = (mesh: MeshEngine, key: string, role: 'explorer' | 'implementer' = 'explorer') =>
  mesh.delegate('claude', { missionId: 'm', target: 'gemini', role, instruction: 'Read file X and report', idempotencyKey: key });
const qp = (s: string) => s.replace(/=/g, '=3D').replace(/"/g, '=22');
const mime = (body: string) => Buffer.from([
  'From: worker@gmail.com', 'To: relay@plasticov.cl', 'Subject: Re: [PANTER_GEMINI]', 'MIME-Version: 1.0',
  'Content-Type: multipart/alternative; boundary="b1"', '', '--b1', 'Content-Type: text/plain; charset="UTF-8"',
  'Content-Transfer-Encoding: quoted-printable', '', qp(body), '--b1--', ''].join('\r\n'), 'latin1').toString('base64');

test('mails a queued read-only Gemini task once, and the relay may send only that exact envelope', () => fixture(async ({ mesh, sent, wake }) => {
  const work = await delegate(mesh, 'k1');
  assert.deepEqual((await wake.dispatchDue()).sent, [work.id]);
  assert.equal(sent.length, 1);
  const { envelope, recipient } = sent[0].payload;
  assert.equal(recipient, 'worker@gmail.com');
  assert.equal(envelope.work_id, work.id);
  assert.equal(envelope.instruction, 'Read file X and report');
  assert.equal(envelope.result_template.success, '<true|false>');
  assert.equal((await mesh.inbox('claude')).works.find(w => w.id === work.id)?.state, 'RUNNING');
  assert.equal(wake.validateEnvelope(envelope).ok, true);
  assert.throws(() => wake.validateEnvelope({ ...envelope, instruction: 'Delete everything' }), /not an outstanding/);
  assert.throws(() => wake.validateEnvelope({ ...envelope, result_template: { token: 'forged' } }), /not an outstanding/);
  // Already mailed: a second pass sends nothing.
  assert.deepEqual((await wake.dispatchDue()).sent, []);
}));

test('a reply with the current token completes the work once; the quoted template alone is never accepted', () => fixture(async ({ mesh, sent, wake }) => {
  const work = await delegate(mesh, 'k2');
  await wake.dispatchDue();
  const { token } = sent[0].payload.envelope.result_template;
  const quotedTemplate = `> ${GEMINI_MAIL_RESULT_MARKER}\n> ${JSON.stringify(sent[0].payload.envelope.result_template)}`;
  await assert.rejects(wake.acceptResult({ raw_mime_base64: mime(`Done.\n\n${quotedTemplate}`) }), /No valid/);
  const answer = JSON.stringify({ work_id: work.id, token, success: true, result: 'The file exports A, B and C.' });
  const ok = await wake.acceptResult({ raw_mime_base64: mime(`${GEMINI_MAIL_RESULT_MARKER}\n${answer}\n\n${quotedTemplate}`) });
  assert.equal(ok.state, 'COMPLETED');
  const result = await mesh.resultGet('claude', work.id);
  assert.match(JSON.stringify(result), /via Gmail relay\] The file exports A, B and C\./);
  await assert.rejects(wake.acceptResult({ raw_mime_base64: mime(`${GEMINI_MAIL_RESULT_MARKER}\n${answer}`) }), /already accepted/);
  await assert.rejects(wake.acceptResult({ raw_mime_base64: mime(`${GEMINI_MAIL_RESULT_MARKER}\n${answer.replace(token, 'x'.repeat(43))}`) }), /No valid/);
}));

test('a relay failure returns the work to the queue and backs off; writers and live chats are never mailed', () => fixture(async ({ mesh, sent, status, listening, wake }) => {
  const writer = await delegate(mesh, 'k3', 'implementer');
  listening.on = true;
  const reader = await delegate(mesh, 'k4');
  assert.deepEqual((await wake.dispatchDue()).sent, [], 'an open Gemini chat takes the work itself');
  listening.on = false;
  status.code = 500;
  assert.deepEqual((await wake.dispatchDue()).failed, [reader.id]);
  const works = (await mesh.inbox('claude')).works;
  assert.equal(works.find(w => w.id === reader.id)?.state, 'QUEUED');
  assert.equal(works.find(w => w.id === writer.id)?.state, 'QUEUED');
  status.code = 202;
  assert.deepEqual((await wake.dispatchDue()).sent, [], 'backoff holds the retry');
  assert.ok(sent.every(s => s.payload.envelope.work_id !== writer.id));
}));

test('MIME reader decodes base64 and HTML parts; marker scan skips unparsable copies', () => {
  const raw = ['Content-Type: multipart/alternative; boundary=x', '', '--x', 'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64', '', Buffer.from('<p>' + GEMINI_MAIL_RESULT_MARKER + '</p><p>{&quot;a&quot;:1}</p>').toString('base64'), '--x--'].join('\r\n');
  const texts = mimeTexts(raw);
  assert.equal(texts.length, 1);
  assert.deepEqual(markedJson(texts[0]!), [{ a: 1 }]);
  assert.deepEqual(markedJson(`${GEMINI_MAIL_RESULT_MARKER} {broken\n${GEMINI_MAIL_RESULT_MARKER} {"b":2}`), [{ b: 2 }]);
});

test('disabled without a relay URL; rejects a non-public relay', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'panter-gmail-off-'));
  try {
    const mesh = await MeshEngine.open(dir);
    assert.equal(new GeminiMailWake(dir, mesh, () => false, {}).configured, false);
    assert.throws(() => new GeminiMailWake(dir, mesh, () => false, { ...env, PANTER_GEMINI_MAIL_RELAY_URL: 'https://localhost/wake' }), /public HTTPS/);
    assert.throws(() => new GeminiMailWake(dir, mesh, () => false, { ...env, PANTER_GEMINI_MAIL_RECIPIENT: 'nope' }), /Gmail address/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

function expire(dir: string, workId: string) {
  const db = SqliteLedger.open(dir);
  const past = new Date(Date.now() - 1000).toISOString();
  db.mutate('mesh', {} as any, (d: any) => { const w = d.works.find((x: any) => x.id === workId); w.leaseUntil = past; });
  db.mutate('gemini_mail', {} as any, (d: any) => { for (const t of d.tickets) if (t.workId === workId) t.expiresAt = past; });
  db.close();
}

test('a retry never adopts a live claim taken by an open Gemini chat after the mailed lease expired', () => fixture(async ({ dir, mesh, sent, status, wake }) => {
  const work = await delegate(mesh, 'k5');
  await wake.dispatchDue();
  expire(dir, work.id);
  const chat = await mesh.claim('gemini', work.id, 300);
  status.code = 500;
  const r = await wake.dispatchDue();
  assert.deepEqual(r.sent, []);
  const now = (await mesh.inbox('claude')).works.find(w => w.id === work.id);
  assert.equal(now?.state, 'RUNNING', 'the chat keeps its claim; nothing released it');
  const again = await mesh.claim('gemini', work.id, 300);
  assert.equal(again.attemptId, chat.attemptId);
  assert.equal(sent.length, 1);
}));

test('expired-ticket retries respect the relay backoff', () => fixture(async ({ dir, mesh, sent, status, wake }) => {
  const work = await delegate(mesh, 'k6');
  await wake.dispatchDue();
  expire(dir, work.id);
  status.code = 500;
  assert.deepEqual((await wake.dispatchDue()).failed, [work.id]);
  const calls = sent.length;
  assert.deepEqual(await wake.dispatchDue(), { sent: [], failed: [] });
  assert.equal(sent.length, calls, 'no new relay call while backing off');
}));
