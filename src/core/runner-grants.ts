/**
 * Phase-2 runner grant verifier.  This module does NOT issue grants, open a
 * listener, launch a process, or provide a deployment capability.
 *
 * Only the Panter control-plane signer (out of scope for this PR) may create
 * signatures. A separate runner must pin its public verification keys.
 */
import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { closeSync, constants, lstatSync, mkdirSync, openSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { enableSqliteWal, retrySqliteStartup } from './sqlite-startup.js';

export const RUNNER_OPERATIONS = [
  'workspace.prepare', 'git.inspect', 'git.diff', 'build.install',
  'build.check', 'build.compile', 'test.run', 'workspace.cleanup', 'release.request',
] as const;
export type RunnerOperation = typeof RUNNER_OPERATIONS[number];
export type EffectClass = 'READ' | 'WORKTREE_WRITE' | 'TEST_EXEC' | 'RELEASE';

export interface RunnerGrant {
  version: 1;
  grantId: string;
  issuer: 'panter-ai';
  audience: 'panter-runner';
  subject: string;
  missionId: string;
  workId: string;
  attemptId: string;
  leaseGeneration: number;
  repository: string;
  candidateSha: string;
  notBefore: number;
  expiresAt: number;
  maxUses: number;
  operations: RunnerOperation[];
  paths: string[];
  effectClass: EffectClass;
}

export interface SignedRunnerGrant {
  keyId: string;
  claims: RunnerGrant;
  signature: string;
}

export interface RunnerGrantContext {
  subject: string;
  missionId: string;
  workId: string;
  attemptId: string;
  leaseGeneration: number;
  repository: string;
  candidateSha: string;
  operation: RunnerOperation;
  effectClass: EffectClass;
}

export class GrantRejected extends Error {
  constructor() { super('Runner grant rejected'); this.name = 'GrantRejected'; }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA = /^[0-9a-f]{40}$/;
const REPO = /^[a-zA-Z0-9_.-]{1,100}\/[a-zA-Z0-9_.-]{1,100}$/;
const ID = /^[a-zA-Z0-9_.:@-]{1,160}$/;
const KEY_ID = /^[a-zA-Z0-9_.-]{1,64}$/;
const MAX_DURATION_MS = 60 * 60 * 1000;
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const OPS = new Set<string>(RUNNER_OPERATIONS);
const EFFECTS = new Set<string>(['READ','WORKTREE_WRITE','TEST_EXEC','RELEASE']);

function ownKeysEqual(value: unknown, keys: string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}
function safeId(x: unknown): x is string { return typeof x === 'string' && ID.test(x); }
function validPath(p: unknown): p is string {
  return typeof p === 'string' && p.length > 0 && p.length <= 240
    && !p.startsWith('/') && !p.includes('\\') && !p.includes('\0')
    && p.split('/').every(part => part.length > 0 && part !== '.' && part !== '..');
}
function operationEffect(op: RunnerOperation): EffectClass {
  if (op === 'release.request') return 'RELEASE';
  if (op === 'build.install' || op === 'build.check' || op === 'build.compile' || op === 'test.run') return 'TEST_EXEC';
  if (op === 'workspace.prepare' || op === 'workspace.cleanup') return 'WORKTREE_WRITE';
  return 'READ';
}
export function parseGrant(value: unknown): RunnerGrant {
  const keys = ['version','grantId','issuer','audience','subject','missionId','workId','attemptId',
    'leaseGeneration','repository','candidateSha','notBefore','expiresAt','maxUses','operations','paths','effectClass'];
  if (!ownKeysEqual(value, keys)) throw new GrantRejected();
  const x = value;
  if (x.version !== 1 || x.issuer !== 'panter-ai' || x.audience !== 'panter-runner' ||
      typeof x.grantId !== 'string' || !UUID.test(x.grantId) ||
      !safeId(x.subject) || !safeId(x.missionId) || !safeId(x.workId) || !safeId(x.attemptId) ||
      !Number.isSafeInteger(x.leaseGeneration) || (x.leaseGeneration as number) < 1 ||
      typeof x.repository !== 'string' || !REPO.test(x.repository) ||
      typeof x.candidateSha !== 'string' || !SHA.test(x.candidateSha) ||
      !Number.isSafeInteger(x.notBefore) || !Number.isSafeInteger(x.expiresAt) ||
      (x.expiresAt as number) <= (x.notBefore as number) ||
      (x.expiresAt as number) - (x.notBefore as number) > MAX_DURATION_MS ||
      !Number.isSafeInteger(x.maxUses) || (x.maxUses as number) < 1 || (x.maxUses as number) > 32 ||
      typeof x.effectClass !== 'string' || !EFFECTS.has(x.effectClass) ||
      !Array.isArray(x.operations) || x.operations.length === 0 || x.operations.length > OPS.size ||
      x.operations.some(op => typeof op !== 'string' || !OPS.has(op)) ||
      new Set(x.operations).size !== x.operations.length ||
      x.operations.some(op => operationEffect(op as RunnerOperation) !== x.effectClass) ||
      !Array.isArray(x.paths) || x.paths.length === 0 || x.paths.length > 32 ||
      x.paths.some(p => !validPath(p)) || new Set(x.paths).size !== x.paths.length ||
      (x.effectClass !== 'READ' && x.maxUses !== 1)) throw new GrantRejected();
  return x as unknown as RunnerGrant;
}
/** A fixed-order, versioned encoding — *not* arbitrary JSON.stringify on untrusted objects. */
export function grantPayload(grant: RunnerGrant): Buffer {
  const x = parseGrant(grant);
  return Buffer.from(JSON.stringify([
    'panter.runner-grant/v1', x.version, x.grantId, x.issuer, x.audience,
    x.subject, x.missionId, x.workId, x.attemptId, x.leaseGeneration,
    x.repository, x.candidateSha, x.notBefore, x.expiresAt, x.maxUses,
    x.operations, x.paths, x.effectClass,
  ]), 'utf8');
}
/**
 * Ed25519 always signs 64 bytes. Node's base64url decoder accepts aliases
 * with unused trailing bits set; only the single canonical 86-char encoding
 * is allowed in a signed runner envelope.
 */
function decodeCanonicalSignature(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]{86}$/.test(value)) throw new GrantRejected();
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length !== 64 || bytes.toString('base64url') !== value) throw new GrantRejected();
  return bytes;
}

