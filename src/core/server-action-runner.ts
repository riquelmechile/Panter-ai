import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readFile, readlink, symlink, type FileHandle } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const TERMINAL = new Set<ServerActionState>([
  'LIVE', 'ROLLED_BACK', 'BUILD_FAILED', 'FAILED', 'LOCKED',
  'START_FAILED', 'ABANDONED', 'UNKNOWN',
]);
const FINAL_RECORD = new Set(['LIVE', 'ROLLED_BACK', 'BUILD_FAILED', 'FAILED', 'LOCKED']);
// Lowercase only, like the wrapper: one action must never map to two fence names.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{40}$/;
export const SERVER_ACTION_LAUNCH_TIMEOUT_MS = 30_000;
export const SERVER_ACTION_MAX_AGE_MS = 50 * 60_000;
export const SERVER_ACTION_FENCE_WAIT_MS = 120_000;

export type ServerActionState =
  | 'RESERVED' | 'LAUNCHED' | 'RUNNING' | 'STOPPING'
  | 'LIVE' | 'ROLLED_BACK' | 'BUILD_FAILED' | 'FAILED' | 'LOCKED'
  | 'START_FAILED' | 'ABANDONED' | 'UNKNOWN';

export interface ServerActionTransition {
  state: ServerActionState;
  at: string;
  exitCode: number | null;
  revision: string | null;
  logSha256: string | null;
}

export interface ServerAction {
  actionId: string;
  sha: string;
  reservedAt: string;
  state: ServerActionState;
  launchStartedAt?: string;
  transitions?: ServerActionTransition[];
  exitCode?: number | null;
  revision?: string | null;
  logSha256?: string | null;
  receiptClaimedAt?: string;
  receiptSentAt?: string;
  [key: string]: unknown; // Phase 1 retains authority, actor, claim and precondition fields.
}

/** Phase 1 implements this with a server-actions ledger transaction (BEGIN IMMEDIATE).
 * The callback is synchronous and must run wholly within that transaction. */
export interface ServerActionStore {
  read(actionId: string): Promise<ServerAction | undefined>;
  list(): Promise<ServerAction[]>;
  transact<T>(
    actionId: string,
    update: (current: ServerAction | undefined) => { next: ServerAction; result: T } | undefined,
  ): Promise<T | undefined>;
}

/** Tests only. Not a substitute for the Phase 1 transactional SQLite adapter. */
export class MemoryServerActionStore implements ServerActionStore {
  private readonly actions = new Map<string, ServerAction>();
  constructor(actions: ServerAction[] = []) {
    for (const action of actions) this.actions.set(action.actionId, structuredClone(action));
  }
  async read(id: string): Promise<ServerAction | undefined> {
    const action = this.actions.get(id);
    return action && structuredClone(action);
  }
  async list(): Promise<ServerAction[]> {
    return [...this.actions.values()].map((action) => structuredClone(action));
  }
  async transact<T>(
    id: string,
    update: (current: ServerAction | undefined) => { next: ServerAction; result: T } | undefined,
  ): Promise<T | undefined> {
    const existing = this.actions.get(id);
    const outcome = update(existing && structuredClone(existing));
    if (!outcome) return undefined;
    this.actions.set(id, structuredClone(outcome.next));
    return outcome.result;
  }
}

export interface ServerActionReceipt {
  receiptId: string; // Stable idempotency key for the Phase 1 inbox adapter.
  actionId: string;
  recipients: readonly ['leader', 'worker'];
  state: ServerActionState;
  sha: string;
  exitCode: number | null;
  revision: string | null;
  logSha256: string | null;
}
export interface RunnerOptions {
  store: ServerActionStore;
  baseDir: string;
  sourceRepo: string;
  notify: (receipt: ServerActionReceipt) => Promise<void> | void;
  now?: () => Date;
  env?: NodeJS.ProcessEnv; // Test harness PATH, never supplied by an action request.
  /** Operator settings deploy.sh reads (unit name, health URL, releases kept): the only
   * other variables the unit receives. Built from server configuration, never from a request. */
  unitEnv?: Readonly<Record<string, string>>;
  launchTimeoutMs?: number; // Default is exactly 30 s.
}
type Fence = 'absent' | 'run' | 'closed' | 'odd';
type RecordObservation =
  | { kind: 'none' | 'bad' | 'running' }
  | { kind: 'final'; state: ServerActionState; exitCode: number; revision: string | null };

