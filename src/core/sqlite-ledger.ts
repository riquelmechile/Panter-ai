/** Single SQLite WAL authority for the legacy Panter ledgers.
 * The first open imports existing JSON snapshots in ONE IMMEDIATE transaction.
 * JSON sources are deliberately retained for operator rollback; after import
 * every read and mutation uses SQLite, not in-memory cached JSON.
 */
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const LEGACY_LEDGERS = ['state', 'agents', 'mesh', 'harness', 'oauth'] as const;
export type LedgerName = typeof LEGACY_LEDGERS[number];
type LedgerRow = { payload: string; revision: number };
type SqliteRow = { user_version: number };
const digest = (s: string) => createHash('sha256').update(s).digest('hex');

export class SqliteLedger {
  private readonly db: DatabaseSync;
  readonly filename: string;
  private constructor(dir: string) {
    const path = resolve(dir);
    mkdirSync(path, { recursive: true, mode: 0o700 });
    this.filename = join(path, 'panter.sqlite');
    this.db = new DatabaseSync(this.filename);
    chmodSync(this.filename, 0o600);
    this.db.exec('PRAGMA journal_mode=WAL');
    this.db.exec('PRAGMA synchronous=FULL');
    this.db.exec('PRAGMA busy_timeout=10000');
    this.migrate(path);
  }
  static open(dir: string): SqliteLedger { return new SqliteLedger(dir); }
  private migrate(dir: string): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const version = (this.db.prepare('PRAGMA user_version').get() as SqliteRow).user_version;
      if (version > 1) throw new Error('Unsupported SQLite schema version');
      if (version === 0) {
        this.db.exec(
          'CREATE TABLE IF NOT EXISTS ledger (name TEXT PRIMARY KEY, payload TEXT NOT NULL, revision INTEGER NOT NULL CHECK (revision >= 1), imported_sha256 TEXT);' +
          'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);'
        );
        this.db.prepare('INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(1,?)')
          .run(new Date().toISOString());
        this.db.exec('PRAGMA user_version=1');
      }
      const select = this.db.prepare('SELECT payload,revision FROM ledger WHERE name=?');
      const insert = this.db.prepare('INSERT INTO ledger(name,payload,revision,imported_sha256) VALUES(?,?,1,?)');
      for (const name of LEGACY_LEDGERS) {
        const file = join(dir, name + '.json');
        if (select.get(name) || !existsSync(file)) continue;
        const source = readFileSync(file, 'utf8');
        let value: unknown;
        try { value = JSON.parse(source); }
        catch { throw new Error('Malformed legacy JSON: ' + name); }
        if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1) {
          throw new Error('Invalid legacy ledger: ' + name);
        }
        insert.run(name, source, digest(source));
      }
      this.db.exec('COMMIT');
    } catch (err) { this.db.exec('ROLLBACK'); throw err; }
    const check = this.db.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
    if (check.integrity_check !== 'ok') throw new Error('SQLite integrity check failed');
  }
  read<T>(name: LedgerName, fallback: T): T {
    const row = this.db.prepare('SELECT payload,revision FROM ledger WHERE name=?').get(name) as LedgerRow | undefined;
    return row ? JSON.parse(row.payload) as T : structuredClone(fallback);
  }
  mutate<T, R>(name: LedgerName, fallback: T, fn: (state: T) => R): { before: T; after: T; result: R } {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare('SELECT payload,revision FROM ledger WHERE name=?').get(name) as LedgerRow | undefined;
      const before: T = row ? JSON.parse(row.payload) as T : structuredClone(fallback);
      const after = structuredClone(before);
      const result = fn(after);
      const json = JSON.stringify(after);
      if (row) {
        this.db.prepare('UPDATE ledger SET payload=?,revision=revision+1 WHERE name=?').run(json, name);
      } else {
        this.db.prepare('INSERT INTO ledger(name,payload,revision,imported_sha256) VALUES(?,?,1,NULL)').run(name, json);
      }
      this.db.exec('COMMIT');
      return { before, after, result: structuredClone(result) };
    } catch (err) { this.db.exec('ROLLBACK'); throw err; }
  }
  close(): void { this.db.close(); }
}
