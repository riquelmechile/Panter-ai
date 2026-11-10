import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync,
  readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  launchServerAction, MemoryServerActionStore, startServerActionReconciler, reconcileServerAction,
  reconcileServerActions, serverActionLogTail, SERVER_ACTION_LAUNCH_TIMEOUT_MS,
  type RunnerOptions, type ServerAction, type ServerActionReceipt,
} from '../src/core/server-action-runner.js';

const id = '00000000-0000-4000-8000-000000000001';
const sha = 'a'.repeat(40);
const stamp = new Date('2026-11-09T12:00:00Z').getTime();
const earlier = (minutes: number) => new Date(stamp - minutes * 60_000).toISOString();
const wrapper = fileURLToPath(new URL('../deploy/run-action.sh', import.meta.url));
const gone = 'LoadState=loaded\nActiveState=inactive\n';
const live = 'LoadState=loaded\nActiveState=active\n';

type RecordKind = 'none' | 'running' | 'final' | 'bad' | 'unreadable';
type FenceKind = 'absent' | 'run' | 'closed' | 'odd';

function fixture(ageMinutes = 3) {
  const baseDir = mkdtempSync(join(tmpdir(), 'panter-action-runner-'));
  const actions = join(baseDir, 'etc', 'actions');
  const bin = join(baseDir, 'bin');
  const scripts = join(baseDir, 'current', 'deploy');
  mkdirSync(actions, { recursive: true });
  mkdirSync(bin);
  mkdirSync(scripts, { recursive: true });
  const deploy = join(scripts, 'deploy.sh');
  writeFileSync(deploy, '#!/bin/sh\necho test-deployment\n');
  chmodSync(deploy, 0o700);
  copyFileSync(wrapper, join(scripts, 'run-action.sh'));
  chmodSync(join(scripts, 'run-action.sh'), 0o700);
  const unitFile = join(baseDir, 'unit.txt');
  const stopLog = join(baseDir, 'stops.txt');
  const runLog = join(baseDir, 'runs.txt');
  const hook = join(baseDir, 'hook.sh');
  writeFileSync(unitFile, gone);
  const systemctl = join(bin, 'systemctl');
  writeFileSync(systemctl, [
    '#!/bin/sh',
    'if [ "$2" = show ]; then',
    '  result=$(cat "$FAKE_UNIT_FILE")',
    '  if [ -f "$FAKE_SHOW_HOOK" ]; then mv "$FAKE_SHOW_HOOK" "$FAKE_SHOW_HOOK.used"; sh "$FAKE_SHOW_HOOK.used"; fi',
    '  printf "%s\\n" "$result"',
    'elif [ "$2" = stop ]; then',
    '  printf "stop\\n" >> "$FAKE_STOP_LOG"',
    'else exit 9; fi',
  ].join('\n') + '\n');
  const systemd = join(bin, 'systemd-run');
  // Like systemd, the fake starts the command with nothing but the variables
  // given through --setenv: the caller's environment is not inherited.
  writeFileSync(systemd, [
    '#!/usr/bin/env bash',
    'printf "%s\\n" "$@" >> "$FAKE_RUN_LOG"',
    'case "$FAKE_RUN_MODE" in',
    '  fail) exit 1 ;;',
    '  hang) sleep 2 ;;',
    '  wrapper)',
    '    vars=()',
    '    while [[ ${1-} == --* ]]; do [[ $1 == --setenv=* ]] && vars+=("${1#--setenv=}"); shift; done',
    '    exec env -i "${vars[@]}" "$@" ;;',
    '  *) exit 0 ;;',
    'esac',
  ].join('\n') + '\n');
  const curl = join(bin, 'curl');
  writeFileSync(curl, '#!/bin/sh\nprintf \'{"status":"ok","revision":"' + sha + '"}\\n\'\n');
  for (const file of [systemctl, systemd, curl]) chmodSync(file, 0o700);

  const initial: ServerAction = { actionId: id, sha, state: 'RESERVED', reservedAt: earlier(ageMinutes) };
  const store = new MemoryServerActionStore([initial]);
  const receipts: ServerActionReceipt[] = [];
  const env: NodeJS.ProcessEnv = {
    ...process.env, PATH: bin + ':' + process.env.PATH, PANTER_BASE: baseDir,
    FAKE_UNIT_FILE: unitFile, FAKE_STOP_LOG: stopLog, FAKE_RUN_LOG: runLog,
    FAKE_SHOW_HOOK: hook, FAKE_RUN_MODE: 'success',
  };
  const opts: RunnerOptions = {
    store, baseDir, sourceRepo: join(baseDir, 'clone'),
    now: () => new Date(stamp), env,
    notify: (receipt) => { receipts.push(receipt); },
  };
  const paths = {
    fence: join(actions, id + '.fence'), record: join(actions, id + '.json'),
    log: join(actions, id + '.log'), deploy, unitFile, stopLog, runLog, hook,
  };
  function record(kind: RecordKind) {
    if (kind === 'none') return;
    if (kind === 'bad') { writeFileSync(paths.record, '{not-json'); return; }
    if (kind === 'unreadable') { mkdirSync(paths.record); return; }
    writeFileSync(paths.record, JSON.stringify({
      actionId: id, sha, at: new Date(stamp).toISOString(),
      state: kind === 'running' ? 'RUNNING' : 'LIVE',
      exitCode: kind === 'running' ? null : 0,
      revision: kind === 'running' ? null : sha,
    }));
  }
  function fence(kind: FenceKind) {
    if (kind !== 'absent') symlinkSync(kind === 'odd' ? 'unexpected' : kind, paths.fence);
  }
  return {
    baseDir, actions, store, opts, receipts, paths, env, record, fence,
    unit: (text: string) => writeFileSync(unitFile, text),
    state: async () => (await store.read(id))?.state,
    cleanup: () => rmSync(baseDir, { recursive: true, force: true }),
  };
}