const when = (o: RunnerOptions): string => (o.now?.() ?? new Date()).toISOString();
const fencePath = (o: RunnerOptions, id: string): string => join(o.baseDir, 'etc', 'actions', id + '.fence');
const filePath = (o: RunnerOptions, id: string, suffix: string): string =>
  join(o.baseDir, 'etc', 'actions', id + suffix);
const unitName = (id: string): string => 'panter-action-' + id;
const isMissing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT';
const validId = (id: string): boolean => UUID.test(id);
/** deploy.sh's optional settings and nothing else: Panter's own environment holds
 * tokens that a deployment must never inherit. */
export const SERVER_ACTION_UNIT_SETTINGS = ['PANTER_UNIT', 'PANTER_HEALTH_URL', 'PANTER_KEEP_RELEASES'] as const;
export const validUnitSetting = (value: string): boolean => /^[\x21-\x7e]{1,300}$/.test(value);
const unitSettings = (o: RunnerOptions): string[] => SERVER_ACTION_UNIT_SETTINGS.flatMap((name) => {
  const value = o.unitEnv?.[name];
  return value === undefined || value === '' ? [] : ['--setenv=' + name + '=' + value];
});
const unitPath = (o: RunnerOptions): string => [...new Set([
  ...((o.env ?? process.env).PATH ?? '').split(':'), dirname(process.execPath),
  '/usr/local/bin', '/usr/bin', '/bin',
].filter((entry) => entry.startsWith('/')))].join(':');

async function fence(o: RunnerOptions, id: string): Promise<Fence> {
  const path = fencePath(o, id);
  try {
    const info = await lstat(path); // Never stat() a dangling fence.
    if (!info.isSymbolicLink()) return 'odd';
    const target = await readlink(path);
    return target === 'run' || target === 'closed' ? target : 'odd';
  } catch (error) {
    return isMissing(error) ? 'absent' : 'odd';
  }
}

async function closeFence(o: RunnerOptions, id: string): Promise<boolean> {
  try {
    await symlink('closed', fencePath(o, id));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error; // Never presume an inaccessible fence means no launch.
  }
}

async function unitLive(o: RunnerOptions, id: string): Promise<boolean> {
  const { stdout } = await execFile('systemctl', [
    '--user', 'show', unitName(id), '-p', 'LoadState,ActiveState',
  ], { env: o.env ?? process.env, timeout: 10_000, maxBuffer: 4096 });
  const fields = new Map(stdout.trim().split(/\r?\n/).map((line) => {
    const index = line.indexOf('=');
    return [line.slice(0, index), line.slice(index + 1)];
  }));
  const load = fields.get('LoadState');
  const active = fields.get('ActiveState');
  if (!load || !active) throw new Error('INDETERMINATE_SYSTEMD_STATE');
  if (load === 'not-found' || active === 'inactive' || active === 'failed') return false;
  if (['activating', 'active', 'reloading', 'deactivating'].includes(active)) return true;
  throw new Error('INDETERMINATE_SYSTEMD_STATE');
}

async function record(o: RunnerOptions, action: ServerAction): Promise<RecordObservation> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(filePath(o, action.actionId, '.json'), 'utf8'));
  } catch (error) {
    return isMissing(error) ? { kind: 'none' } : { kind: 'bad' };
  }
  if (!value || typeof value !== 'object') return { kind: 'bad' };
  const r = value as Record<string, unknown>;
  if (r.actionId !== action.actionId || r.sha !== action.sha ||
      typeof r.at !== 'string' || !Number.isFinite(Date.parse(r.at))) return { kind: 'bad' };
  if (r.state === 'RUNNING' && r.exitCode === null && r.revision === null) return { kind: 'running' };
  if (typeof r.state === 'string' && FINAL_RECORD.has(r.state) &&
      Number.isInteger(r.exitCode) && typeof r.exitCode === 'number' &&
      r.exitCode >= 0 && r.exitCode <= 255 &&
      (r.revision === null || typeof r.revision === 'string')) {
    if (r.state === 'LIVE' && (r.exitCode !== 0 || r.revision !== action.sha)) {
      return { kind: 'bad' };
    }
    if (['ROLLED_BACK', 'BUILD_FAILED', 'LOCKED'].includes(r.state) && r.exitCode === 0) {
      return { kind: 'bad' };
    }
    return { kind: 'final', state: r.state as ServerActionState, exitCode: r.exitCode, revision: r.revision };
  }
  return { kind: 'bad' };
}

/** The log is evidence, never a condition: only a regular file is read, a
 * link is not followed, and nothing here can block or throw. */