export function verifyRunnerGrant(envelope: unknown, keys: ReadonlyMap<string, KeyObject>, now: number): RunnerGrant {
  if (!ownKeysEqual(envelope, ['keyId','claims','signature']) ||
      typeof envelope.keyId !== 'string' || !KEY_ID.test(envelope.keyId) ||
      typeof envelope.signature !== 'string' ||
      !Number.isSafeInteger(now)) throw new GrantRejected();
  const key = keys.get(envelope.keyId);
  if (!key || key.asymmetricKeyType !== 'ed25519') throw new GrantRejected();
  const claims = parseGrant(envelope.claims);
  if (now < claims.notBefore || now >= claims.expiresAt) throw new GrantRejected();
  const signature = decodeCanonicalSignature(envelope.signature);
  if (!verify(null, grantPayload(claims), key, signature)) throw new GrantRejected();
  return claims;
}
export function pinnedRunnerKeys(entries: Record<string,string>): ReadonlyMap<string,KeyObject> {
  const keys = new Map<string,KeyObject>();
  if (Object.keys(entries).length === 0) throw new GrantRejected();
  for (const [kid, pem] of Object.entries(entries)) {
    if (!KEY_ID.test(kid) || typeof pem !== 'string') throw new GrantRejected();
    try {
      const key = createPublicKey(pem);
      if (key.asymmetricKeyType !== 'ed25519') throw new GrantRejected();
      keys.set(kid, key);
    } catch { throw new GrantRejected(); }
  }
  return keys;
}
function matched(claims: RunnerGrant, ctx: RunnerGrantContext): boolean {
  return claims.subject === ctx.subject && claims.missionId === ctx.missionId &&
    claims.workId === ctx.workId && claims.attemptId === ctx.attemptId &&
    claims.leaseGeneration === ctx.leaseGeneration && claims.repository === ctx.repository &&
    claims.candidateSha === ctx.candidateSha && claims.effectClass === ctx.effectClass &&
    OPS.has(ctx.operation) && operationEffect(ctx.operation) === ctx.effectClass &&
    claims.operations.includes(ctx.operation);
}
/**
 * Atomically reserves a signed grant invocation. Does not execute work.
 * Callers must not interpret a reservation as evidence of effect completion.
 */
