import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdtempSync, openSync, mkdirSync, writeFileSync, chmodSync, readFileSync, readlinkSync, readdirSync, symlinkSync, lstatSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const wrapper = fileURLToPath(new URL('../deploy/run-action.sh', import.meta.url));
const id = '00000000-0000-4000-8000-000000000001';
const sha = 'a'.repeat(40);

const answer = (revision: string) =>
  '#!/bin/sh\nprintf \'%s\\n\' \'{"status":"ok","revision":"' + revision + '"}\'\n';
const marker = '#!/bin/sh\ntouch "$PANTER_BASE/deployed"\n';

function fixture(body = '#!/bin/sh\necho deployed\n', health = sha, o: { curl?: string; dir?: string; actions?: boolean; sleep?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'panter-action-wrapper-'));
  const base = o.dir ? join(root, o.dir) : root;
  const actions = join(base, 'etc', 'actions');
  const scripts = join(base, 'current', 'deploy');
  const bin = join(base, 'bin');
  if (o.actions !== false) mkdirSync(actions, { recursive: true });
  mkdirSync(scripts, { recursive: true });
  mkdirSync(bin);
  const fake = join(scripts, 'deploy.sh');
  writeFileSync(fake, body);
  chmodSync(fake, 0o700);
  const curl = join(bin, 'curl');
  writeFileSync(curl, o.curl ?? answer(health));
  chmodSync(curl, 0o700);
  // The wrapper waits between health probes; tests do not.
  const sleep = join(bin, 'sleep');
  writeFileSync(sleep, o.sleep ?? '#!/bin/sh\necho x >> "$PANTER_BASE/slept"\n');
  chmodSync(sleep, 0o700);
  return {
    base, actions,
    run: (args: string[] = ['deploy.commit', id, sha], stderr: 'pipe' | number = 'pipe') => spawnSync('bash', [wrapper, ...args], {
      encoding: 'utf8', env: { ...process.env, PANTER_BASE: base, PATH: bin + ':' + process.env.PATH },
      stdio: ['ignore', 'pipe', stderr],
    }),
    record: () => JSON.parse(readFileSync(join(actions, id + '.json'), 'utf8')) as Record<string, unknown>,
    deployed: () => existsSync(join(base, 'deployed')),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test('wrapper shell syntax and invalid inputs perform no writes', () => {
  assert.equal(spawnSync('bash', ['-n', wrapper]).status, 0);
  const f = fixture();
  try {
    for (const args of [
      [], ['deploy.commit', 'bad', sha], ['other', id, sha],
      ['deploy.commit', id, 'f'.repeat(39)], ['deploy.commit', id, 'Z'.repeat(40)],
      ['deploy.commit', id, sha, 'extra'],
      ['deploy.commit', id.replace('0000-4000', 'ABCD-4000'), sha],
      ['deploy.commit', id + '\n', sha], ['deploy.commit', id, sha + '\n'],
      ['deploy.commit', '../' + id, sha], ['deploy.commit', id + '/x', sha],
    ]) assert.equal(f.run(args).status, 2, JSON.stringify(args));
    assert.deepEqual(readdirSync(f.actions), []);
  } finally { f.cleanup(); }
});

test('wrapper takes one dangling run fence, records LIVE and is single-use', () => {
  const f = fixture();
  try {
    assert.equal(f.run().status, 0);
    const fence = join(f.actions, id + '.fence');
    assert.equal(lstatSync(fence).isSymbolicLink(), true);
    assert.equal(readlinkSync(fence), 'run');
    const record = f.record();
    assert.equal(record.state, 'LIVE');
    assert.equal(record.revision, sha);
    assert.equal(record.exitCode, 0);
    assert.equal(record.actionId, id);
    assert.equal(record.sha, sha);
    assert.match(readFileSync(join(f.actions, id + '.log'), 'utf8'), /deployed/);
    assert.equal(f.run().status, 0);
    assert.equal(f.record().at, record.at);
  } finally { f.cleanup(); }
});

test('closed and odd fences stop wrapper before records or deploy', () => {
  for (const target of ['closed', 'other']) {
    const f = fixture();
    try {
      symlinkSync(target, join(f.actions, id + '.fence'));
      assert.equal(f.run().status, 0);
      assert.deepEqual(readdirSync(f.actions), [id + '.fence']);
    } finally { f.cleanup(); }
  }
});

test('every existing fence path stops wrapper before records or deploy', () => {
  for (const kind of ['directory', 'directory-link', 'file'] as const) {
    const f = fixture(marker);
    try {
      const fence = join(f.actions, id + '.fence');
      if (kind === 'directory') {
        mkdirSync(fence);
      } else if (kind === 'directory-link') {
        const target = join(f.base, 'fence-target');
        mkdirSync(target);
        symlinkSync(target, fence);
      } else {
        writeFileSync(fence, 'occupied');
      }

      assert.equal(f.run().status, 0, kind);
      assert.equal(existsSync(join(f.actions, id + '.json')), false, kind);
      assert.equal(existsSync(join(f.actions, id + '.log')), false, kind);
      assert.equal(f.deployed(), false, kind);
    } finally { f.cleanup(); }
  }
  // Control: the same deploy script does leave its marker when the fence is free.
  const free = fixture(marker);
  try { assert.equal(free.run().status, 0); assert.equal(free.deployed(), true); }
  finally { free.cleanup(); }
});

test('a fence that cannot be created for another reason fails without deploying', () => {
  const f = fixture(marker, sha, { actions: false });
  try {
    const result = f.run();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /cannot create fence/);
    assert.equal(f.deployed(), false);
    assert.equal(existsSync(f.actions), false, 'the wrapper never provisions etc/actions');
  } finally { f.cleanup(); }
});

