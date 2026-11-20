import assert from 'node:assert/strict';
import { test, before } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MeshEngine, ASK_RULE } from '../src/core/mesh.js';
import { SqliteLedger } from '../src/core/sqlite-ledger.js';
import { WorkforceEvents, WORK_EVENT, reconcileWorkforceEventOutbox, type EventPost } from '../src/core/workforce-events.js';
import { UNCLAIMED_AFTER_SECONDS } from '../src/core/work-sweep.js';

before(() => { process.env.PANTER_LEAD_HOST = 'claude'; });
const profile = (host: 'gpt-a' | 'gpt-b') => ({ host, actorId: 'actor-' + host, modelRequest: 'model-' + host, effortRequest: 'max', roles: ['reviewer' as const, 'implementer' as const] });
async function fixture(fn: (m: MeshEngine, dir: string) => Promise<void>, owner: '0' | '1' = '1') {
  const dir = await mkdtemp(join(tmpdir(), 'panter-question-'));
  const prior = process.env.PANTER_OWNER_MODE;
  process.env.PANTER_OWNER_MODE = owner;
  try {
    const m = await MeshEngine.open(dir);
    await m.setProfile('claude', profile('gpt-a'), 0);
    await m.setProfile('claude', profile('gpt-b'), 0);
    await fn(m, dir);
  } finally {
    if (prior === undefined) delete process.env.PANTER_OWNER_MODE; else process.env.PANTER_OWNER_MODE = prior;
    await rm(dir, { recursive: true, force: true });
  }
}
function patch(dir: string, workId: string, fn: (w: any, d: any) => void) {
  const db = SqliteLedger.open(dir);
  db.mutate('mesh', {} as any, (d: any) => { fn(d.works.find((w: any) => w.id === workId), d); });
  db.close();
}
const stored = (dir: string, workId: string) => { const db = SqliteLedger.open(dir); const d: any = db.read('mesh', {} as any); db.close(); return d.works.find((w: any) => w.id === workId); };
const work = (key: string, role: 'reviewer' | 'implementer' = 'reviewer') => ({ missionId: 'm-' + key, target: 'gpt-a' as const, role, instruction: 'do the work', idempotencyKey: key });
/** A question from gpt-a about its work, with the fence of the claim it holds now (extra overrides; null = none). */
const ask = async (m: MeshEngine, w: { id: string; missionId: string }, extra: object | null = {}) => {
  const held = await m.workTarget('claude', w.id);
  const fence = extra !== null && held.attemptId ? { attemptId: held.attemptId, leaseGeneration: held.leaseGeneration } : {};
  return m.message('gpt-a', { missionId: w.missionId, to: 'claude', workId: w.id, kind: 'QUESTION', text: 'Which base branch?', ...fence, ...(extra ?? {}) }) as Promise<any>;
};
const answer = (m: MeshEngine, w: { id: string; missionId: string }) =>
  m.message('claude', { missionId: w.missionId, to: 'gpt-a', workId: w.id, kind: 'ANSWER', text: 'main' }) as Promise<any>;

test('a worker question parks its running work: no lease runs, the attempt is kept, the leader sees the question', () => fixture(async (m, dir) => {
  const w = await m.delegate('claude', work('park'));
  const c = await m.claim('gpt-a', w.id);
  const asked = await ask(m, w);
  assert.equal(asked.work.state, 'WAITING_INPUT');
  assert.match(asked.work.note, /end your turn/);
  const parked = stored(dir, w.id);
  assert.deepEqual({ state: parked.state, leaseUntil: parked.leaseUntil, attemptId: parked.attemptId, leaseGeneration: parked.leaseGeneration },
    { state: 'WAITING_INPUT', leaseUntil: null, attemptId: c.attemptId, leaseGeneration: 1 });
  assert.equal(parked.waitingSince, asked.createdAt);
  assert.equal((await m.inbox('claude')).messages.filter(x => x.workId === w.id && x.kind === 'QUESTION').length, 1);
  // It is nobody's load, it is not offered again, and nothing expires however long the leader takes.
  assert.equal((await m.loadByHost())['gpt-a'] ?? 0, 0);
  assert.deepEqual(await m.pending('gpt-a'), []);
  await assert.rejects(m.claim('gpt-a', w.id), /waits for .* answer/);
  patch(dir, w.id, x => { x.waitingSince = new Date(Date.now() - 30 * 86_400_000).toISOString(); });
  assert.deepEqual(await m.sweepExpired(0), { abandoned: [], uncertain: [] });
  assert.equal(stored(dir, w.id).state, 'WAITING_INPUT');
  // A second question, or an update, is only a message.
  assert.equal((await ask(m, w)).work, undefined);
  assert.equal(stored(dir, w.id).state, 'WAITING_INPUT');
}));