export class RunnerGrantLedger {
  private readonly db: DatabaseSync;
  constructor(dir: string) {
    const root = resolve(dir);
    mkdirSync(root, {recursive:true,mode:0o700});
    const info = statSync(root);
    if ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()) throw new GrantRejected();
    const file = join(root, 'runner-grants.sqlite');
    try {
      const fd = openSync(file, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | O_NOFOLLOW, 0o600);
      closeSync(fd);
    } catch (err) {
      const x = err as NodeJS.ErrnoException;
      if (x.code !== 'EEXIST') throw new GrantRejected();
    }
    const f = lstatSync(file);
    if (!f.isFile() || f.isSymbolicLink() || (f.mode & 0o077) !== 0 || f.uid !== process.getuid?.()) throw new GrantRejected();
    this.db = new DatabaseSync(file);
    // WAL may require an exclusive lock on first open; wait before requesting it.
    const deadline=Date.now()+15_000;
    this.db.exec('PRAGMA busy_timeout=1000');
    enableSqliteWal(this.db,deadline);
    this.db.exec('PRAGMA synchronous=FULL');
    retrySqliteStartup(()=>{
      this.db.exec('BEGIN IMMEDIATE');
      try{
        this.db.exec('CREATE TABLE IF NOT EXISTS grant_uses (grant_id TEXT PRIMARY KEY, signed_digest TEXT NOT NULL, used INTEGER NOT NULL, max_uses INTEGER NOT NULL, expires_at INTEGER NOT NULL)');
        this.db.exec('CREATE TABLE IF NOT EXISTS request_uses (request_id TEXT PRIMARY KEY, grant_id TEXT NOT NULL REFERENCES grant_uses(grant_id))');
        this.db.exec('COMMIT');
      }catch(error){
        this.db.exec('ROLLBACK');
        throw error;
      }
    },deadline);
    this.db.exec('PRAGMA busy_timeout=10000');
  }
  reserve(envelope: unknown, keys: ReadonlyMap<string,KeyObject>, ctx: RunnerGrantContext, requestId: string, now=Date.now()): void {
    const claims = verifyRunnerGrant(envelope, keys, now);
    if (!matched(claims, ctx) || !UUID.test(requestId)) throw new GrantRejected();
    const blob = grantPayload(claims);
    // Fingerprint the verified, canonical Ed25519 bytes instead of caller text.
    const signature = decodeCanonicalSignature((envelope as SignedRunnerGrant).signature);
    const digest = createHash('sha256').update(blob).update(signature).digest('hex');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const prior = this.db.prepare('SELECT signed_digest, used, max_uses FROM grant_uses WHERE grant_id = ?')
        .get(claims.grantId) as {signed_digest:string,used:number,max_uses:number}|undefined;
      if (prior && (prior.signed_digest !== digest || prior.used >= prior.max_uses)) throw new GrantRejected();
      if (!prior) {
        this.db.prepare('INSERT INTO grant_uses(grant_id,signed_digest,used,max_uses,expires_at) VALUES(?,?,0,?,?)')
          .run(claims.grantId,digest,claims.maxUses,claims.expiresAt);
      }
      this.db.prepare('INSERT INTO request_uses(request_id,grant_id) VALUES(?,?)').run(requestId,claims.grantId);
      this.db.prepare('UPDATE grant_uses SET used=used+1 WHERE grant_id=?').run(claims.grantId);
      this.db.exec('COMMIT');
    } catch {
      this.db.exec('ROLLBACK');
      throw new GrantRejected();
    }
  }
  close(): void { this.db.close(); }
}