async function openLog(o: Pick<RunnerOptions, 'baseDir'>, id: string): Promise<{ handle: FileHandle; size: number } | null> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(join(o.baseDir, 'etc', 'actions', id + '.log'),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await handle.stat();
    if (info.isFile()) return { handle, size: info.size };
  } catch { /* absent, a link, unreadable: there is no log to show */ }
  await handle?.close().catch(() => undefined);
  return null;
}

/** null when there is no readable regular log. An action must reach its
 * terminal state and free the slot whether or not its log can be hashed. */
async function logDigest(o: RunnerOptions, id: string): Promise<string | null> {
  const log = await openLog(o, id);
  if (!log) return null;
  const hash = createHash('sha256');
  try {
    for await (const chunk of log.handle.createReadStream({ autoClose: false })) hash.update(chunk);
    return hash.digest('hex');
  } catch {
    return null;
  } finally { await log.handle.close().catch(() => undefined); }
}

function transition(
  current: ServerAction, state: ServerActionState, at: string,
  result: { exitCode?: number | null; revision?: string | null; logSha256?: string | null } = {},
): ServerAction {
  const exitCode = result.exitCode ?? null;
  const revision = result.revision ?? null;
  const logSha256 = result.logSha256 ?? null;
  return {
    ...current, state, exitCode, revision, logSha256,
    transitions: [...(current.transitions ?? []), { state, at, exitCode, revision, logSha256 }],
  };
}

async function deliver(o: RunnerOptions, id: string): Promise<void> {
  // A persisted lease prevents concurrent reconcilers from duplicating an inbox write.
  // A crashed sender may retry after two minutes; notify MUST dedupe receiptId.
  const at = when(o);
  const claim = await o.store.transact(id, (a) => {
    if (!a || !TERMINAL.has(a.state) || a.receiptSentAt) return undefined;
    if (a.receiptClaimedAt && Date.parse(at) - Date.parse(a.receiptClaimedAt) < 120_000) return undefined;
    return { next: { ...a, receiptClaimedAt: at }, result: {
      receiptId: a.actionId, actionId: a.actionId,
      recipients: ['leader', 'worker'] as const, state: a.state, sha: a.sha,
      exitCode: a.exitCode ?? null, revision: a.revision ?? null,
      logSha256: a.logSha256 ?? null,
    } };
  });
  if (!claim) return;
  try {
    await o.notify(claim);
    await o.store.transact(id, (a) => a && !a.receiptSentAt
      ? { next: { ...a, receiptSentAt: when(o) }, result: true } : undefined);
  } catch (error) {
    // Failed notifications retry. A crash after sending is deduplicated by receiptId.
    await o.store.transact(id, (a) => a && !a.receiptSentAt
      ? { next: { ...a, receiptClaimedAt: undefined }, result: true } : undefined);
    throw error;
  }
}

async function finish(
  o: RunnerOptions, id: string, state: ServerActionState,
  details: { exitCode?: number | null; revision?: string | null } = {},
): Promise<void> {
  const logSha256 = await logDigest(o, id);
  await o.store.transact(id, (a) => {
    if (!a || TERMINAL.has(a.state)) return undefined;
    return { next: transition(a, state, when(o), { ...details, logSha256 }), result: true };
  });
  await deliver(o, id);
}

/** The only accepted input is an action already RESERVED by Phase 1. No authority checks here. */
export async function launchServerAction(o: RunnerOptions, id: string): Promise<'SKIPPED' | 'LAUNCHED' | 'DEFERRED' | 'START_FAILED'> {
  if (!validId(id) || !o.sourceRepo || !o.baseDir ||
      !Object.values(o.unitEnv ?? {}).every(validUnitSetting)) throw new Error('INVALID_RUNNER_CONFIGURATION');
  const marked = await o.store.transact(id, (a) => {
    if (!a || a.state !== 'RESERVED' || a.launchStartedAt || !SHA.test(a.sha)) return undefined;
    return { next: { ...a, launchStartedAt: when(o) }, result: a.sha };
  });
  if (!marked) return 'SKIPPED';
  try {
    await execFile('systemd-run', [
      '--user', '--unit=' + unitName(id), '--collect',
      '--property=RuntimeMaxSec=45min',
      '--setenv=PANTER_SOURCE_REPO=' + o.sourceRepo,
      // A transient unit inherits neither Panter's environment nor a login
      // shell's: the wrapper must watch the same etc/actions as the reconciler
      // and find the same node Panter runs on.
      '--setenv=PANTER_BASE=' + o.baseDir,
      '--setenv=PATH=' + unitPath(o),
      ...unitSettings(o),
      join(o.baseDir, 'current', 'deploy', 'run-action.sh'),
      'deploy.commit', id, marked,
    ], { env: o.env ?? process.env, timeout: o.launchTimeoutMs ?? SERVER_ACTION_LAUNCH_TIMEOUT_MS,
      killSignal: 'SIGKILL', maxBuffer: 4096 });
    await o.store.transact(id, (a) => a && a.state === 'RESERVED'
      ? { next: transition(a, 'LAUNCHED', when(o)), result: true } : undefined);
    return 'LAUNCHED';
  } catch {
    if (!await closeFence(o, id)) return 'DEFERRED';
    // Reobserve after changing the fence, including the unit, before a terminal write.
    if (await fence(o, id) === 'closed' && !await unitLive(o, id)) {
      const latest = await o.store.read(id);
      if (latest && (await record(o, latest)).kind === 'none') {
        await finish(o, id, 'START_FAILED');
        return 'START_FAILED';
      }
    }
    return 'DEFERRED';
  }
}

