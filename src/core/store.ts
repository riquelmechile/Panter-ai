import { SqliteLedger } from './sqlite-ledger.js';
import { randomUUID, createHash } from 'node:crypto';
import { resolve, join } from 'node:path';

export type MissionStatus = 'DRAFT' | 'READY' | 'RUNNING' | 'VERIFYING' | 'DONE' | 'BLOCKED';
export interface Mission {
  id: string; project: string; goal: string; status: MissionStatus;
  revision: number; createdAt: string; updatedAt: string;
}
export interface WorkItem {
  id: string; missionId: string; target: string; instruction: string;
  idempotencyKey: string; state: 'PENDING' | 'CLAIMED' | 'COMPLETED';
  leaseGeneration: number; leaseUntil: string | null; result: string | null;
  createdAt: string; updatedAt: string;
}
interface State { version: 1; missions: Mission[]; work: WorkItem[] }
const moves: Record<MissionStatus, MissionStatus[]> = {
  DRAFT: ['READY', 'BLOCKED'], READY: ['RUNNING', 'BLOCKED'],
  RUNNING: ['VERIFYING', 'BLOCKED'], VERIFYING: ['DONE', 'RUNNING', 'BLOCKED'],
  DONE: [], BLOCKED: ['READY'],
};
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function hash(text: string): string { return createHash('sha256').update(text).digest('hex'); }

/** Single-process durable store; do not share the same directory across replicas. */
export class PanterStore {
  private state: State = { version: 1, missions: [], work: [] };
  private queue: Promise<unknown> = Promise.resolve();
  private readonly sqlite: SqliteLedger;
  private constructor(dir: string) { this.sqlite = SqliteLedger.open(dir); }
  static async open(dir: string): Promise<PanterStore> {
    const store = new PanterStore(dir);
    const state: unknown = store.sqlite.read('state', store.state);
    assert(typeof state === 'object' && state !== null && 'version' in state && state.version === 1, 'Unsupported data format');
    assert('missions' in state && Array.isArray(state.missions), 'Corrupt missions store');
    assert('work' in state && Array.isArray(state.work), 'Corrupt work store');
    store.state = state as State;
    return store;
  }

  private modify<T>(operation: (state: State) => T): Promise<T> {
    const next = this.queue.then(() => {
      const { after, result } = this.sqlite.mutate('state', this.state, operation);
      this.state = after;
      return result;
    });
    this.queue = next.then(() => undefined, () => undefined);
    return next;
  }

  private async read<T>(operation: (state: State) => T): Promise<T> {
    await this.queue;
    this.state = this.sqlite.read('state', this.state);
    return operation(structuredClone(this.state));
  }

  createMission(project: string, goal: string): Promise<Mission> {
    return this.modify(state => {
      const now = new Date().toISOString();
      const mission: Mission = { id: randomUUID(), project, goal, status: 'DRAFT', revision: 1, createdAt: now, updatedAt: now };
      state.missions.push(mission);
      return mission;
    });
  }
  getMission(id: string): Promise<Mission | null> {
    return this.read(state => state.missions.find(x => x.id === id) ?? null);
  }
  listMissions(project?: string): Promise<Mission[]> {
    return this.read(state => state.missions.filter(x => project === undefined || x.project === project).reverse());
  }
  transitionMission(id: string, status: MissionStatus, expectedRevision: number): Promise<Mission> {
    return this.modify(state => {
      const item = state.missions.find(x => x.id === id);
      assert(item, 'Mission not found');
      assert(item.revision === expectedRevision, 'Stale mission revision');
      assert(moves[item.status].includes(status), `Invalid mission transition: ${item.status} -> ${status}`);
      item.status = status; item.revision += 1; item.updatedAt = new Date().toISOString();
      return item;
    });
  }
  enqueueWork(missionId: string, target: string, instruction: string, idempotencyKey: string): Promise<WorkItem> {
    return this.modify(state => {
      assert(state.missions.some(m => m.id === missionId), 'Mission not found');
      const existing = state.work.find(w => w.missionId === missionId && w.idempotencyKey === idempotencyKey);
      if (existing) {
        assert(existing.target === target && hash(existing.instruction) === hash(instruction), 'Idempotency conflict');
        return existing;
      }
      const now = new Date().toISOString();
      const work: WorkItem = { id: randomUUID(), missionId, target, instruction, idempotencyKey, state: 'PENDING', leaseGeneration: 0, leaseUntil: null, result: null, createdAt: now, updatedAt: now };
      state.work.push(work);
      return work;
    });
  }
  claimWork(target: string, leaseSeconds = 120): Promise<WorkItem | null> {
    return this.modify(state => {
      const now = Date.now();
      const job = state.work.find(w => w.target === target &&
        (w.state === 'PENDING' || (w.state === 'CLAIMED' && w.leaseUntil !== null && Date.parse(w.leaseUntil) <= now)));
      if (!job) return null;
      job.state = 'CLAIMED'; job.leaseGeneration += 1;
      job.leaseUntil = new Date(now + leaseSeconds * 1000).toISOString();
      job.updatedAt = new Date(now).toISOString();
      return job;
    });
  }
  completeWork(id: string, target: string, leaseGeneration: number, result: string): Promise<WorkItem> {
    return this.modify(state => {
      const job = state.work.find(w => w.id === id);
      assert(job, 'Work not found');
      assert(job.target === target && job.state === 'CLAIMED', 'Work not claimed by target');
      assert(job.leaseGeneration === leaseGeneration, 'Stale lease generation');
      assert(job.leaseUntil !== null && Date.parse(job.leaseUntil) > Date.now(), 'Lease expired');
      job.state = 'COMPLETED'; job.result = result; job.leaseUntil = null; job.updatedAt = new Date().toISOString();
      return job;
    });
  }
  getWork(id: string): Promise<WorkItem | null> {
    return this.read(state => state.work.find(w => w.id === id) ?? null);
  }
}
