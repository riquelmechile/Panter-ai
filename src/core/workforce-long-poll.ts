/** Single-process, actor-scoped MCP long-poll for Xanxittoo 2.0 Workforce.
 * This is a live tool wait, NOT MCP Tasks, a provider wake, or a scheduler.
 * All work/leases remain authoritative in the existing Mesh SQLite ledger.
 */
import { performance } from 'node:perf_hooks';
import type { Host, MeshEngine } from './mesh.js';
import { type WorkerHost, type ProtocolEra } from './workforce-readiness.js';
import { isWorker } from './leadership.js';

export class WorkforceLongPoll {
  /** Bound the live wait surfaces to one per worker: four total at most. */
  private readonly active = new Set<WorkerHost>();
  // Periodically refresh authenticated presence while a live wait stays open.
  // Also catches commits made by a separate process sharing the SQLite ledger.
  constructor(private readonly mesh: MeshEngine, private readonly refreshMs = 60_000) {}
  /** Evidence of a live tool wait in this server process, never proof of a cold start. */
  isListening(host: WorkerHost): boolean { return this.active.has(host); }

  async wait(caller: Host, protocolEra: ProtocolEra, waitMs: number, signal?:AbortSignal) {
    if (!isWorker(caller))
      throw new Error('Only authenticated workers may wait for work');
    if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 3_600_000)
      throw new Error('Long-poll wait must be 0..3600000 milliseconds');

    if (signal?.aborted) throw new Error('Long-poll cancelled');
    const host = caller as WorkerHost;
    const report = {protocolEra, deliveryMode: 'LONG_POLL' as const};
    // Fail-closed duplicate wait admission applies before any async work.
    if (this.active.has(host)) throw new Error('Long-poll already active for worker');
    if (waitMs === 0) {
      const result = await this.mesh.workforcePoll(host, report);
      return {...result, waitOutcome: result.next ? 'CANDIDATE' as const : 'IMMEDIATE_EMPTY' as const};
    }

    this.active.add(host);
    let changed = false;
    let resume: (() => void) | null = null;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const wake = () => {
      changed = true;
      if (resume) resume();
    };
    // Subscribe BEFORE first peek: an in-flight queue change cannot be lost.
    this.mesh.events.on(host, wake);
    const deadline = performance.now() + waitMs;
    try {
      while (true) {
        if(signal?.aborted) throw new Error('Long-poll cancelled');
        changed = false;
        const result = await this.mesh.workforcePoll(host, report);
        if (result.next) return {...result, waitOutcome: 'CANDIDATE' as const};
        const remaining = deadline - performance.now();
        if (remaining <= 0) return {...result, waitOutcome: 'TIMED_OUT' as const};
        if (changed) continue;
        await new Promise<void>((resolve,reject) => {
          const cleanup = () => signal?.removeEventListener('abort', onAbort);
          const onAbort = () => {cleanup(); reject(new Error('Long-poll cancelled'));};
          if(signal?.aborted){onAbort();return;}
          signal?.addEventListener('abort',onAbort,{once:true});
          resume = () => {cleanup(); resolve();};
          timeout = setTimeout(() => {cleanup(); resolve();}, Math.min(remaining, this.refreshMs));
          if (changed) resume();
        });
        resume = null;
        if (timeout) { clearTimeout(timeout); timeout = null; }
        // Check the persisted queue exactly once more even on timeout.
        if (performance.now() >= deadline) {
          const final = await this.mesh.workforcePoll(host, report);
          return {...final, waitOutcome: final.next ? 'CANDIDATE' as const : 'TIMED_OUT' as const};
        }
      }
    } finally {
      if (timeout) clearTimeout(timeout);
      this.mesh.events.off(host, wake);
      this.active.delete(host);
    }
  }
}

/** Seconds a standing worker should block on its next wait: long enough to never be a tight loop. */
export const LISTEN_WAIT_SECONDS = 300;
/** Tell a standing worker what to do next after a wait, in plain visible fields. The next wait always
 *  carries a non-zero waitSeconds, so even an immediate (waitSeconds 0) probe turns into a blocking wait. */
export function withListenHint<T extends {waitOutcome:string}>(r:T, protocolEra:string){
  return r.waitOutcome==='CANDIDATE'
    ?{...r,nextTool:'panter_workforce_pickup' as const,nextArguments:{},
      instruction:'Work is queued for you: claim it with panter_workforce_pickup.'}
    :{...r,nextTool:'panter_workforce_wait' as const,nextArguments:{protocolEra,waitSeconds:LISTEN_WAIT_SECONDS},
      instruction:`No work yet. A standing Panter worker calls panter_workforce_wait again with waitSeconds ${LISTEN_WAIT_SECONDS}; it blocks on the server for that long, so this is not a tight loop.`};
}