test('the attempt that asked can carry on or finish at any time, without an answer', () => fixture(async (m, dir) => {
  const beat = await m.delegate('claude', work('beat'));
  const c1 = await m.claim('gpt-a', beat.id);
  await ask(m, beat);
  const resumed = await m.heartbeat('gpt-a', beat.id, c1.attemptId!, c1.leaseGeneration);
  assert.equal(resumed.state, 'RUNNING');
  assert.ok(Date.parse(resumed.leaseUntil!) > Date.now());
  assert.equal(stored(dir, beat.id).waitingSince, undefined);
  // An answer that arrives once the work runs again is only a message: nothing is requeued under the worker.
  assert.equal((await answer(m, beat)).work, undefined);
  assert.equal(stored(dir, beat.id).state, 'RUNNING');
  await m.complete('gpt-a', beat.id, c1.attemptId!, c1.leaseGeneration, 'done');

  const used = await m.delegate('claude', work('used'));
  const c2 = await m.claim('gpt-a', used.id);
  await ask(m, used);
  assert.equal(await m.renewOnActivity('gpt-a', used.id, c2.attemptId!, c2.leaseGeneration), true);
  assert.equal(stored(dir, used.id).state, 'RUNNING');
  await assert.doesNotReject(m.liveWork('gpt-a', used.id, c2.attemptId!, c2.leaseGeneration));
  await ask(m, used);
  assert.equal(await m.renewOnActivity('gpt-a', used.id, 'not-the-attempt', c2.leaseGeneration), false);
  assert.equal(stored(dir, used.id).state, 'WAITING_INPUT');

  const done = await m.delegate('claude', work('done'));
  const c3 = await m.claim('gpt-a', done.id);
  await ask(m, done);
  await assert.rejects(m.complete('gpt-a', done.id, c3.attemptId!, c3.leaseGeneration + 1, 'x'), /Stale work lease/);
  assert.equal((await m.complete('gpt-a', done.id, c3.attemptId!, c3.leaseGeneration, 'assumed main')).state, 'COMPLETED');
  assert.equal(stored(dir, done.id).waitingSince, undefined);
}));

test('the answer puts the work back in the queue; the next claim is a new attempt and carries the questions and answers', () => fixture(async (m, dir) => {
  const w = await m.delegate('claude', work('answer', 'implementer'));
  const first = await m.claim('gpt-a', w.id);
  assert.equal((first as any).howToAsk, ASK_RULE);
  assert.equal((first as any).questionsAndAnswers, undefined);
  await ask(m, w);
  patch(dir, w.id, (x, d) => { x.unclaimedReportedAt = new Date().toISOString(); d.grokWakeAttempts = [{ workId: w.id, state: 'SIGNAL_ACCEPTED', reservedAt: new Date().toISOString(), statusCode: 200, rings: 3 }]; });
  const answered = await answer(m, w);
  assert.equal(answered.work.state, 'QUEUED');
  const back = stored(dir, w.id);
  assert.deepEqual({ state: back.state, leaseUntil: back.leaseUntil, ringCycle: back.ringCycle, queuedAt: back.queuedAt, waitingSince: back.waitingSince, unclaimedReportedAt: back.unclaimedReportedAt },
    { state: 'QUEUED', leaseUntil: null, ringCycle: 1, queuedAt: answered.createdAt, waitingSince: undefined, unclaimedReportedAt: undefined });
  const ledger = SqliteLedger.open(dir); assert.deepEqual((ledger.read('mesh', {} as any) as any).grokWakeAttempts, []); ledger.close();
  assert.deepEqual((await m.pending('gpt-a')).map(x => ({ workId: x.workId, cycle: x.cycle })), [{ workId: w.id, cycle: 1 }]);
  // The attempt that asked is fenced out the moment the work is offered again.
  await assert.rejects(m.heartbeat('gpt-a', w.id, first.attemptId!, first.leaseGeneration), /Stale work lease/);
  await assert.rejects(m.complete('gpt-a', w.id, first.attemptId!, first.leaseGeneration, 'late'), /Stale work lease/);
  assert.equal(await m.renewOnActivity('gpt-a', w.id, first.attemptId!, first.leaseGeneration), false);
  const second = await m.pickup('gpt-a');
  assert.equal(second.status, 'CLAIMED');
  const claimed = (second as any).work;
  assert.equal(claimed.leaseGeneration, 2);
  assert.notEqual(claimed.attemptId, first.attemptId);
  assert.equal(claimed.instruction, 'do the work', 'the stored instruction is never rewritten');
  assert.equal(claimed.howToAsk, ASK_RULE);
  assert.deepEqual(claimed.questionsAndAnswers.map((x: any) => [x.from, x.kind, x.text]), [['gpt-a', 'QUESTION', 'Which base branch?'], ['claude', 'ANSWER', 'main']]);
  assert.equal((await m.complete('gpt-a', w.id, claimed.attemptId, 2, 'done on main')).state, 'COMPLETED');
  // The leader's same delegate call still replays the same work.
  assert.equal((await m.delegate('claude', work('answer', 'implementer'))).id, w.id);
}));

