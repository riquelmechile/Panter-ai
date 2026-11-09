import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, readlinkSync, readdirSync, symlinkSync, lstatSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const wrapper = fileURLToPath(new URL('../deploy/run-action.sh', import.meta.url));
const id = '00000000-0000-4000-8000-000000000001';
const sha = 'a'.repeat(40);

function fixture(body = '#!/bin/sh\necho deployed\n', health = sha) {
  const base = mkdtempSync(join(tmpdir(), 'panter-action-wrapper-'));
  const actions = join(base, 'etc', 'actions');
  const scripts = join(base, 'current', 'deploy');
  const bin = join(base, 'bin');
  mkdirSync(actions, { recursive: true });
  mkdirSync(scripts, { recursive: true });
  mkdirSync(bin);
  const fake = join(scripts, 'deploy.sh');
  writeFileSync(fake, body);
  chmodSync(fake, 0o700);
  const curl = join(bin, 'curl');
  writeFileSync(curl, '#!/bin/sh\nprintf \'%s\\n\' \'{"status":"ok","revision":"' + health + '"}\'\n');
  chmodSync(curl, 0o700);
  return {
    base, actions,
    run: (args: string[] = ['deploy.commit', id, sha]) => spawnSync('bash', [wrapper, ...args], {
      encoding: 'utf8', env: { ...process.env, PANTER_BASE: base, PATH: bin + ':' + process.env.PATH },
    }),
    record: () => JSON.parse(readFileSync(join(actions, id + '.json'), 'utf8')) as Record<string, unknown>,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
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
    ]) assert.equal(f.run(args).status, 2);
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

test('success exit but unexpected /health revision must fail closed', () => {
  const f = fixture('#!/bin/sh\nexit 0\n', 'b'.repeat(40));
  try {
    assert.equal(f.run().status, 0);
    assert.equal(f.record().state, 'FAILED');
    assert.equal(f.record().revision, 'b'.repeat(40));
  } finally { f.cleanup(); }
});
