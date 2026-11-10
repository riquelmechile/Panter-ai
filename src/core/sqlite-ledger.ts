/** Single SQLite WAL authority for the legacy Panter ledgers.
 * The first open imports existing JSON snapshots in ONE IMMEDIATE transaction.
 * JSON sources are deliberately retained for operator rollback; after import
 * every read and mutation uses SQLite, not in-memory cached JSON.
 */
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { enableSqliteWal, retrySqliteStartup } from './sqlite-startup.js';

export const LEGACY_LEDGERS = ['state', 'agents', 'mesh', 'harness', 'oauth', 'events', 'gemini_mail', 'github_workforce', 'downstream', 'downstream_sensitive', 'server_actions'] as const;
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
    // Initial WAL initialization may contend with another opener.
    const deadline=Date.now()+15_000;
    this.db.exec('PRAGMA busy_timeout=1000');
    enableSqliteWal(this.db,deadline);
    this.db.exec('PRAGMA synchronous=FULL');
    retrySqliteStartup(()=>this.migrate(path),deadline);
    this.db.exec('PRAGMA busy_timeout=10000');
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
  /** Committed revision only (no payload parse): lets callers skip re-reading an unchanged ledger. */
  revision(name: LedgerName): number {
    const row = this.db.prepare('SELECT revision FROM ledger WHERE name=?').get(name) as { revision: number } | undefined;
    return row?.revision ?? 0;
  }
  mutate<T, R>(name: LedgerName, fallback: T, fn: (state: T) => R,
    slot?: { actionId: string; operation: 'reserve' | 'release' | 'release_if_terminal' } | { permitId: string; operation: 'bind' }): { before: T; after: T; result: R } {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare('SELECT payload,revision FROM ledger WHERE name=?').get(name) as LedgerRow | undefined;
      const before: T = row ? JSON.parse(row.payload) as T : structuredClone(fallback);
      const after = structuredClone(before);
      const result = fn(after);
      const json = JSON.stringify(after);
      if (slot) {
        if (name !== 'server_actions') throw new Error('Action slot is only valid in server-actions');
        if (slot.operation === 'bind') {
          if (typeof result !== 'string' || !result) throw new Error('Missing operator authorization id');
          this.db.exec('CREATE TABLE IF NOT EXISTS server_authorization_bindings (authorization_id TEXT PRIMARY KEY, permit_id TEXT NOT NULL UNIQUE)');
          this.db.prepare('INSERT INTO server_authorization_bindings(authorization_id,permit_id) VALUES(?,?)')
            .run(result, slot.permitId);
        } else {
          this.db.exec('CREATE TABLE IF NOT EXISTS server_action_slots (action_id TEXT PRIMARY KEY, active INTEGER NOT NULL CHECK(active IN (0,1)))');
          this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS one_nonterminal_server_action ON server_action_slots ((1)) WHERE active=1');
          if (slot.operation === 'reserve') {
            this.db.prepare('INSERT INTO server_action_slots(action_id,active) VALUES(?,1)').run(slot.actionId);
          } else if (slot.operation === 'release' || (slot.operation === 'release_if_terminal' && typeof result === 'object' && result !== null && 'releaseSlot' in result && result.releaseSlot === true)) {
            const changed = this.db.prepare('UPDATE server_action_slots SET active=0 WHERE action_id=? AND active=1').run(slot.actionId);
            if (changed.changes !== 1) throw new Error('Action slot not held');
          }
        }
      }
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
