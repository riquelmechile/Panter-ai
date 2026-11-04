import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const run = promisify(execFile);
const script = new URL('../deploy/backup.mjs', import.meta.url).pathname;

async function install(withEnv = true) {
  const base = await mkdtemp(join(tmpdir(), 'panter-backup-'));
  await mkdir(join(base, 'data'), { recursive: true }); await mkdir(join(base, 'etc'), { recursive: true });
  const db = new DatabaseSync(join(base, 'data', 'panter.sqlite'));
  db.exec('CREATE TABLE ledger (name TEXT PRIMARY KEY, payload TEXT NOT NULL, revision INTEGER NOT NULL)');
  db.prepare('INSERT INTO ledger VALUES (?,?,?)').run('oauth', JSON.stringify({ clients: [1], grants: [], tokens: [1, 2] }), 3);
  db.prepare('INSERT INTO ledger VALUES (?,?,?)').run('harness', JSON.stringify({ version: 1, runs: [] }), 7);
  db.close();
  if (withEnv) await writeFile(join(base, 'etc', 'panter.env'), 'PANTER_PORT=18080\n');
  return base;
}
const backup = (base: string, ...args: string[]) => run(process.execPath, [script, '--base', base, ...args]);

test('a labelled backup copies the ledger and env, passes its restore check and is never overwritten', async () => {
  const base = await install();
  try {
    const sha = 'a'.repeat(40);
    const { stdout } = await backup(base, '--label', 'pre-aaaaaaa-1', '--release', sha);
    const out = JSON.parse(stdout);
    assert.equal(out.restoreCheck, 'ok');
    assert.deepEqual(out.oauthCounts, { clients: 1, grants: 0, tokens: 2 });
    const dir = join(base, 'backups', 'pre-aaaaaaa-1');
    const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
    assert.equal(manifest.releaseToBeInstalled, sha);
    assert.ok(manifest.copied.includes('panter.env'));
    assert.equal((await stat(join(dir, 'panter.sqlite'))).mode & 0o777, 0o600);
    const copy = new DatabaseSync(join(dir, 'panter.sqlite'), { readOnly: true });
    assert.equal((copy.prepare('SELECT revision FROM ledger WHERE name=?').get('harness') as any).revision, 7);
    copy.close();
    await assert.rejects(backup(base, '--label', 'pre-aaaaaaa-1'), /refuse overwrite/);
  } finally { await rm(base, { recursive: true, force: true }); }
});

test('a failed backup leaves nothing behind', async () => {
  const base = await install(false);
  try {
    await assert.rejects(backup(base, '--label', 'pre-x'), /required file absent: etc\/panter.env/);
    assert.equal(existsSync(join(base, 'backups', 'pre-x')), false);
  } finally { await rm(base, { recursive: true, force: true }); }
});

test('daily backups run once a day, redo an unfinished one and keep only the newest N dailies', async () => {
  const base = await install();
  try {
    for (const d of ['daily-20260101', 'daily-20260102', 'daily-20260103']) await mkdir(join(base, 'backups', d), { recursive: true });
    await mkdir(join(base, 'backups', 'pre-keepme-1'), { recursive: true });
    const first = JSON.parse((await backup(base, '--daily', '--keep-daily', '2')).stdout);
    const today = `daily-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}`;
    assert.ok(first.backupPath.endsWith(today));
    const names = (await readdir(join(base, 'backups'))).sort();
    assert.deepEqual(names, ['daily-20260103', 'pre-keepme-1', today].sort(), 'old dailies pruned, deploy backups kept');
    const again = JSON.parse((await backup(base, '--daily')).stdout);
    assert.equal(again.skipped, 'already taken today');
    // An unfinished daily (no manifest) is redone, not mistaken for a finished one.
    await rm(join(base, 'backups', today, 'manifest.json'));
    const redone = JSON.parse((await backup(base, '--daily')).stdout);
    assert.equal(redone.restoreCheck, 'ok');
  } finally { await rm(base, { recursive: true, force: true }); }
});
