// End to end through ServerActions with a real SQLite ledger: permit -> gates -> RESERVED -> transient unit ->
// wrapper -> reconciler -> receipts. systemd, curl and deploy.sh are fakes; the wrapper is the real one.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import {
  chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync,
  readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MeshEngine } from '../src/core/mesh.js';
import { ServerActions } from '../src/core/server-actions.js';
import { ServerActionsLedger } from '../src/core/server-actions-ledger.js';
import { SqliteLedger } from '../src/core/sqlite-ledger.js';

const sha = 'a'.repeat(40);
const head = 'b'.repeat(40);
const earlier = 'c'.repeat(40);
const repo = 'example-org/panter';
const wrapper = fileURLToPath(new URL('../deploy/run-action.sh', import.meta.url));
const gone = 'LoadState=loaded\nActiveState=inactive\n';
const live = 'LoadState=loaded\nActiveState=active\n';
const profile = { host: 'grok' as const, actorId: 'fake-grok', modelRequest: 'host-default',
  effortRequest: 'max', roles: ['reviewer' as const] };

/** GitHub as the deploy gate needs it: one merged PR for the commit, green checks, an independent approval. */
const github: typeof fetch = (async (url: RequestInfo | URL) => {
  const rest = new URL(String(url)).pathname.slice(('/repos/' + repo).length).replace(/^\//, '');
  const pr = { number: 9, merged_at: '2026-01-01T00:00:00Z', base: { ref: 'main' }, merge_commit_sha: sha,
    head: { sha: head }, user: { login: 'author-user' } };
  const payload: unknown =
    rest === '' ? { default_branch: 'main' } :
    rest.startsWith('compare/') ? { status: 'identical' } :
    rest === 'commits/' + sha + '/pulls' ? [pr] :
    rest === 'commits/' + sha + '/check-runs' ? { total_count: 2, check_runs: [
      { name: 'test', id: 2, status: 'completed', conclusion: 'success', head_sha: sha },
      { name: 'arm64-image', id: 3, status: 'completed', conclusion: 'success', head_sha: sha }] } :
    rest === 'pulls/9' ? { ...pr, commits: 1 } :
    rest === 'pulls/9/commits' ? [{ author: { login: 'author-user' }, committer: { login: 'web-flow' } }] :
    rest === 'pulls/9/reviews' ? [{ id: 30, user: { login: 'review-account' }, state: 'APPROVED',
      commit_id: head, submitted_at: '2026-01-03T00:00:00Z' }] : null;
  assert.ok(payload !== null, 'Unhandled GitHub API path: ' + rest);
  return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

type Mode = 'wrapper' | 'background' | 'fail' | 'hang' | 'accept';

async function world(settings: Record<string, string | undefined> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'panter-server-integration-'));
  const data = join(root, 'data');
  const base = join(root, 'base');
  const bin = join(root, 'bin');
  const scripts = join(base, 'current', 'deploy');
  for (const dir of [data, bin, scripts]) mkdirSync(dir, { recursive: true });
  const unitFile = join(root, 'unit.txt');
  const runLog = join(root, 'runs.txt');
  const go = join(root, 'go');
  writeFileSync(unitFile, gone);
  copyFileSync(wrapper, join(scripts, 'run-action.sh'));
  // The deployment waits for the test to say go, so a test can look at an action in the middle of it.
  writeFileSync(join(scripts, 'deploy.sh'), '#!/bin/sh\nwhile [ ! -e "' + go + '" ]; do sleep 0.02; done\n' +
    'echo "deploy: building"\necho "token=build-secret-123"\necho "deploy: live"\n');
  writeFileSync(join(bin, 'systemctl'), [
    '#!/bin/sh',
    'if [ "$2" = show ]; then cat "' + unitFile + '"',
    'elif [ "$2" = stop ]; then echo stop >> "' + root + '/stops.txt"',
    'else exit 9; fi',
  ].join('\n') + '\n');
  // Like systemd, the command gets nothing but the variables given through --setenv.
  writeFileSync(join(bin, 'systemd-run'), [
    '#!/usr/bin/env bash',
    'printf "%s\\n" "$@" >> "' + runLog + '"',
    'mode=$(cat "' + root + '/mode")',
    'vars=()',
    'while [[ ${1-} == --* ]]; do [[ $1 == --setenv=* ]] && vars+=("${1#--setenv=}"); shift; done',
    'case "$mode" in',
    '  fail) exit 1 ;;',
    '  hang) printf "' + live.replace(/\n/g, '\\n') + '" > "' + unitFile + '"; sleep 5 ;;',
    '  accept) exit 0 ;;',
    '  wrapper) env -i "${vars[@]}" "$@" ;;',
    '  background)',
    '    printf "' + live.replace(/\n/g, '\\n') + '" > "' + unitFile + '"',
    '    ( env -i "${vars[@]}" "$@"; printf "' + gone.replace(/\n/g, '\\n') + '" > "' + unitFile + '" ) >/dev/null 2>&1 </dev/null &',
    '    ;;',
    'esac',
  ].join('\n') + '\n');
  writeFileSync(join(bin, 'curl'), '#!/bin/sh\nprintf \'{"status":"ok","revision":"' + sha + '"}\\n\'\n');
  for (const name of ['systemctl', 'systemd-run', 'curl', '../base/current/deploy/run-action.sh', '../base/current/deploy/deploy.sh'])
    chmodSync(join(bin, name), 0o700);
  const setMode = (mode: Mode) => writeFileSync(join(root, 'mode'), mode);
  setMode('wrapper');
  writeFileSync(go, 'go');

  const config: Record<string, string | undefined> = {
    PANTER_SERVER_ACTIONS: 'deploy.commit', PANTER_SERVER_DEPLOY_REPOSITORY: repo,
    PANTER_SERVER_DEPLOY_CHECKS: 'test,arm64-image', PANTER_GITHUB_INDEPENDENT_REVIEWER: 'review-account',
    PANTER_SERVER_DEPLOY_SOURCE: join(root, 'clone'), PANTER_SERVER_DEPLOY_STANDING_AUTHORIZATION: '1',
    PANTER_BASE: base, PANTER_GITHUB_TOKEN: 'never-reaches-the-unit', ...settings,
  };
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: bin + ':' + process.env.PATH };
  const mesh = await MeshEngine.open(data);
  await mesh.setProfile('gpt-a', profile, 0);
  const open = (extra: { launchTimeoutMs?: number } = {}) =>
    new ServerActions(mesh, data, config, github, async () => ({ revision: earlier, maintenance: false }), { env, ...extra });
  let server = open();
  const actions = join(base, 'etc', 'actions');
  return {
    root, data, base, actions, runLog, unitFile, mesh, config, setMode,
    get server() { return server; },
    /** Panter restarts: a new process over the same data and the same base directory. */
    restart(extra: { launchTimeoutMs?: number } = {}) { server.close(); server = open(extra); return server; },
    hold() { rmSync(go, { force: true }); },
    release() { writeFileSync(go, 'go'); },
    async unitGone() {
      for (let i = 0; i < 400 && readFileSync(unitFile, 'utf8') !== gone; i++) await new Promise(r => setTimeout(r, 25));
      assert.equal(readFileSync(unitFile, 'utf8'), gone, 'the fake unit finished');
    },
    async workerPermit() {
      const work = await mesh.delegate('gpt-a', { missionId: 'release', target: 'grok', role: 'reviewer',
        instruction: 'Deploy the approved release', idempotencyKey: randomUUID() });
      const permit = await server.grant('gpt-a', { workId: work.id, action: 'deploy.commit', args: { sha } });
      const claim = await mesh.claim('grok', work.id);
      return { work, permit, input: { action: 'deploy.commit' as const, args: { sha }, permitId: permit.permitId,
        workId: work.id, attemptId: claim.attemptId!, leaseGeneration: claim.leaseGeneration } };
    },
    receipts: async (host: 'gpt-a' | 'grok') => (await mesh.inbox(host)).messages.filter(m => m.id.startsWith('server-action:')),
    cleanup() { server.close(); rmSync(root, { recursive: true, force: true }); },
  };
}
const states = (a: { transitions: Array<{ state: string }> }) => a.transitions.map(t => t.state);

