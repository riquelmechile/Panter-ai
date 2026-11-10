/** Server-action authority and the durable record of every action: its own ledger document (`server_actions`)
 * and slot table, in the same SQLite file as the mesh, with a database-enforced partial unique slot. The runner
 * (server-action-runner.ts) reads and advances actions only through `runnerStore()`. */
import { randomUUID } from 'node:crypto';
import { SqliteLedger } from './sqlite-ledger.js';
import type { ServerAction, ServerActionStore, ServerActionState } from './server-action-runner.js';

export type AuthorizationState = 'OPEN' | 'BOUND' | 'CONSUMED' | 'EXPIRED';
export type OperatorAuthorization = {
  id: string; action: 'deploy.commit'; sha: string; state: AuthorizationState;
  createdAt: string; expiresAt: string; permitId: string | null; actionId: string | null;
};
export type ActionRecord = {
  actionId: string; action: 'deploy.commit'; args: { sha: string };
  state: ServerActionState | 'DRY_RUN';
  host: string; workId: string | null; attemptId: string | null;
  leaseGeneration: number | null; permitId: string | null;
  issuedBy: string; authorizationId: string | null; authorization: 'standing' | 'per-release';
  createdAt: string; completedAt: string | null;
  checks: Array<{ precondition: string; result: 'PASS' }>;
  transitions: Array<{ state: ServerActionState | 'DRY_RUN'; at: string; exitCode?: number | null; revision?: string | null; logSha256?: string | null }>;
  sha?: string; reservedAt?: string; launchStartedAt?: string; exitCode?: number | null;
  revision?: string | null; logSha256?: string | null; receiptClaimedAt?: string; receiptSentAt?: string;
};
type Data = { version: 1; authorizations: OperatorAuthorization[]; actions: ActionRecord[] };
const seed: Data = { version: 1, authorizations: [], actions: [] };
const hexSha = /^[a-f0-9]{40}$/;
const now = () => new Date().toISOString();
function assert(ok: unknown, error: string): asserts ok { if (!ok) throw new Error(error); }