test('record and log are private, and RUNNING is on disk while the deploy runs', () => {
  const f = fixture('#!/bin/sh\ncat "$PANTER_BASE/etc/actions/' + id + '.json"\n');
  try {
    assert.equal(f.run().status, 0);
    const during = JSON.parse(readFileSync(join(f.actions, id + '.log'), 'utf8')) as Record<string, unknown>;
    assert.equal(during.state, 'RUNNING');
    assert.equal(during.exitCode, null);
    assert.equal(during.revision, null);
    assert.equal(f.record().state, 'LIVE');
    for (const name of [id + '.json', id + '.log'])
      assert.equal(lstatSync(join(f.actions, name)).mode & 0o777, 0o600, name);
    assert.deepEqual(readdirSync(f.actions).sort(), [id + '.fence', id + '.json', id + '.log']);
  } finally { f.cleanup(); }
});

test('a base directory with spaces and glob characters is used literally', () => {
  const f = fixture(marker, sha, { dir: 'pan ter *[a-z]? $HOME' });
  try {
    assert.equal(f.run().status, 0);
    assert.equal(f.record().state, 'LIVE');
    assert.equal(f.deployed(), true);
    assert.equal(readlinkSync(join(f.actions, id + '.fence')), 'run');
  } finally { f.cleanup(); }
});

test('a health probe that fails at first does not turn a healthy deploy into FAILED', () => {
  const flaky = '#!/bin/sh\nn=$(cat "$PANTER_BASE/probes" 2>/dev/null || echo 0)\nn=$((n+1))\n' +
    'echo "$n" > "$PANTER_BASE/probes"\n[ "$n" -le 2 ] && exit 7\n' + answer(sha).split('\n').slice(1).join('\n');
  const f = fixture(undefined, sha, { curl: flaky });
  try {
    assert.equal(f.run().status, 0);
    assert.equal(f.record().state, 'LIVE');
    assert.equal(f.record().revision, sha);
    assert.equal(readFileSync(join(f.base, 'probes'), 'utf8').trim(), '3');
  } finally { f.cleanup(); }
});

test('unreachable /health after a zero exit fails closed after a bounded number of probes', () => {
  const f = fixture(undefined, sha, { curl: '#!/bin/sh\necho x >> "$PANTER_BASE/probes"\nexit 7\n' });
  try {
    assert.equal(f.run().status, 0);
    assert.equal(f.record().state, 'FAILED');
    assert.equal(f.record().revision, null);
    assert.equal(readFileSync(join(f.base, 'probes'), 'utf8').trim().split('\n').length, 5);
  } finally { f.cleanup(); }
});

test('a failed deploy is probed once: no waiting on a commit that is not coming', () => {
  const f = fixture('#!/bin/sh\necho "deploy: build or tests failed"\nexit 1\n', 'b'.repeat(40));
  try {
    assert.equal(f.run().status, 1);
    assert.equal(f.record().state, 'BUILD_FAILED');
    assert.equal(f.record().revision, 'b'.repeat(40));
    assert.equal(existsSync(join(f.base, 'slept')), false);
  } finally { f.cleanup(); }
});