test('worker permit, end to end: RESERVED -> LAUNCHED -> RUNNING -> LIVE across a Panter restart', async () => {
  const w = await world({ PANTER_HEALTH_URL: 'http://127.0.0.1:1/health', PANTER_KEEP_RELEASES: '4' });
  try {
    const { input, permit } = await w.workerPermit();
    w.setMode('background'); w.hold();
    const out = await w.server.action('grok', input);
    assert.equal(out.status, 'LAUNCHED');
    assert.equal(out.permitState, 'SPENT');
    assert.deepEqual(out.checks.map(c => c.precondition),
      ['AUTHORIZATION', 'ON_MAIN', 'MERGED_PR', 'GREEN_CHECKS', 'INDEPENDENT_REVIEW', 'LOCAL_STATE']);
    assert.match(String(out.note), /connection will drop/);
    const id = out.actionId;

    // The unit received deploy.sh's settings and nothing else from Panter's environment.
    const argv = readFileSync(w.runLog, 'utf8').split('\n');
    assert.ok(argv.includes('--unit=panter-action-' + id));
    assert.ok(argv.includes('--setenv=PANTER_BASE=' + w.base));
    assert.ok(argv.includes('--setenv=PANTER_HEALTH_URL=http://127.0.0.1:1/health'));
    assert.ok(argv.includes('--setenv=PANTER_KEEP_RELEASES=4'));
    assert.deepEqual(argv.filter(a => a.startsWith('--setenv=')).map(a => a.split('=')[1]).sort(),
      ['PANTER_BASE', 'PANTER_HEALTH_URL', 'PANTER_KEEP_RELEASES', 'PANTER_SOURCE_REPO', 'PATH']);
    assert.doesNotMatch(argv.join('\n'), /never-reaches-the-unit/);
    assert.deepEqual(argv.slice(-4, -1), ['deploy.commit', id, sha]);

    // The deployment is under way: the wrapper holds the fence inside a live unit.
    for (let i = 0; i < 200 && !existsSync(join(w.actions, id + '.json')); i++) await new Promise(r => setTimeout(r, 25));
    await w.server.reconcile();
    let seen = (await w.server.status('grok', id)).actions[0]!;
    assert.equal(seen.state, 'RUNNING');
    assert.equal(readlinkSync(join(w.actions, id + '.fence')), 'run');
    assert.equal((await w.receipts('gpt-a')).length + (await w.receipts('grok')).length, 0, 'no receipt before the end');
    await assert.rejects(w.server.action('gpt-a', { action: 'deploy.commit', args: { sha } }), /BUSY/, 'the slot is taken');

    // The deployment restarts Panter. The new process finds the action still running, then settles it.
    const next = w.restart();
    await next.start();
    assert.equal((await next.status('gpt-a', id)).actions[0]!.state, 'RUNNING');
    w.release();
    await w.unitGone();
    await next.reconcile();
    seen = (await next.status('grok', id)).actions[0]!;
    assert.equal(seen.state, 'LIVE');
    assert.deepEqual(states(seen), ['RESERVED', 'LAUNCHED', 'RUNNING', 'LIVE']);
    assert.equal(seen.exitCode, 0);
    assert.equal(seen.revision, sha);
    assert.match(String(seen.logSha256), /^[0-9a-f]{64}$/);
    assert.ok(seen.completedAt);
    // Audit: who, with what, and every gate.
    assert.equal(seen.host, 'grok');
    assert.equal(seen.permitId, permit.permitId);
    assert.equal(seen.issuedBy, 'gpt-a');
    assert.equal(seen.authorization, 'standing');
    assert.equal(seen.checks.length, 6);
    // The end of the log, redacted, for the worker that ran it and for the leader; nobody else sees the action.
    assert.match(String(seen.logTail), /deploy: live/);
    assert.match(String(seen.logTail), /token=\[REDACTED\]/);
    assert.doesNotMatch(String(seen.logTail), /build-secret/);
    assert.match(String((await next.status('gpt-a', id)).actions[0]!.logTail), /deploy: live/);
    assert.equal((await next.status('gpt-b', id)).actions.length, 0);

    // One receipt for the leader and one for the worker, however often the reconciler runs or Panter restarts.
    await next.reconcile();
    const again = w.restart(); await again.start(); await again.reconcile();
    for (const host of ['gpt-a', 'grok'] as const) {
      const got = (await w.receipts(host));
      assert.equal(got.length, 1, host);
      assert.deepEqual(JSON.parse(got[0]!.text), { serverAction: 'deploy.commit', actionId: id, sha, state: 'LIVE',
        exitCode: 0, revision: sha, logSha256: seen.logSha256 });
      assert.doesNotMatch(got[0]!.text, /deploy: live|build-secret/, 'the log is not in the receipt');
    }
    assert.equal((await w.receipts('gpt-a'))[0]!.from, 'grok');
    assert.equal((await w.receipts('grok'))[0]!.from, 'gpt-a');
    assert.equal((await again.status('gpt-a')).permits.find(p => p.permitId === permit.permitId)?.effectiveState, 'SPENT');
    // The slot is free again.
    w.setMode('wrapper');
    assert.equal((await again.action('gpt-a', { action: 'deploy.commit', args: { sha } })).status, 'LAUNCHED');
    // etc/actions is private and holds only what the wrapper wrote.
    assert.equal(lstatSync(w.actions).mode & 0o777, 0o700);
    assert.deepEqual(readdirSync(w.actions).filter(n => n.startsWith(id)).sort(), [id + '.fence', id + '.json', id + '.log']);
  } finally { w.cleanup(); }
});