test('a question parks only with the attempt and generation of the claim (strict mode writer)', () => fixture(async (m, dir) => {
  const w = await m.delegate('claude', work('strict', 'implementer'));
  const c = await m.claim('gpt-a', w.id, 60);
  assert.equal((await ask(m, w, null)).work, undefined, 'no fence: a message, as before');
  assert.equal(stored(dir, w.id).state, 'RUNNING');
  const before = (await m.inbox('claude')).messages.length;
  await assert.rejects(ask(m, w, { attemptId: c.attemptId!, leaseGeneration: 7 }), /Stale work lease/);
  await assert.rejects(ask(m, w, { attemptId: c.attemptId!, leaseGeneration: undefined }), /Stale work lease/);
  assert.equal((await m.inbox('claude')).messages.length, before, 'a stale question is not delivered');
  assert.equal((await ask(m, w, { attemptId: c.attemptId!, leaseGeneration: c.leaseGeneration })).work.state, 'WAITING_INPUT');
  // Its lease would be long gone; parked work has none, so the writer that asked still finishes.
  assert.equal(stored(dir, w.id).leaseUntil, null);
  assert.equal((await m.heartbeat('gpt-a', w.id, c.attemptId!, c.leaseGeneration)).state, 'RUNNING');
  // A writer whose lease already ran out is of unknown outcome, not parkable.
  patch(dir, w.id, x => { x.leaseUntil = new Date(Date.now() - 60_000).toISOString(); });
  assert.equal((await ask(m, w, { attemptId: c.attemptId!, leaseGeneration: c.leaseGeneration })).work, undefined);
  assert.equal(stored(dir, w.id).state, 'RUNNING');
}, '0'));

test('never parked: harness work, work held by a transport, other kinds of message, work that is not running', () => fixture(async (m, dir) => {
  const bound = await m.delegate('claude', work('bound'));
  await m.claim('gpt-a', bound.id);
  patch(dir, bound.id, x => { x.specialist = { agentId: 'x', skillIds: [], packetDigest: 'd', assetDigests: {}, modelRequest: 'm', effortRequest: 'max', bindingRevision: 1, allowedEditSurfaces: [] }; });
  assert.equal((await ask(m, bound)).work, undefined);
  assert.equal((await m.claim('gpt-a', bound.id) as any).howToAsk, undefined, 'harness work carries its own contract');
  const mailed = await m.delegate('claude', work('mailed'));
  const t = await m.claim('gpt-a', mailed.id, 600, true, true, true);
  assert.equal((t as any).howToAsk, undefined);
  assert.equal((await ask(m, mailed)).work, undefined);
  const update = await m.delegate('claude', work('update'));
  await m.claim('gpt-a', update.id);
  assert.equal(((await m.message('gpt-a', { missionId: update.missionId, to: 'claude', workId: update.id, kind: 'UPDATE', text: 'halfway' })) as any).work, undefined);
  assert.equal(((await m.message('claude', { missionId: update.missionId, to: 'gpt-a', workId: update.id, kind: 'QUESTION', text: 'status?' })) as any).work, undefined);
  assert.equal(stored(dir, update.id).state, 'RUNNING');
  const queued = await m.delegate('claude', work('queued'));
  assert.equal((await ask(m, queued)).work, undefined);
  assert.equal((await answer(m, queued)).work, undefined);
  assert.deepEqual({ state: stored(dir, queued.id).state, ringCycle: stored(dir, queued.id).ringCycle }, { state: 'QUEUED', ringCycle: undefined });
  for (const id of [bound.id, mailed.id, update.id]) assert.equal(stored(dir, id).state, 'RUNNING');
}));