const recovery: Array<{
  label: string; fence: FenceKind; record: RecordKind; unit?: string;
  age?: number; expected: ServerAction['state']; expectedFence?: FenceKind;
}> = [
  { label: 'run/final/gone', fence: 'run', record: 'final', expected: 'LIVE' },
  { label: 'any/any/live before limit', fence: 'absent', record: 'final', unit: live, expected: 'RESERVED' },
  { label: 'any/any/live over limit', fence: 'run', record: 'running', unit: live, age: 55, expected: 'STOPPING' },
  { label: 'run/RUNNING/gone', fence: 'run', record: 'running', expected: 'UNKNOWN' },
  { label: 'run/none/gone', fence: 'run', record: 'none', expected: 'UNKNOWN' },
  { label: 'run/malformed/gone', fence: 'run', record: 'bad', expected: 'UNKNOWN' },
  { label: 'run/unreadable/gone', fence: 'run', record: 'unreadable', expected: 'UNKNOWN' },
  { label: 'absent/none/young/gone', fence: 'absent', record: 'none', age: 1, expected: 'RESERVED' },
  { label: 'absent/none/old/gone', fence: 'absent', record: 'none', expected: 'ABANDONED', expectedFence: 'closed' },
  { label: 'closed/none/gone', fence: 'closed', record: 'none', expected: 'ABANDONED' },
  { label: 'closed/RUNNING/gone', fence: 'closed', record: 'running', expected: 'UNKNOWN' },
  { label: 'closed/final/gone', fence: 'closed', record: 'final', expected: 'UNKNOWN' },
  { label: 'absent/RUNNING/gone', fence: 'absent', record: 'running', expected: 'UNKNOWN', expectedFence: 'closed' },
  { label: 'absent/final/gone', fence: 'absent', record: 'final', expected: 'UNKNOWN', expectedFence: 'closed' },
  { label: 'absent/malformed/gone', fence: 'absent', record: 'bad', expected: 'UNKNOWN', expectedFence: 'closed' },
  { label: 'absent/unreadable/gone', fence: 'absent', record: 'unreadable', expected: 'UNKNOWN', expectedFence: 'closed' },
  { label: 'odd/none/gone', fence: 'odd', record: 'none', expected: 'UNKNOWN' },
  { label: 'odd/final/gone', fence: 'odd', record: 'final', expected: 'UNKNOWN' },
];