test('direct leader action: launched, settled, and only the leader is told', async () => {
  const w = await world();
  try {
    const out = await w.server.action('gpt-a', { action: 'deploy.commit', args: { sha } });
    assert.equal(out.status, 'LAUNCHED');
    assert.equal(out.permitState, 'NOT_APPLICABLE');
    await w.server.reconcile();
    const seen = (await w.server.status('gpt-a', out.actionId)).actions[0]!;
    assert.equal(seen.state, 'LIVE');
    assert.deepEqual(states(seen), ['RESERVED', 'LAUNCHED', 'LIVE']);
    assert.equal((await w.receipts('gpt-a')).length, 1);
    assert.equal((await w.receipts('grok')).length, 0);
  } finally { w.cleanup(); }
});

test('a second action while one is open is BUSY and its permit is lost; after the end a new one reserves', async () => {
  const w = await world();
  try {
    const first = await w.workerPermit();
    const second = await w.workerPermit();
    w.setMode('background'); w.hold();
    const out = await w.server.action('grok', first.input);
    await assert.rejects(w.server.action('grok', second.input), /BUSY; PERMIT_LOST/);
    const status = await w.server.status('gpt-a');
    assert.equal(status.actions.length, 1);
    assert.equal(status.permits.find(p => p.permitId === second.permit.permitId)?.effectiveState, 'PERMIT_LOST');
    assert.equal(readFileSync(w.runLog, 'utf8').match(/--unit=/g)?.length, 1, 'nothing was launched for the loser');
    w.release(); await w.unitGone(); await w.server.reconcile();
    assert.equal((await w.server.status('gpt-a', out.actionId)).actions[0]!.state, 'LIVE');
    const third = await w.workerPermit();
    w.setMode('wrapper');
    assert.equal((await w.server.action('grok', third.input)).status, 'LAUNCHED');
  } finally { w.cleanup(); }
});