/** All recovery decisions use fence → unit → record, freshly and in that order. */
export async function reconcileServerAction(o: RunnerOptions, id: string): Promise<void> {
  if (!validId(id)) throw new Error('INVALID_ACTION_ID');
  for (let attempt = 0; attempt < 8; attempt++) {
    const action = await o.store.read(id);
    if (!action || TERMINAL.has(action.state)) { await deliver(o, id); return; }
    const f = await fence(o, id);
    const live = await unitLive(o, id);
    const r = await record(o, action);

    if (live) {
      const started = Date.parse(action.launchStartedAt ?? action.reservedAt);
      if (!Number.isFinite(started)) throw new Error('INVALID_RESERVATION_TIMESTAMP');
      if ((o.now?.() ?? new Date()).getTime() - started >= SERVER_ACTION_MAX_AGE_MS) {
        await o.store.transact(id, (a) => a && !TERMINAL.has(a.state) && a.state !== 'STOPPING'
          ? { next: transition(a, 'STOPPING', when(o)), result: true } : undefined);
        await execFile('systemctl', ['--user', 'stop', unitName(id)],
          { env: o.env ?? process.env, timeout: 10_000, maxBuffer: 4096 });
      } else if (f === 'run') {
        // The wrapper holds the fence inside a live unit: the deployment is under way.
        await o.store.transact(id, (a) => a && (a.state === 'RESERVED' || a.state === 'LAUNCHED')
          ? { next: transition(a, 'RUNNING', when(o)), result: true } : undefined);
      }
      return; // A terminal state is never written while the unit is live.
    }

    if (f === 'run') {
      if (r.kind === 'final') await finish(o, id, r.state, { exitCode: r.exitCode, revision: r.revision });
      else await finish(o, id, 'UNKNOWN');
      return;
    }
    if (f === 'closed') {
      await finish(o, id, r.kind === 'none' ? 'ABANDONED' : 'UNKNOWN');
      return;
    }
    if (f === 'odd') { await finish(o, id, 'UNKNOWN'); return; }

    // Absent fence: a missing unit could still be accepted by systemd later.
    if (r.kind === 'none') {
      const started = Date.parse(action.launchStartedAt ?? action.reservedAt);
      if (!Number.isFinite(started)) throw new Error('INVALID_RESERVATION_TIMESTAMP');
      if ((o.now?.() ?? new Date()).getTime() - started < SERVER_ACTION_FENCE_WAIT_MS) return;
    }
    await closeFence(o, id);
    // Success OR EEXIST: never use observations made before this point.
  }
  // Highly contested fence. The next 30-second pass reobserves from scratch.
}

export async function reconcileServerActions(o: RunnerOptions): Promise<number> {
  const actions = await o.store.list();
  // One action that cannot be settled or notified must not keep the others
  // from being observed: every action gets its turn, then the first failure
  // is reported so the caller schedules another pass.
  const failures: unknown[] = [];
  for (const action of actions) {
    try {
      if (!TERMINAL.has(action.state)) await reconcileServerAction(o, action.actionId);
      else if (!action.receiptSentAt) await deliver(o, action.actionId);
    } catch (error) { failures.push(error); }
  }
  if (failures.length) throw failures[0];
  return (await o.store.list()).filter((a) => !TERMINAL.has(a.state)).length;
}

