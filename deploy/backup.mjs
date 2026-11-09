#!/usr/bin/env node
// Online backup of a Panter installation: the SQLite ledger (consistent copy while the service runs), the
// environment and the legacy JSON state, with a restore check of the copy. Used before every deploy
// (deploy/deploy.sh) and daily (deploy/systemd/panter-backup.timer).
//
//   node deploy/backup.mjs --base ~/panter-ai --label pre-abc1234-202611041200 [--release <sha>] [--stopped]
//   node deploy/backup.mjs --base ~/panter-ai --daily [--keep-daily 14] [--stopped]
//
// The SQLite copy is consistent at any time; the JSON stores (native reviews, Panter-RDD) are only consistent with each
// other and with the ledger while the service is stopped. --stopped records that the caller stopped it (deploy.sh and
// daily-backup.sh do); without it the manifest marks the backup as taken online.
//
// Never overwrites a backup; prunes only daily-* backups beyond --keep-daily, never deploy backups.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import { createHash } from 'node:crypto';

const args = process.argv.slice(2);
const opt = name => { const i = args.indexOf(`--${name}`); const v = i >= 0 ? args[i + 1] : undefined;
  if (i >= 0 && (v === undefined || v.startsWith('--'))) { console.error(`backup: --${name} needs a value`); process.exit(1); }
  return v; };
const flag = name => args.includes(`--${name}`);
let created = null, scratch = null;
// A failed backup leaves nothing behind (so a daily retry is never mistaken for a finished backup).
const fail = message => { console.error(`backup: ${message}`); process.exit(1); };
process.on('exit', code => {
  // The restore-check copy (a full ledger, OAuth tokens included) never outlives the run.
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
  if (code !== 0 && created) fs.rmSync(created, { recursive: true, force: true });
});
// Interrupted (a timeout, Ctrl-C): clean up the same way.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => process.exit(1));

const base = path.resolve(opt('base') ?? fail('--base required'));
const daily = flag('daily');
const label = daily ? `daily-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}` : opt('label') ?? fail('--label or --daily required');
if (!/^[a-z0-9][a-z0-9.-]{0,80}$/.test(label)) fail('invalid label');
const keepDaily = Number(opt('keep-daily') ?? '14');
if (!Number.isInteger(keepDaily) || keepDaily < 1 || keepDaily > 365) fail('invalid --keep-daily');
const release = opt('release');
const stopped = flag('stopped');
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
const copy = path.join(destination, 'panter.sqlite');
// rate -1: one step, one read snapshot (with the default batches a busy writer can keep restarting the copy).
await backup(input, copy, { rate: -1 }); input.close(); fs.chmodSync(copy, 0o600);
// Everything below is read from the copy itself, so writes to the live ledger meanwhile cannot make it fail.
const readLedger = file => { const db = new DatabaseSync(file, { readOnly: true });
  try { const integrity = db.prepare('PRAGMA integrity_check').get().integrity_check;
    // The server-actions authority keeps its unique action slot in a table of this same file (not a ledger row).
    const slots = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='server_action_slots'").get()
      ? db.prepare('SELECT action_id,active FROM server_action_slots ORDER BY action_id').all() : null;
    return { integrity, rows: db.prepare('SELECT name,payload,revision FROM ledger ORDER BY name').all(), slots }; } finally { db.close(); } };
const taken = readLedger(copy);
if (taken.integrity !== 'ok') fail('backup failed the integrity check');
const rows = taken.rows;
const fingerprint = rows.map(r => ({ name: r.name, sha256: createHash('sha256').update(r.payload).digest('hex'), revision: r.revision }));
const oauthRow = rows.find(r => r.name === 'oauth');
const oauth = oauthRow ? JSON.parse(oauthRow.payload) : null;
if (oauthRow && (!Array.isArray(oauth?.clients) || !Array.isArray(oauth?.grants) || !Array.isArray(oauth?.tokens))) fail('OAuth ledger is malformed');

// Restore check: open a copy of the backup elsewhere, as a restore would, and compare every ledger row with the backup.
// Inside the 0700 backups directory, never in a shared /tmp.
scratch = fs.mkdtempSync(path.join(backupRoot, '.restore-check-'));
const restoredPath = path.join(scratch, 'panter.sqlite');
fs.copyFileSync(copy, restoredPath);
const restored = readLedger(restoredPath);
if (restored.integrity !== 'ok') fail('restored copy failed the integrity check');
if (restored.rows.length !== rows.length || rows.some((r, i) => restored.rows[i]?.name !== r.name || restored.rows[i]?.payload !== r.payload || restored.rows[i]?.revision !== r.revision))
  fail('restored copy differs from the backup');
if (JSON.stringify(restored.slots) !== JSON.stringify(taken.slots)) fail('restored copy differs from the backup (server action slots)');
const serverActionSlots = taken.slots ? { total: taken.slots.length, active: taken.slots.filter(s => s.active === 1).length } : null;
fs.rmSync(scratch, { recursive: true, force: true }); scratch = null;

// The environment is required; every JSON store in data/ (native reviews and Panter-RDD still live there, plus the
// pre-SQLite copies) is copied too, so a restore puts back a consistent set.
const files = [['etc/panter.env', 'panter.env', true], ['etc/operator.token', 'operator.token', false],
  ...fs.readdirSync(data).filter(n => /^[a-z0-9_-]+\.json$/.test(n)).sort().map(n => [`data/${n}`, n, false])];
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
  ledgerFingerprint: fingerprint, oauthCounts: oauth ? { clients: oauth.clients.length, grants: oauth.grants.length, tokens: oauth.tokens.length } : null,
  serverActionSlots, copied, missing, restoreCheck: 'ok', consistency: stopped ? 'service stopped' : 'online: JSON stores may be mid-update' };
fs.writeFileSync(path.join(destination, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
created = null; // finished: keep it

const pruned = [];
if (daily) {
  const dailies = fs.readdirSync(backupRoot).filter(n => /^daily-\d{8}$/.test(n)).sort().reverse();
  for (const old of dailies.slice(keepDaily)) { fs.rmSync(path.join(backupRoot, old), { recursive: true, force: true }); pruned.push(old); }
}
console.log(JSON.stringify({ backupPath: destination, dbIntegrity: 'ok', restoreCheck: 'ok', consistency: manifest.consistency, ledgers: fingerprint.map(x => x.name), serverActionSlots,
  oauthCounts: manifest.oauthCounts, copied, missing, currentRelease, pruned }));