test('systemd-run fails: START_FAILED behind a closed fence, slot free, receipts sent', async () => {
  const w = await world();
  try {
    const { input } = await w.workerPermit();
    w.setMode('fail');
    const out = await w.server.action('grok', input);
    assert.equal(out.status, 'START_FAILED');
    assert.equal(out.state, 'START_FAILED');
    assert.equal(readlinkSync(join(w.actions, out.actionId + '.fence')), 'closed');
    assert.deepEqual(readdirSync(w.actions), [out.actionId + '.fence'], 'no record, no log: nothing ran');
    assert.equal((await w.receipts('gpt-a')).length, 1);
    assert.equal((await w.receipts('grok')).length, 1);
    assert.equal(JSON.parse((await w.receipts('grok'))[0]!.text).state, 'START_FAILED');
    w.setMode('wrapper');
    assert.equal((await w.server.action('gpt-a', { action: 'deploy.commit', args: { sha } })).status, 'LAUNCHED');
  } finally { w.cleanup(); }
});

test('systemd-run hangs with the unit alive: never START_FAILED; the action waits for the reconciler', async () => {
  const w = await world();
  try {
    const server = w.restart({ launchTimeoutMs: 400 });
    const { input } = await w.workerPermit();
    w.setMode('hang');
    const out = await server.action('grok', input);
    assert.equal(out.status, 'DEFERRED');
    assert.equal(out.state, 'RESERVED');
    assert.equal(readlinkSync(join(w.actions, out.actionId + '.fence')), 'closed', 'a late unit will find the fence closed');
    assert.equal((await w.receipts('gpt-a')).length, 0);
    await assert.rejects(server.action('gpt-a', { action: 'deploy.commit', args: { sha } }), /BUSY/);
    writeFileSync(w.unitFile, gone);
    await server.reconcile();
    assert.equal((await server.status('gpt-a', out.actionId)).actions[0]!.state, 'ABANDONED');
    assert.equal((await w.receipts('gpt-a')).length, 1);
  } finally { w.cleanup(); }
});