test('the leader can end parked work instead of answering: read-only by withdrawing it, a writer only by reconciling it', () => fixture(async (m, dir) => {
  const reader = await m.delegate('claude', work('reader'));
  const rc = await m.claim('gpt-a', reader.id);
  await ask(m, reader);
  const gone = await m.withdrawUnstarted('claude', reader.id, 'no longer needed');
  assert.deepEqual({ state: gone.state, withdrawn: gone.withdrawn }, { state: 'ABORTED_NO_EFFECTS', withdrawn: true });
  assert.match(stored(dir, reader.id).result, /while it waited for an answer/);
  await assert.rejects(m.complete('gpt-a', reader.id, rc.attemptId!, rc.leaseGeneration, 'late'), /Stale work lease/);

  const writer = await m.delegate('claude', work('writer', 'implementer'));
  const wc = await m.claim('gpt-a', writer.id);
  await ask(m, writer);
  await assert.rejects(m.withdrawUnstarted('claude', writer.id, 'x'), /started writer is never withdrawn/);
  assert.deepEqual((await m.uncertainWriters()).map(x => [x.workId, x.state]), [[writer.id, 'WAITING_INPUT']]);
  // A parked writer still holds its edit scope: no second writer on the same mission.
  await assert.rejects(m.delegate('claude', { ...work('writer-2', 'implementer'), missionId: writer.missionId, target: 'gpt-b' }), /Overlapping active writer/);
  await answer(m, writer);
  // Back in the queue it is still a started writer.
  await assert.rejects(m.withdrawUnstarted('claude', writer.id, 'x'), /started writer is never withdrawn/);
  assert.deepEqual((await m.uncertainWriters()).map(x => [x.workId, x.state]), [[writer.id, 'QUEUED']]);
  const closed = await m.reconcileWriter({ workId: writer.id, attemptId: wc.attemptId!, leaseGeneration: wc.leaseGeneration, resolution: 'CONFIRMED_NO_EFFECTS',
    evidence: 'Looked at the repository: no branch, no commit, no pull request from this work.', isolationEvidence: 'The worker session ended when it asked; nothing of it is running anywhere.' });
  assert.equal(closed.state, 'ABORTED_NO_EFFECTS');
  assert.deepEqual(await m.pending('gpt-a'), []);
  // Work that was never claimed is withdrawn as always.
  const fresh = await m.delegate('claude', work('fresh', 'implementer'));
  assert.equal((await m.withdrawUnstarted('claude', fresh.id, 'wrong host')).withdrawn, true);
}));