for (const row of recovery) {
  test('Recovery: ' + row.label, async () => {
    const f = fixture(row.age ?? 3);
    try {
      f.fence(row.fence);
      f.record(row.record);
      if (row.unit) f.unit(row.unit);
      writeFileSync(f.paths.log, 'output\n');
      await reconcileServerAction(f.opts, id);
      assert.equal(await f.state(), row.expected);
      if (row.expectedFence) assert.equal(readlinkSync(f.paths.fence), row.expectedFence);
      assert.equal(f.receipts.length, ['RESERVED', 'LAUNCHED', 'RUNNING', 'STOPPING'].includes(row.expected) ? 0 : 1);
      if (row.expected === 'STOPPING') {
        assert.match(readFileSync(f.paths.stopLog, 'utf8'), /stop/);
        assert.equal((await f.store.read(id))?.transitions?.[0]?.state, 'STOPPING');
      }
    } finally { f.cleanup(); }
  });
}

for (const active of ['activating', 'active', 'reloading', 'deactivating', 'inactive', 'failed']) {
  test('systemd ActiveState=' + active, async () => {
    const f = fixture();
    try {
      f.fence('run');
      f.record('final');
      f.unit('LoadState=loaded\nActiveState=' + active + '\n');
      await reconcileServerAction(f.opts, id);
      assert.equal(await f.state(), ['inactive', 'failed'].includes(active) ? 'LIVE' : 'RESERVED');
    } finally { f.cleanup(); }
  });
}
test('LoadState=not-found means a gone unit', async () => {
  const f = fixture();
  try {
    f.fence('run');
    f.record('final');
    f.unit('LoadState=not-found\nActiveState=inactive\n');
    await reconcileServerAction(f.opts, id);
    assert.equal(await f.state(), 'LIVE');
  } finally { f.cleanup(); }
});