test('a receipt that cannot be written leaves the action terminal and the slot free, and is retried', async () => {
  const w = await world();
  try {
    const { input } = await w.workerPermit();
    const real = w.mesh.serverReceipt.bind(w.mesh);
    let failures = 0;
    w.mesh.serverReceipt = async (...args: Parameters<typeof real>) => {
      if (failures++ < 2) throw new Error('inbox unavailable');
      return real(...args);
    };
    const out = await w.server.action('grok', input);
    await w.server.reconcile().catch(() => undefined);
    const seen = (await w.server.status('gpt-a', out.actionId)).actions[0]!;
    assert.equal(seen.state, 'LIVE');
    assert.equal(seen.receiptSentAt, undefined);
    assert.equal((await w.receipts('gpt-a')).length, 0);
    assert.equal((await w.server.action('gpt-a', { action: 'deploy.commit', args: { sha } })).status, 'LAUNCHED',
      'an undelivered receipt does not hold the slot');
    for (let i = 0; i < 3; i++) await w.server.reconcile().catch(() => undefined);
    assert.equal((await w.receipts('gpt-a')).filter(m => m.id.includes(out.actionId)).length, 1);
    assert.equal((await w.receipts('grok')).filter(m => m.id.includes(out.actionId)).length, 1);
    assert.equal(typeof (await w.server.status('gpt-a', out.actionId)).actions[0]!.receiptSentAt, 'string');
  } finally { w.cleanup(); }
});

test('a server that cannot run the wrapper refuses before a permit is spent', async () => {
  const w = await world();
  try {
    const { input, permit } = await w.workerPermit();
    rmSync(join(w.base, 'current', 'deploy', 'run-action.sh'));
    await assert.rejects(w.server.action('grok', input), /SERVER_ACTIONS_UNAVAILABLE: the live release has no deploy\/run-action\.sh/);
    assert.equal((await w.server.status('gpt-a')).permits.find(p => p.permitId === permit.permitId)?.state, 'ISSUED');
    assert.equal((await w.server.status('gpt-a')).actions.length, 0);
    copyFileSync(wrapper, join(w.base, 'current', 'deploy', 'run-action.sh'));
    rmSync(w.actions, { recursive: true, force: true });
    writeFileSync(w.actions, 'not a directory');
    await assert.rejects(w.server.action('grok', input), /SERVER_ACTIONS_UNAVAILABLE: cannot provision etc\/actions/);
    assert.equal((await w.server.status('gpt-a')).permits.find(p => p.permitId === permit.permitId)?.state, 'ISSUED');
    const spaced = await world({ PANTER_UNIT: 'two words.service' });
    try {
      await assert.rejects(spaced.server.action('gpt-a', { action: 'deploy.commit', args: { sha } }), /SERVER_ACTIONS_UNAVAILABLE: PANTER_UNIT/);
      assert.equal(existsSync(spaced.runLog), false);
    } finally { spaced.cleanup(); }
  } finally { w.cleanup(); }
});