test('answered work is rung again with its own event, and counts as unclaimed from the answer, not from its creation', () => fixture(async (m, dir) => {
  const callback = 'https://connectors.api.openai.com/mcp-events/test-callback';
  const posted: string[] = [];
  const post: EventPost = async (_url, _headers, body) => {
    const parsed = JSON.parse(body) as { type?: string; challenge?: string; eventId?: string };
    if (parsed.type === 'verification') return { status: 200, body: JSON.stringify({ challenge: parsed.challenge }) };
    posted.push(parsed.eventId!);
    return { status: 204, body: '' };
  };
  const events = new WorkforceEvents(dir, post);
  await events.subscribe('gpt-b', { name: WORK_EVENT, arguments: { host: 'gpt-b' }, delivery: { mode: 'webhook', url: callback, secret: 'whsec_' + Buffer.alloc(32, 7).toString('base64') } });
  const w = await m.delegate('claude', { ...work('ring'), target: 'gpt-b' });
  const reconcile = () => reconcileWorkforceEventOutbox(['gpt-b'], host => m.pending(host), events);
  await reconcile();
  await reconcile();
  assert.equal(posted.length, 1, 'one event while it waits in the queue');
  const c = await m.claim('gpt-b', w.id);
  await m.message('gpt-b', { missionId: w.missionId, to: 'claude', workId: w.id, kind: 'QUESTION', text: 'Which base?', attemptId: c.attemptId!, leaseGeneration: c.leaseGeneration });
  await reconcile();
  assert.equal(posted.length, 1, 'parked work rings nobody');
  patch(dir, w.id, x => { x.createdAt = new Date(Date.now() - 2 * UNCLAIMED_AFTER_SECONDS * 1000).toISOString(); });
  await m.message('claude', { missionId: w.missionId, to: 'gpt-b', workId: w.id, kind: 'ANSWER', text: 'main' });
  await reconcile();
  await reconcile();
  assert.equal(posted.length, 2, 'the answer rings its worker once more');
  assert.notEqual(posted[1], posted[0]);
  // Old by creation, new in the queue: not reported as unclaimed until its rings had their time again.
  assert.deepEqual(await m.unclaimedQueued(UNCLAIMED_AFTER_SECONDS * 1000), []);
  patch(dir, w.id, x => { x.queuedAt = new Date(Date.now() - UNCLAIMED_AFTER_SECONDS * 1000 - 60_000).toISOString(); });
  const late = await m.unclaimedQueued(UNCLAIMED_AFTER_SECONDS * 1000);
  assert.deepEqual(late.map(x => [x.workId, x.neverClaimed]), [[w.id, false]]);
  await assert.rejects(m.complete('gpt-b', w.id, c.attemptId!, c.leaseGeneration, 'late'), /Stale work lease/);
}));

test('a leader switch reconciles a writer that went back to the queue with an answer; answered work is never handed to a transport', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'panter-question-switch-'));
  const prior = { o: process.env.PANTER_OWNER_MODE, l: process.env.PANTER_LEAD_HOST };
  process.env.PANTER_OWNER_MODE = '1';
  try {
    const m = await MeshEngine.open(dir);
    await m.setProfile('claude', profile('gpt-a'), 0);
    const writer = await m.delegate('claude', work('switch-writer', 'implementer'));
    const reader = await m.delegate('claude', { ...work('switch-reader'), missionId: 'm-switch-reader' });
    const fresh = await m.delegate('claude', { ...work('switch-fresh'), missionId: 'm-switch-fresh' });
    for (const w of [writer, reader]) { await m.claim('gpt-a', w.id); await ask(m, w); await answer(m, w); }
    // The mail relay sends the instruction only: it cannot take work that came back with an answer.
    await assert.rejects(m.claim('gpt-a', reader.id, 600, true, true, true), /Work is not claimable/);
    assert.equal(stored(dir, reader.id).state, 'QUEUED');
    // gpt-a becomes the leader: its own queue can never be claimed now.
    process.env.PANTER_LEAD_HOST = 'gpt-a';
    await MeshEngine.open(dir);
    assert.equal(stored(dir, writer.id).state, 'OUTCOME_UNKNOWN', 'a started writer is reconciled, not declared clean');
    assert.equal(stored(dir, reader.id).state, 'ABORTED_NO_EFFECTS');
    assert.match(stored(dir, reader.id).result, /back in the queue after an answer/);
    assert.match(stored(dir, fresh.id).result, /never claimed/);
  } finally {
    process.env.PANTER_LEAD_HOST = prior.l ?? 'claude';
    if (prior.o === undefined) delete process.env.PANTER_OWNER_MODE; else process.env.PANTER_OWNER_MODE = prior.o;
    await rm(dir, { recursive: true, force: true });
  }
});

test('owner mode too: an old session of the same host cannot park a newer attempt that asked nothing', () => fixture(async (m, dir) => {
  const w = await m.delegate('claude', work('old-session', 'implementer'));
  const a = await m.claim('gpt-a', w.id);
  await ask(m, w);
  await answer(m, w);
  const b = await m.claim('gpt-a', w.id);
  assert.equal(b.leaseGeneration, 2);
  // The session of attempt A is still open and asks again: without a fence it is a message, with its own it is stale.
  const unfenced = await ask(m, w, null);
  assert.equal(unfenced.work, undefined);
  await assert.rejects(ask(m, w, { attemptId: a.attemptId!, leaseGeneration: a.leaseGeneration }), /Stale work lease/);
  const now = stored(dir, w.id);
  assert.deepEqual({ state: now.state, attemptId: now.attemptId, ringCycle: now.ringCycle }, { state: 'RUNNING', attemptId: b.attemptId, ringCycle: 1 });
  assert.ok(Date.parse(now.leaseUntil) > Date.now());
  // An answer to that stray question changes nothing either: B keeps running and finishes.
  assert.equal((await answer(m, w)).work, undefined);
  assert.equal((await m.complete('gpt-a', w.id, b.attemptId!, b.leaseGeneration, 'done')).state, 'COMPLETED');
}));