test('wrapper maps lock, build, healthy rollback and unknown failure', () => {
  const cases: Array<[string, number, string]> = [
    ['deploy: another deploy is running', 2, 'LOCKED'],
    ['deploy: build or tests failed', 1, 'BUILD_FAILED'],
    ['deploy: rolled back to bbbbbbb, which is healthy', 1, 'ROLLED_BACK'],
    ['deploy: ROLLBACK FAILED', 1, 'FAILED'],
    ['unexpected error', 1, 'FAILED'],
  ];
  for (const [message, exit, state] of cases) {
    const f = fixture('#!/bin/sh\necho "' + message + '"\nexit ' + exit + '\n');
    try {
      assert.equal(f.run().status, exit);
      assert.equal(f.record().state, state);
      assert.equal(f.record().exitCode, exit);
    } finally { f.cleanup(); }
  }
});

test('a final record that cannot be written never replaces the exit status of deploy.sh', () => {
  // The actions directory goes away during the deploy: not even a temporary file can be created.
  const gone = fixture('#!/bin/sh\nmv "$PANTER_BASE/etc/actions" "$PANTER_BASE/etc/moved"\nexit 0\n');
  try {
    const result = gone.run();
    assert.equal(result.status, 0);
    assert.match(result.stderr, /could not persist the final record/);
    assert.equal(existsSync(gone.actions), false);
    const last = JSON.parse(readFileSync(join(gone.base, 'etc', 'moved', id + '.json'), 'utf8')) as Record<string, unknown>;
    assert.equal(last.state, 'RUNNING');
  } finally { gone.cleanup(); }
  // The record path stops being replaceable: the rename fails after the temporary file exists.
  const blocked = fixture('#!/bin/sh\nrm "$PANTER_BASE/etc/actions/' + id + '.json"\n' +
    'mkdir "$PANTER_BASE/etc/actions/' + id + '.json"\necho "deploy: another deploy is running"\nexit 2\n');
  try {
    const result = blocked.run();
    assert.equal(result.status, 2);
    assert.match(result.stderr, /could not persist the final record \(LOCKED\)/);
    assert.equal(lstatSync(join(blocked.actions, id + '.json')).isDirectory(), true);
    assert.deepEqual(readdirSync(blocked.actions).sort(), [id + '.fence', id + '.json', id + '.log'],
      'no temporary file is left behind');
  } finally { blocked.cleanup(); }
});

test('nothing after the deploy can replace its exit status: not a full stderr, not a broken sleep', () => {
  // The final record cannot be written and neither can the diagnostic about it.
  const mute = fixture('#!/bin/sh\nmv "$PANTER_BASE/etc/actions" "$PANTER_BASE/etc/moved"\n' +
    'echo "deploy: another deploy is running"\nexit 2\n');
  const full = openSync('/dev/full', 'w');
  try {
    assert.equal(mute.run(undefined, full).status, 2);
    const last = JSON.parse(readFileSync(join(mute.base, 'etc', 'moved', id + '.json'), 'utf8')) as Record<string, unknown>;
    assert.equal(last.state, 'RUNNING');
  } finally { closeSync(full); mute.cleanup(); }
  // Waiting between probes fails: the probes still happen and the record is still written.
  const flaky = '#!/bin/sh\nn=$(cat "$PANTER_BASE/probes" 2>/dev/null || echo 0)\nn=$((n+1))\n' +
    'echo "$n" > "$PANTER_BASE/probes"\n[ "$n" -le 2 ] && exit 7\n' + answer(sha).split('\n').slice(1).join('\n');
  const restless = fixture(undefined, sha, { curl: flaky, sleep: '#!/bin/sh\nexit 1\n' });
  try {
    assert.equal(restless.run().status, 0);
    assert.equal(restless.record().state, 'LIVE');
    assert.equal(restless.record().exitCode, 0);
  } finally { restless.cleanup(); }
  // A deploy that failed keeps its own status even when everything afterwards works.
  const failed = fixture('#!/bin/sh\nexit 37\n', 'b'.repeat(40));
  try {
    assert.equal(failed.run().status, 37);
    assert.equal(failed.record().exitCode, 37);
    assert.equal(failed.record().state, 'FAILED');
  } finally { failed.cleanup(); }
});

test('success exit but unexpected /health revision must fail closed', () => {
  const f = fixture('#!/bin/sh\nexit 0\n', 'b'.repeat(40));
  try {
    assert.equal(f.run().status, 0);
    assert.equal(f.record().state, 'FAILED');
    assert.equal(f.record().revision, 'b'.repeat(40));
  } finally { f.cleanup(); }
});
