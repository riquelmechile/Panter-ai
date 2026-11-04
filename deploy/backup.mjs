#!/usr/bin/env node
// Online backup of a Panter installation: the SQLite ledger (consistent copy while the service runs), the
// environment and the legacy JSON state, with a restore check of the copy. Used before every deploy
// (deploy/deploy.sh) and daily (deploy/systemd/panter-backup.timer).
//
//   node deploy/backup.mjs --base ~/panter-ai --label pre-abc1234-202611041200 [--release <sha>]
//   node deploy/backup.mjs --base ~/panter-ai --daily [--keep-daily 14]
//
// Never overwrites a backup; prunes only daily-* backups beyond --keep-daily, never deploy backups.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import { createHash } from 'node:crypto';

const args = process.argv.slice(2);
const opt = name => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const flag = name => args.includes(`--${name}`);
let created = null;
// A failed backup leaves nothing behind (so a daily retry is never mistaken for a finished backup).
const fail = message => { console.error(`backup: ${message}`); process.exit(1); };
process.on('exit', code => { if (code !== 0 && created) fs.rmSync(created, { recursive: true, force: true }); });

const base = path.resolve(opt('base') ?? fail('--base required'));
const daily = flag('daily');
const label = daily ? `daily-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}` : opt('label') ?? fail('--label or --daily required');
if (!/^[a-z0-9][a-z0-9.-]{0,80}$/.test(label)) fail('invalid label');
const keepDaily = Number(opt('keep-daily') ?? '14');
if (!Number.isInteger(keepDaily) || keepDaily < 1 || keepDaily > 365) fail('invalid --keep-daily');
const release = opt('release');
if (release !== undefined && !/^[0-9a-f]{40}$/.test(release)) fail('invalid --release');

const data = path.join(base, 'data');
const backupRoot = path.join(base, 'backups');
const destination = path.join(backupRoot, label);
if (fs.existsSync(destination)) {
  // A finished daily backup taken today is fine; an unfinished one is redone; any other backup is never overwritten.
  if (daily && fs.existsSync(path.join(destination, 'manifest.json'))) { console.log(JSON.stringify({ backupPath: destination, skipped: 'already taken today' })); process.exit(0); }
  if (daily) fs.rmSync(destination, { recursive: true, force: true });
  else fail('backup path already exists: refuse overwrite');
}
fs.mkdirSync(backupRoot, { recursive: true, mode: 0o700 }); fs.chmodSync(backupRoot, 0o700);
fs.mkdirSync(destination, { mode: 0o700 }); created = destination;

const input = new DatabaseSync(path.join(data, 'panter.sqlite'), { readOnly: true });
const rows = input.prepare('SELECT name,payload,revision FROM ledger ORDER BY name').all();
const fingerprint = rows.map(r => ({ name: r.name, sha256: createHash('sha256').update(r.payload).digest('hex'), revision: r.revision }));
const oauth = JSON.parse(rows.find(r => r.name === 'oauth')?.payload ?? 'null');
if (!oauth || !Array.isArray(oauth.clients) || !Array.isArray(oauth.grants) || !Array.isArray(oauth.tokens)) fail('OAuth ledger structure missing');
const copy = path.join(destination, 'panter.sqlite');
await backup(input, copy); input.close(); fs.chmodSync(copy, 0o600);

// Restore check: open a copy of the backup elsewhere, as a restore would, and compare every ledger row.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'panter-restore-check-'));
try {
  const restoredPath = path.join(scratch, 'panter.sqlite');
  fs.copyFileSync(copy, restoredPath);
  const restored = new DatabaseSync(restoredPath, { readOnly: true });
  const integrity = restored.prepare('PRAGMA integrity_check').get();
  if (integrity.integrity_check !== 'ok') fail('backup failed the integrity check');
  const back = restored.prepare('SELECT name,payload,revision FROM ledger ORDER BY name').all();
  restored.close();
  if (back.length !== rows.length || rows.some((r, i) => back[i]?.name !== r.name || back[i]?.payload !== r.payload || back[i]?.revision !== r.revision))
    fail('restored copy differs from the live ledger');
} finally { fs.rmSync(scratch, { recursive: true, force: true }); }

// The environment is required; legacy JSON state (pre-SQLite) is copied when present.
const files = [['etc/panter.env', 'panter.env', true], ['etc/operator.token', 'operator.token', false],
  ['data/oauth.json', 'oauth.json', false], ['data/harness.json', 'harness.json', false],
  ['data/native-reviews.json', 'native-reviews.json', false], ['data/panter-rdd.json', 'panter-rdd.json', false]];
const copied = [], missing = [];
for (const [from, to, required] of files) {
  const abs = path.join(base, from);
  if (!fs.existsSync(abs)) { if (required) fail(`required file absent: ${from}`); missing.push(from); continue; }
  const stat = fs.lstatSync(abs);
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`unsafe source path: ${from}`);
  fs.copyFileSync(abs, path.join(destination, to)); fs.chmodSync(path.join(destination, to), 0o600); copied.push(to);
}
let currentRelease = null;
try { currentRelease = fs.readlinkSync(path.join(base, 'current')); } catch { /* fresh install */ }
const manifest = { createdAt: new Date().toISOString(), label, releaseToBeInstalled: release ?? null, currentRelease,
  ledgerFingerprint: fingerprint, oauthCounts: { clients: oauth.clients.length, grants: oauth.grants.length, tokens: oauth.tokens.length },
  copied, missing, restoreCheck: 'ok' };
fs.writeFileSync(path.join(destination, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
created = null; // finished: keep it

const pruned = [];
if (daily) {
  const dailies = fs.readdirSync(backupRoot).filter(n => /^daily-\d{8}$/.test(n)).sort().reverse();
  for (const old of dailies.slice(keepDaily)) { fs.rmSync(path.join(backupRoot, old), { recursive: true, force: true }); pruned.push(old); }
}
console.log(JSON.stringify({ backupPath: destination, dbIntegrity: 'ok', restoreCheck: 'ok', ledgers: fingerprint.map(x => x.name),
  oauthCounts: manifest.oauthCounts, copied, missing, currentRelease, pruned }));