function expire(d: Data) {
  const instant = Date.now();
  for (const a of d.authorizations) if ((a.state === 'OPEN' || a.state === 'BOUND') &&
      Date.parse(a.expiresAt) <= instant) a.state = 'EXPIRED';
}
export class ServerActionsLedger {
  private readonly db: SqliteLedger;
  readonly standing: boolean;
  constructor(dir: string, env: Record<string, string | undefined> = process.env) {
    // Same file as the mesh (data/panter.sqlite), so one backup snapshot always holds mesh permits and this
    // authority together and a restore cannot leave them at different points in time. It is still a separate
    // ledger document: a mesh mutation and a mutation here are two transactions (see "Reserving crosses two stores").
    this.db = SqliteLedger.open(dir);
    this.standing = env.PANTER_SERVER_DEPLOY_STANDING_AUTHORIZATION === '1';
  }
  close() { this.db.close(); }
  authorize(actor: string, sha: string): OperatorAuthorization {
    assert(actor === 'admin', 'OPERATOR_ONLY');
    assert(hexSha.test(sha), 'INVALID_SHA');
    return this.db.mutate('server_actions', seed, d => {
      expire(d);
      const a: OperatorAuthorization = { id: randomUUID(), action: 'deploy.commit', sha,
        state: 'OPEN', createdAt: now(), expiresAt: new Date(Date.now() + 24 * 3600_000).toISOString(),
        permitId: null, actionId: null };
      d.authorizations.push(a);
      return a;
    }).result;
  }
  /** Bind a single operator decision before emitting the corresponding mesh permit.
   * If the second store refuses the grant, this decision remains BOUND and unusable. */
  bindPermit(sha: string, permitId: string): string | null {
    assert(hexSha.test(sha), 'INVALID_SHA');
    if (this.standing) return null;
    return this.db.mutate('server_actions', seed, d => {
      expire(d);
      const a = d.authorizations.find(x => x.sha === sha && x.action === 'deploy.commit' && x.state === 'OPEN');
      assert(a, 'NOT_AUTHORIZED');
      a.state = 'BOUND'; a.permitId = permitId;
      return a.id;
    }, {operation: 'bind', permitId}).result;
  }
  /** Preliminary check. Actual consumption is repeated in the reservation transaction. */
  authorized(sha: string, permitId: string | null, recordId: string | null) {
    if (!hexSha.test(sha)) return false;
    if (recordId === null && this.standing) return true;
    const state = this.db.read('server_actions', seed);
    return state.authorizations.some(a => a.id === recordId && a.sha === sha &&
      Date.parse(a.expiresAt) > Date.now() &&
      (permitId === null ? a.state === 'OPEN' && a.permitId === null
        : a.state === 'BOUND' && a.permitId === permitId));
  }
  /** For direct leader calls the oldest OPEN record is consumed during RESERVED,
   * never at the preliminary check. */
  directAuthorized(sha: string) {
    return this.standing || this.db.read('server_actions', seed).authorizations.some(a =>
      a.sha === sha && a.state === 'OPEN' && Date.parse(a.expiresAt) > Date.now());
  }
  reserve(input: Omit<ActionRecord, 'state' | 'createdAt' | 'completedAt' | 'transitions' | 'authorizationId' | 'authorization'> &
    { authorizationId: string | null }): ActionRecord {
    try {
      return this.db.mutate('server_actions', seed, d => {
        expire(d);
        const a = input.authorizationId === null && this.standing ? null :
          input.permitId ? d.authorizations.find(x => x.id === input.authorizationId &&
            x.sha === input.args.sha && x.state === 'BOUND' && x.permitId === input.permitId) :
          d.authorizations.find(x => x.sha === input.args.sha && x.state === 'OPEN' &&
            x.permitId === null);
        assert(a || this.standing && input.authorizationId === null, 'NOT_AUTHORIZED');
        if (a) { a.state = 'CONSUMED'; a.actionId = input.actionId; }
        const at = now();
        const row: ActionRecord = {
          ...input, authorizationId: a?.id ?? null, authorization: a ? 'per-release' : 'standing',
          state: 'RESERVED', createdAt: at, completedAt: null,
          sha: input.args.sha, reservedAt: at,
          transitions: [{ state: 'RESERVED', at }]
        };
        d.actions.push(row);
        return row;
      }, {actionId: input.actionId, operation: 'reserve'}).result;
    } catch (error) {
      if (error instanceof Error && /UNIQUE constraint failed/.test(error.message)) throw new Error('BUSY');
      throw error;
    }
  }
  /** Phase 1 only: after proving RESERVED, free the slot without claiming the
   * Phase 2 fence, wrapper or unit ever ran. */
  finishDryRun(actionId: string): ActionRecord {
    return this.db.mutate('server_actions', seed, d => {
      const row = d.actions.find(x => x.actionId === actionId);
      assert(row?.state === 'RESERVED', 'ACTION_NOT_RESERVED');
      row.state = 'DRY_RUN'; row.completedAt = now();
      row.transitions.push({state: 'DRY_RUN', at: row.completedAt});
      return row;
    }, {actionId, operation: 'release'}).result;
  }
  /** Runner adapter: one SQLite IMMEDIATE transaction for state and terminal slot.
   * A dry run never had a unit, a wrapper or a fence: the runner does not see it. */
  runnerStore(): ServerActionStore {
    const terminal = new Set(['LIVE','ROLLED_BACK','BUILD_FAILED','FAILED','LOCKED','START_FAILED','ABANDONED','UNKNOWN']);
    const view = (a: ActionRecord): ServerAction =>
      ({ ...structuredClone(a), sha: a.sha ?? a.args.sha, reservedAt: a.reservedAt ?? a.createdAt }) as ServerAction;
    const mine = (a: ActionRecord | undefined): a is ActionRecord => Boolean(a) && a!.state !== 'DRY_RUN';
    return {
      read: async id => {
        const a = this.db.read('server_actions', seed).actions.find(x => x.actionId === id);
        return mine(a) ? view(a) : undefined;
      },
      list: async () => this.db.read('server_actions', seed).actions.filter(mine).map(view),
      transact: async <T>(id: string, update: (current: ServerAction | undefined) =>
        { next: ServerAction; result: T } | undefined): Promise<T | undefined> => {
        const result = this.db.mutate('server_actions', seed, d => {
          const index = d.actions.findIndex(a => a.actionId === id);
          const row = index < 0 ? undefined : d.actions[index];
          const current = mine(row) ? view(row) : undefined;
          const changed = update(current);
          if (!changed) return { changed: false as const, releaseSlot: false };
          assert(current && row, 'ACTION_NOT_FOUND');
          assert(changed.next.actionId === id && changed.next.sha === current.sha, 'ACTION_IDENTITY_CHANGED');
          // The authority record is not the runner's to rewrite.
          for (const key of ['action','args','host','workId','attemptId','leaseGeneration','permitId','issuedBy',
            'authorizationId','authorization','createdAt','checks'] as const)
            assert(JSON.stringify((changed.next as Record<string, unknown>)[key]) === JSON.stringify(row[key]), 'ACTION_IDENTITY_CHANGED');
          assert(!terminal.has(current.state) || changed.next.state === current.state, 'ACTION_ALREADY_TERMINAL');
          const releaseSlot = !terminal.has(current.state) && terminal.has(changed.next.state);
          d.actions[index] = { ...changed.next, completedAt: releaseSlot ? now() : row.completedAt } as ActionRecord;
          return { changed: true as const, releaseSlot, value: changed.result };
        }, { actionId: id, operation: 'release_if_terminal' });
        return result.result.changed ? result.result.value : undefined;
      },
    };
  }
  status(actionId?: string) {
    // The view reports expiry without rewriting history on a read.
    const d = this.db.read('server_actions', seed);
    const authorizations = d.authorizations.map(a => ({
      ...a, state: (a.state === 'OPEN' || a.state === 'BOUND') && Date.parse(a.expiresAt) <= Date.now()
        ? 'EXPIRED' as const : a.state
    }));
    return {authorizations, actions: d.actions.filter(a => !actionId || a.actionId === actionId)};
  }
}
