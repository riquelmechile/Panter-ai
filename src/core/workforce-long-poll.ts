/** Single-process, actor-scoped MCP long-poll for Xanxittoo 2.0 Workforce.
 * This is a live tool wait, NOT MCP Tasks, a provider wake, or a scheduler.
 * All work/leases remain authoritative in the existing Mesh SQLite ledger.
 */
import { performance } from 'node:perf_hooks';
import type { Host, MeshEngine } from './mesh.js';
import { WORKER_HOSTS, type WorkerHost, type ProtocolEra } from './workforce-readiness.js';

export class WorkforceLongPoll {
  /** Bound the live wait surfaces to one per worker: four total at most. */
  private readonly active = new Set<WorkerHost>();
  constructor(private readonly mesh: MeshEngine) {}

  async wait(caller: Host, protocolEra: ProtocolEra, waitMs: number) {
    if (!(WORKER_HOSTS as readonly string[]).includes(caller))
      throw new Error('Only authenticated workers may wait for work');
    if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 20_000)
      throw new Error('Long-poll wait must be 0..20000 milliseconds');

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
        changed = false;
        const result = await this.mesh.workforcePoll(host, report);
        if (result.next) return {...result, waitOutcome: 'CANDIDATE' as const};
        const remaining = deadline - performance.now();
        if (remaining <= 0) return {...result, waitOutcome: 'TIMED_OUT' as const};
        if (changed) continue;
        await new Promise<void>(resolve => {
          resume = resolve;
          timeout = setTimeout(resolve, remaining);
          // A durable event may have landed while awaiting the preceding poll.
          if (changed) resolve();
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