test('an event of an earlier time in the queue that was never sent is cancelled when the answer brings its own', () => fixture(async (m, dir) => {
  const posted: string[] = [];
  let down = true;
  const post: EventPost = async (_url, _headers, body) => {
    const parsed = JSON.parse(body) as { type?: string; challenge?: string; eventId?: string };
    if (parsed.type === 'verification') return { status: 200, body: JSON.stringify({ challenge: parsed.challenge }) };
    if (down) return { status: 503, body: '' };
    posted.push(parsed.eventId!);
    return { status: 204, body: '' };
  };
  const events = new WorkforceEvents(dir, post);
  await events.subscribe('gpt-b', { name: WORK_EVENT, arguments: { host: 'gpt-b' }, delivery: { mode: 'webhook', url: 'https://connectors.api.openai.com/mcp-events/test-callback', secret: 'whsec_' + Buffer.alloc(32, 7).toString('base64') } });
  const w = await m.delegate('claude', { ...work('two-cycles'), target: 'gpt-b' });
  const reconcile = () => reconcileWorkforceEventOutbox(['gpt-b'], host => m.queueSnapshot(host), events);
  // The first event is still waiting for a retry when the work is claimed, parked and answered, with no outbox
  // pass in between that would have seen it leave the queue.
  await reconcile();
  assert.equal(events.status('claude').pending, 1);
  const c = await m.claim('gpt-b', w.id);
  await m.message('gpt-b', { missionId: w.missionId, to: 'claude', workId: w.id, kind: 'QUESTION', text: 'Which base?', attemptId: c.attemptId!, leaseGeneration: c.leaseGeneration });
  await m.message('claude', { missionId: w.missionId, to: 'gpt-b', workId: w.id, kind: 'ANSWER', text: 'main' });
  down = false;
  const ledger = SqliteLedger.open(dir);
  ledger.mutate('events', {} as any, (d: any) => { for (const x of d.deliveries) x.nextAt = 0; });
  ledger.close();
  await reconcile();
  await reconcile();
  assert.equal(posted.length, 1, 'one ring for one answer');
  const status = events.status('claude');
  assert.deepEqual({ pending: status.pending, accepted: status.accepted, cancelled: status.cancelled }, { pending: 0, accepted: 1, cancelled: 1 });
  // The same when the earlier event was mid-send and the process stopped: once its send lease ran out it is as
  // retryable as a pending one. One still inside its lease is left to finish.
  for (const [lease, expectPosts, expectCancelled] of [[-1000, 1, 1], [60_000, 1, 0]] as const) {
    const w2 = await m.delegate('claude', { ...work('sending' + lease), target: 'gpt-b', missionId: 'm-sending' + lease });
    down = true;
    await reconcile();
    const c2 = await m.claim('gpt-b', w2.id);
    await m.message('gpt-b', { missionId: w2.missionId, to: 'claude', workId: w2.id, kind: 'QUESTION', text: 'Which base?', attemptId: c2.attemptId!, leaseGeneration: c2.leaseGeneration });
    await m.message('claude', { missionId: w2.missionId, to: 'gpt-b', workId: w2.id, kind: 'ANSWER', text: 'main' });
    const db = SqliteLedger.open(dir);
    db.mutate('events', {} as any, (d: any) => { for (const x of d.deliveries) if (x.workId === w2.id) { x.state = 'SENDING'; x.nextAt = Date.now() + lease; } });
    db.close();
    down = false;
    const beforePosts: number = posted.length; const beforeCancelled: number = events.status("claude").cancelled;
    await reconcile();
    assert.equal(posted.length - beforePosts, expectPosts, `one ring for the answer (send lease ${lease})`);
    assert.equal(events.status('claude').cancelled - beforeCancelled, expectCancelled, `send lease ${lease}`);
    await m.claim('gpt-b', w2.id);
    await reconcile();
  }
}));