test('explicit dry run: every gate, SPENT and RESERVED, and nothing on the server', async () => {
  const w = await world({ PANTER_SERVER_DEPLOY_DRY_RUN: '1' });
  try {
    await w.server.start();
    const { input } = await w.workerPermit();
    const out = await w.server.action('grok', input);
    assert.equal(out.status, 'DRY_RUN');
    assert.equal(out.permitState, 'SPENT');
    const status = await w.server.status('gpt-a', out.actionId);
    assert.equal(status.dryRun, true);
    assert.deepEqual(states(status.actions[0]!), ['RESERVED', 'DRY_RUN']);
    assert.equal(status.actions[0]!.logTail, undefined);
    await w.server.reconcile();
    assert.equal(existsSync(w.runLog), false, 'systemd-run was never called');
    assert.equal(existsSync(join(w.base, 'etc')), false, 'nothing was provisioned');
    assert.equal((await w.receipts('gpt-a')).length, 0);
    assert.equal((await w.server.action('gpt-a', { action: 'deploy.commit', args: { sha } })).status, 'DRY_RUN', 'the slot was freed');
  } finally { w.cleanup(); }
});

test('disabled: no directory, no table, no timer, and every tool says so', async () => {
  const root = mkdtempSync(join(tmpdir(), 'panter-server-disabled-'));
  const mesh = await MeshEngine.open(join(root, 'data'));
  const server = new ServerActions(mesh, join(root, 'data'), { PANTER_BASE: join(root, 'base') });
  try {
    await server.start();
    await server.reconcile();
    assert.equal(server.enabled, false);
    assert.equal(existsSync(join(root, 'base')), false);
    await assert.rejects(server.action('gpt-a', { action: 'deploy.commit', args: { sha } }), /SERVER_ACTIONS_DISABLED/);
    await assert.rejects(server.status('gpt-a'), /SERVER_ACTIONS_DISABLED/);
    assert.throws(() => server.authorize('admin', { action: 'deploy.commit', sha }), /SERVER_ACTIONS_DISABLED/);
    const tables = SqliteLedger.open(join(root, 'data'));
    try { assert.equal(tables.revision('server_actions'), 0, 'the server-actions ledger was never written'); }
    finally { tables.close(); }
  } finally { server.close(); rmSync(root, { recursive: true, force: true }); }
});

test('a ledger written before the runner existed opens, keeps its history and takes new actions', async () => {
  const w = await world();
  try {
    // What the previous release stored: a dry run, without the fields the runner added.
    const old = new ServerActionsLedger(w.data, w.config);
    const legacy = '99999999-9999-4999-8999-999999999999';
    old.reserve({ actionId: legacy, action: 'deploy.commit', args: { sha }, host: 'gpt-a', workId: null,
      attemptId: null, leaseGeneration: null, permitId: null, issuedBy: 'gpt-a', authorizationId: null, checks: [] });
    old.finishDryRun(legacy);
    old.close();
    const raw = SqliteLedger.open(w.data);
    raw.mutate<{ actions: Array<Record<string, unknown>> }, void>('server_actions', { actions: [] }, d => {
      for (const a of d.actions) { delete a.sha; delete a.reservedAt; }
    });
    raw.close();

    const server = w.restart();
    await server.start();
    assert.deepEqual((await server.status('gpt-a')).actions.map(a => [a.actionId, a.state]), [[legacy, 'DRY_RUN']]);
    const out = await server.action('gpt-a', { action: 'deploy.commit', args: { sha } });
    assert.equal(out.status, 'LAUNCHED');
    await server.reconcile();
    assert.deepEqual((await server.status('gpt-a')).actions.map(a => a.state), ['DRY_RUN', 'LIVE']);
    assert.equal((await w.receipts('gpt-a')).length, 1, 'the old dry run is not a runner action: no receipt for it');
  } finally { w.cleanup(); }
});