export function startServerActionReconciler(o: RunnerOptions): { start: () => Promise<void>; wake: () => Promise<void>; stop: () => void } {
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  let again = false;
  let inFlight: Promise<void> | undefined;
  const schedule = (): void => {
    if (stopped || timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      void pass().catch(() => { /* A later pass retries transient errors. */ });
    }, 30_000);
    timer.unref();
  };
  const pass = async (): Promise<void> => {
    // A request that arrives while a pass is reading may concern an action the
    // pass listed too early to see: remember it and run once more afterwards.
    if (inFlight) { again = true; return inFlight; }
    inFlight = (async () => {
      for (;;) {
        again = false;
        let pending = true; // A transient read failure must not permanently stop recovery.
        let failure: { error: unknown } | undefined;
        try {
          await reconcileServerActions(o);
          pending = (await o.store.list()).some((a) =>
            !TERMINAL.has(a.state) || !a.receiptSentAt);
        } catch (error) { failure = { error }; }
        if (pending) schedule();
        if (again && !stopped) continue;
        if (failure) throw failure.error;
        return;
      }
    })();
    try { await inFlight; } finally { inFlight = undefined; }
  };
  return {
    start: pass, wake: async () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
      await pass();
    },
    stop: () => { stopped = true; if (timer) clearTimeout(timer); timer = undefined; },
  };
}

const LOG_TAIL_BYTES = 256 * 1024;
const SECRET_KEY = String.raw`\b(?:[A-Za-z][A-Za-z0-9_-]*)?(?:authorization|token|secret|password|passwd|api[_-]?key|private[_-]?key)`;
const PEM_END = /-----END [A-Z0-9 ]*PRIVATE KEY-----/;

/** Removes what looks like a credential from text meant for an agent. When in
 * doubt it removes more: an unterminated quote or key block is cut to the end. */
export function redactServerActionLog(text: string): string {
  let out = text.replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
    '[REDACTED PRIVATE KEY]');
  // The beginning of a key block may have scrolled out of the lines read.
  const end = PEM_END.exec(out);
  if (end) out = '[REDACTED PRIVATE KEY]' + out.slice(end.index + end[0].length);
  return out
    // A key block with both markers out of view is still 64-column base64.
    .replace(/^[A-Za-z0-9+/]{64}$/gm, '[REDACTED]')
    .replace(/\b(Authorization\s*:\s*(?:Bearer|Basic)\s+)[^\s]+/gi, '$1[REDACTED]')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]+/gi, '$1[REDACTED]')
    // Whole quoted values first (they may contain spaces), plain and JSON-escaped; then bare ones.
    .replace(new RegExp(SECRET_KEY + String.raw`\\"\s*:\s*\\"(?:[^\\]|\\[^"])*?(?:\\"|$)`, 'gi'),
      (match) => match.slice(0, match.indexOf(':') + 1) + '\\"[REDACTED]\\"')
    .replace(new RegExp('(' + SECRET_KEY + String.raw`["']?\s*[:=]\s*)(?:"(?:[^"\\]|\\[\s\S])*(?:"|$)|'(?:[^'\\]|\\[\s\S])*(?:'|$))`, 'gi'),
      '$1"[REDACTED]"')
    .replace(new RegExp('(' + SECRET_KEY + String.raw`["']?\s*[:=]\s*)(?!"\[REDACTED\]")[^\s"',;&]+`, 'gi'), '$1[REDACTED]')
    .replace(/\b(?:github_pat_|gh[pousr]_|sk-)[A-Za-z0-9_-]{12,}\b/g, '[REDACTED]');
}

/** Only the final 50 lines are revealed to agents, and only of the action's own
 * regular log file: a link is not followed. Other logs stay on the server. */
export async function serverActionLogTail(baseDir: string, actionId: string): Promise<string> {
  if (!validId(actionId)) throw new Error('INVALID_ACTION_ID');
  const log = await openLog({ baseDir }, actionId);
  if (!log) throw new Error('LOG_UNAVAILABLE');
  try {
    // Bounded read from the descriptor already checked: a multi-gigabyte build
    // log never enters Panter's heap and the path is not resolved a second time.
    const length = Math.min(log.size, LOG_TAIL_BYTES);
    const start = log.size - length;
    const { bytesRead, buffer } = await log.handle.read(Buffer.alloc(length), 0, length, start);
    let lines = buffer.subarray(0, bytesRead).toString('utf8')
      .replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
    if (start > 0) lines = lines.slice(1); // the first line read is probably cut
    return redactServerActionLog(lines.slice(-50).join('\n'));
  } finally { await log.handle.close().catch(() => undefined); }
}