test('launched unit uses fixed argv, SHA from transaction, one normal launch', async () => {
  const f = fixture();
  try {
    assert.equal(await launchServerAction(f.opts, id), 'LAUNCHED');
    assert.equal((await f.store.read(id))?.launchStartedAt, new Date(stamp).toISOString());
    assert.equal(await f.state(), 'LAUNCHED');
    const args = readFileSync(f.paths.runLog, 'utf8').split('\n');
    assert.deepEqual(args.slice(0, 6), [
      '--user', '--unit=panter-action-' + id, '--collect',
      '--property=RuntimeMaxSec=45min', '--setenv=PANTER_SOURCE_REPO=' + f.opts.sourceRepo,
      '--setenv=PANTER_BASE=' + f.baseDir,
    ]);
    const pathArg = args[6] ?? '';
    const unitPath = pathArg.replace(/^--setenv=PATH=/, '').split(':');
    assert.match(pathArg, /^--setenv=PATH=\//);
    assert.equal(unitPath[0], join(f.baseDir, 'bin'), 'the unit searches the same PATH as Panter');
    assert.ok(unitPath.includes(join(process.execPath, '..')), 'and always finds the node Panter runs on');
    assert.ok(unitPath.every((entry) => entry.startsWith('/')));
    assert.equal(args[7], join(f.baseDir, 'current', 'deploy', 'run-action.sh'));
    assert.equal(args[8], 'deploy.commit');
    assert.equal(args[9], id);
    assert.equal(args[10], sha);
    assert.equal(args.length, 12, 'nothing else reaches systemd-run');
    assert.equal(await launchServerAction(f.opts, id), 'SKIPPED');
    assert.equal(readFileSync(f.paths.runLog, 'utf8').match(/--unit=/g)?.length, 1);
  } finally { f.cleanup(); }
});

test('launcher re-reads RESERVED and refuses any other state without side effects', async () => {
  const f = fixture();
  try {
    await f.store.transact(id, (a) => a && ({ next: { ...a, state: 'LAUNCHED' }, result: true }));
    assert.equal(await launchServerAction(f.opts, id), 'SKIPPED');
    assert.equal(existsSync(f.paths.runLog), false);
    assert.equal(existsSync(f.paths.fence), false);
  } finally { f.cleanup(); }
});

test('failed systemd-run and absent unit: closed fence before START_FAILED', async () => {
  const f = fixture();
  try {
    f.env.FAKE_RUN_MODE = 'fail';
    assert.equal(await launchServerAction(f.opts, id), 'START_FAILED');
    assert.equal(readlinkSync(f.paths.fence), 'closed');
    assert.equal(await f.state(), 'START_FAILED');
    assert.deepEqual(f.receipts[0]?.recipients, ['leader', 'worker']);
    await reconcileServerActions(f.opts);
    assert.equal(f.receipts.length, 1);
  } finally { f.cleanup(); }
});

test('failed systemd-run with live unit: never START_FAILED, then ABANDONED', async () => {
  const f = fixture();
  try {
    f.env.FAKE_RUN_MODE = 'fail';
    f.unit(live);
    assert.equal(await launchServerAction(f.opts, id), 'DEFERRED');
    assert.equal(await f.state(), 'RESERVED');
    assert.equal(readlinkSync(f.paths.fence), 'closed');
    f.unit(gone);
    await reconcileServerAction(f.opts, id);
    assert.equal(await f.state(), 'ABANDONED');
  } finally { f.cleanup(); }
});

test('slow systemd-run is killed (30 s default, shortened in test) then fenced', async () => {
  const f = fixture();
  try {
    assert.equal(SERVER_ACTION_LAUNCH_TIMEOUT_MS, 30_000);
    f.env.FAKE_RUN_MODE = 'hang';
    assert.equal(await launchServerAction({ ...f.opts, launchTimeoutMs: 30 }, id), 'START_FAILED');
    assert.equal(readlinkSync(f.paths.fence), 'closed');
  } finally { f.cleanup(); }
});

test('frozen launcher after marking resumes after ABANDONED: late unit wrapper is inert', async () => {
  const f = fixture();
  try {
    const original = f.store.transact.bind(f.store);
    let entered!: () => void;
    let resume!: () => void;
    const marked = new Promise<void>((resolve) => { entered = resolve; });
    const held = new Promise<void>((resolve) => { resume = resolve; });
    let blocked = false;
    f.store.transact = async (key, mutate) => {
      const value = await original(key, mutate);
      const current = await f.store.read(key);
      if (!blocked && current?.launchStartedAt && current.state === 'RESERVED') {
        blocked = true; entered(); await held;
      }
      return value;
    };
    let minutes = 0;
    f.opts.now = () => new Date(stamp + minutes * 60_000);
    f.env.FAKE_RUN_MODE = 'wrapper';
    const launch = launchServerAction(f.opts, id);
    await marked;
    minutes = 3;
    await reconcileServerAction(f.opts, id);
    assert.equal(await f.state(), 'ABANDONED');
    resume();
    await launch; // systemd-run runs but wrapper finds closed and exits without a log.
    assert.equal(await f.state(), 'ABANDONED');
    assert.equal(existsSync(f.paths.record), false);
    assert.equal(existsSync(f.paths.log), false);
  } finally { f.cleanup(); }
});

test('timeout followed by a late systemd unit cannot run the wrapper', async () => {
  const f = fixture();
  try {
    f.env.FAKE_RUN_MODE = 'hang';
    assert.equal(await launchServerAction({ ...f.opts, launchTimeoutMs: 20 }, id), 'START_FAILED');
    const response = spawnSync('bash', [join(f.baseDir, 'current', 'deploy', 'run-action.sh'), 'deploy.commit', id, sha],
      { env: f.env, encoding: 'utf8' });
    assert.equal(response.status, 0);
    assert.equal(existsSync(f.paths.record), false);
  } finally { f.cleanup(); }
});

test('crash before launch, after systemd acceptance and during deploy have distinct recovery', async () => {
  for (const stage of ['before-run', 'accepted', 'during-deploy']) {
    const f = fixture();
    try {
      if (stage !== 'before-run') {
        await f.store.transact(id, (a) => a && ({
          next: { ...a, launchStartedAt: earlier(3), state: 'LAUNCHED' }, result: true,
        }));
        f.unit(live);
      }
      if (stage === 'during-deploy') { f.fence('run'); f.record('running'); }
      await reconcileServerAction(f.opts, id);
      assert.equal(await f.state(), stage === 'before-run' ? 'ABANDONED' : 'LAUNCHED');
      if (stage !== 'before-run') {
        f.unit(gone);
        if (stage === 'accepted') f.fence('run');
        await reconcileServerAction(f.opts, id);
        assert.equal(await f.state(), 'UNKNOWN');
      }
    } finally { f.cleanup(); }
  }
});

test('one late closed fence left by an earlier process becomes ABANDONED after restart', async () => {
  const f = fixture(0.1);
  try {
    f.fence('closed'); // Panter crashed after symlink() but before ledger write.
    const freshProcess = { ...f.opts, sourceRepo: join(f.baseDir, 'different-release-clone') };
    await Promise.all([reconcileServerAction(f.opts, id), reconcileServerAction(freshProcess, id)]);
    assert.equal(await f.state(), 'ABANDONED');
    assert.equal(f.receipts.length, 1);
    assert.equal(readlinkSync(f.paths.fence), 'closed');
  } finally { f.cleanup(); }
});

test('two reconcilers race on absent fence: only one creates closed', async () => {
  const f = fixture();
  try {
    await Promise.all([reconcileServerAction(f.opts, id), reconcileServerAction(f.opts, id)]);
    assert.equal(await f.state(), 'ABANDONED');
    assert.equal(readlinkSync(f.paths.fence), 'closed');
    assert.equal(f.receipts.length, 1);
  } finally { f.cleanup(); }
});

test('wrapper starts and completes between fence and record observations: final wins', async () => {
  const f = fixture();
  try {
    writeFileSync(f.paths.hook, [
      '#!/bin/sh', 'PANTER_BASE="' + f.baseDir + '" PATH="' + f.env.PATH + '" bash "' +
        join(f.baseDir, 'current', 'deploy', 'run-action.sh') + '" deploy.commit "' + id + '" "' + sha + '"',
    ].join('\n') + '\n');
    await reconcileServerAction(f.opts, id);
    assert.equal(await f.state(), 'LIVE');
    assert.equal(readlinkSync(f.paths.fence), 'run');
    assert.equal(f.receipts.length, 1);
  } finally { f.cleanup(); }
});

test('wrapper starts between two readings and remains live: no UNKNOWN or ABANDONED', async () => {
  const f = fixture();
  try {
    const done = join(f.baseDir, 'release.txt');
    writeFileSync(f.paths.deploy, '#!/bin/sh\nwhile [ ! -f "' + done + '" ]; do sleep 0.01; done\necho deployed\n');
    writeFileSync(f.paths.hook, [
      '#!/bin/sh',
      'PANTER_BASE="' + f.baseDir + '" PATH="' + f.env.PATH + '" bash "' +
        join(f.baseDir, 'current', 'deploy', 'run-action.sh') + '" deploy.commit "' + id + '" "' + sha + '" >/dev/null 2>&1 &',
      'while [ ! -f "' + f.paths.record + '" ]; do sleep 0.01; done',
      'printf "LoadState=loaded\\nActiveState=active\\n" > "' + f.paths.unitFile + '"',
    ].join('\n') + '\n');
    await reconcileServerAction(f.opts, id);
    assert.equal(await f.state(), 'RESERVED');
    assert.equal(readlinkSync(f.paths.fence), 'run');
    writeFileSync(done, 'go');
    for (let i = 0; i < 100 && !readFileSync(f.paths.record, 'utf8').includes('LIVE'); i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    f.unit(gone);
    await reconcileServerAction(f.opts, id);
    assert.equal(await f.state(), 'LIVE');
  } finally { f.cleanup(); }
});

test('restarted Panter on another release still reconciles shared etc/actions', async () => {
  const f = fixture();
  try {
    f.fence('run'); f.record('final'); writeFileSync(f.paths.log, 'log payload\n');
    const otherRelease = { ...f.opts, sourceRepo: join(f.baseDir, 'release-two') };
    await reconcileServerActions(otherRelease);
    assert.equal(await f.state(), 'LIVE');
    assert.match((await f.store.read(id))?.logSha256 ?? '', /^[a-f0-9]{64}$/);
    assert.equal(f.receipts[0]?.receiptId, id);
  } finally { f.cleanup(); }
});

test('receipts retry failures and are sent once after success', async () => {
  const f = fixture();
  try {
    f.fence('run'); f.record('final');
    let calls = 0;
    f.opts.notify = () => {
      calls++;
      if (calls === 1) throw new Error('temporary inbox failure');
    };
    await assert.rejects(reconcileServerAction(f.opts, id), /temporary inbox failure/);
    assert.equal(await f.state(), 'LIVE');
    await reconcileServerActions(f.opts);
    await reconcileServerActions(f.opts);
    assert.equal(calls, 2);
    assert.equal(typeof (await f.store.read(id))?.receiptSentAt, 'string');
  } finally { f.cleanup(); }
});

test('a receipt that cannot be delivered does not keep other actions from being settled', async () => {
  const f = fixture();
  const other = '00000000-0000-4000-8000-000000000002';
  try {
    f.fence('run'); f.record('final');
    await f.store.transact(other, () => ({ next: {
      actionId: other, sha, state: 'RESERVED', reservedAt: earlier(3) }, result: true }));
    symlinkSync('closed', join(f.baseDir, 'etc', 'actions', other + '.fence'));
    const delivered: string[] = [];
    f.opts.notify = (receipt) => {
      if (receipt.actionId === id) throw new Error('inbox rejects this receipt');
      delivered.push(receipt.actionId + ':' + receipt.state);
    };
    for (let pass = 0; pass < 2; pass++) {
      await assert.rejects(reconcileServerActions(f.opts), /inbox rejects this receipt/);
      assert.equal(await f.state(), 'LIVE');
      assert.equal((await f.store.read(other))?.state, 'ABANDONED', 'the later action is settled anyway');
      assert.equal((await f.store.read(id))?.receiptSentAt, undefined, 'the failed receipt stays pending');
    }
    assert.deepEqual(delivered, [other + ':ABANDONED'], 'and its own receipt is sent exactly once');
  } finally { f.cleanup(); }
});

test('a wake during a pass that already listed the actions triggers another pass', async () => {
  const f = fixture();
  let lists = 0;
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let reached!: () => void;
  const waiting = new Promise<void>((resolve) => { reached = resolve; });
  const store = new (class extends MemoryServerActionStore {
    override async list(): Promise<ServerAction[]> {
      const snapshot = await super.list();
      if (++lists === 3) { reached(); await held; } // the pass's last look, taken before the insert
      return snapshot;
    }
  })();
  const worker = startServerActionReconciler({ ...f.opts, store });
  try {
    const first = worker.start();
    await waiting;
    await store.transact(id, () => ({ next: {
      actionId: id, sha, state: 'RESERVED', reservedAt: earlier(3) }, result: true }));
    const woken = worker.wake();
    release();
    await Promise.all([first, woken]);
    assert.equal((await store.read(id))?.state, 'ABANDONED');
    assert.equal(f.receipts.length, 1);
  } finally { worker.stop(); f.cleanup(); }
});

test('action ids are lowercase only, as in the wrapper', async () => {
  const f = fixture();
  try {
    const upper = id.replace('0000-4000', 'ABCD-4000');
    await assert.rejects(launchServerAction(f.opts, upper), /INVALID_RUNNER_CONFIGURATION/);
    await assert.rejects(reconcileServerAction(f.opts, upper), /INVALID_ACTION_ID/);
    await assert.rejects(serverActionLogTail(f.baseDir, upper), /INVALID_ACTION_ID/);
  } finally { f.cleanup(); }
});

test('last 50 log lines redact bearer, token keys and provider signatures', async () => {
  const f = fixture();
  try {
    const lines = Array.from({ length: 60 }, (_, i) => 'normal line ' + i);
    lines[59] = 'Authorization: Bearer top-secret-123 token=hidden123 github_pat_12345678901234567890';
    lines[58] = 'Authorization: Basic base64-secret PANTER_OPERATOR_TOKEN=very-hidden';
    writeFileSync(f.paths.log, lines.join('\n'));
    const output = await serverActionLogTail(f.baseDir, id);
    assert.equal(output.split('\n').length, 50);
    assert.doesNotMatch(output, /top-secret|hidden123|github_pat|base64-secret|very-hidden/);
    assert.match(output, /\[REDACTED\]/);
    await assert.rejects(serverActionLogTail(f.baseDir, '../other'), /INVALID_ACTION_ID/);
    writeFileSync(f.paths.log, [
      '{"access_token":"private-value-123","password":"private-password-456","note":"kept"}',
      "{'client_secret': 'quoted-secret-789', \"GITHUB_TOKEN\": \"env-style-012\"}",
      'refreshToken="camel-345" api-key: "dashed-678" tokens: 5',
    ].join('\n'));
    const json = await serverActionLogTail(f.baseDir, id);
    assert.doesNotMatch(json, /private-value|private-password|quoted-secret|env-style|camel-345|dashed-678/);
    assert.match(json, /"access_token":"\[REDACTED\]","password":"\[REDACTED\]","note":"kept"/);
    assert.match(json, /tokens: 5/, 'ordinary words are left alone');
  } finally { f.cleanup(); }
});


test('launchStartedAt takes precedence over an old reservation during 2-minute grace', async () => {
  const f = fixture(5);
  try {
    await f.store.transact(id, (a) => a && ({
      next: { ...a, launchStartedAt: earlier(1) }, result: true,
    }));
    await reconcileServerAction(f.opts, id);
    assert.equal(await f.state(), 'RESERVED');
    assert.equal(existsSync(f.paths.fence), false);
    f.opts.now = () => new Date(stamp + 2 * 60_000);
    await reconcileServerAction(f.opts, id);
    assert.equal(await f.state(), 'ABANDONED');
  } finally { f.cleanup(); }
});

test('indeterminate systemd state fails closed without changing the ledger', async () => {
  const f = fixture();
  try {
    f.unit('LoadState=loaded\nActiveState=unknown\n');
    await assert.rejects(reconcileServerAction(f.opts, id), /INDETERMINATE_SYSTEMD_STATE/);
    assert.equal(await f.state(), 'RESERVED');
    assert.equal(existsSync(f.paths.fence), false);
  } finally { f.cleanup(); }
});

test('inconsistent LIVE record is not accepted as proof of deployment', async () => {
  const f = fixture();
  try {
    f.fence('run');
    writeFileSync(f.paths.record, JSON.stringify({
      actionId: id, sha, at: new Date(stamp).toISOString(),
      state: 'LIVE', exitCode: 0, revision: 'b'.repeat(40),
    }));
    await reconcileServerAction(f.opts, id);
    assert.equal(await f.state(), 'UNKNOWN');
  } finally { f.cleanup(); }
});

test('startup reconciliation runs immediately; wake reevaluates the two-minute deadline', async () => {
  const f = fixture(1);
  const worker = startServerActionReconciler(f.opts);
  try {
    await worker.start();
    assert.equal(await f.state(), 'RESERVED');
    f.opts.now = () => new Date(stamp + 2 * 60_000);
    await worker.wake();
    assert.equal(await f.state(), 'ABANDONED');
  } finally { worker.stop(); f.cleanup(); }
});
