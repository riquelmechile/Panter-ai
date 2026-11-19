/** Housekeeping for directed work. Harness work has its own pickup timeouts, but work the leader delegates
 * directly had nothing that ever ended an expired claim: it stayed RUNNING for days, held its edit scope, and
 * only an operator could close it. This sweep runs on a timer, never starts a model and never replays a write. */
import type { SweepEffects } from './mesh.js';

/** Default grace after a lease runs out. Long on purpose: until then the same attempt may still finish late. */
export const SWEEP_GRACE_SECONDS = 6 * 3600;

/** How long a writer must have been OUTCOME_UNKNOWN before the sweep looks at what it left. A GitHub write that
 * was authorized just before may still be in flight (each call times out at 20 s); nothing new can be authorized
 * after. Ten minutes is far longer than any such write. */
export const SWEEP_SETTLE_SECONDS = 600;

export function parseSweepGrace(raw: string | undefined): number {
  const value = (raw ?? '').trim();
  if (value === '') return SWEEP_GRACE_SECONDS;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 900 || n > 7 * 86400) throw new Error('PANTER_SWEEP_GRACE_SECONDS must be an integer between 900 and 604800');
  return n;
}

export type SweepMesh = {
  sweepExpired(graceMs: number): Promise<{ abandoned: string[]; uncertain: string[] }>;
  unsweptUncertainWriters(settleMs?: number): Promise<Array<{ workId: string; attemptId: string; leaseGeneration: number }>>;
  sweepVerdict(input: { workId: string; attemptId: string; leaseGeneration: number; effects: SweepEffects; evidence: string }): Promise<{ workId: string; state: string | null; recorded: boolean }>;
};
export type SweepGitHub = {
  effects(workId: string): Promise<{ known: false; reason: string } | { known: true; repository: string; branch: string; branchExists: boolean; pulls: number[]; writes: number; createdBranch: boolean; opened: number }>;
  revokeEnded(workId: string): boolean;
};
export type SweepReport = { abandoned: string[]; uncertain: string[]; cleared: string[]; reported: string[]; deferred: string[] };

/** One pass: end expired read-only claims, mark expired writers as of unknown outcome, then look once at what each
 * writer that has been uncertain for settleSeconds left on GitHub and tell the leader. A writer marked in this
 * pass is therefore looked at in a later one. A GitHub failure defers that work to the next pass. */
export async function sweepExpiredWork(mesh: SweepMesh, github: SweepGitHub, graceSeconds = SWEEP_GRACE_SECONDS, settleSeconds = SWEEP_SETTLE_SECONDS): Promise<SweepReport> {
  const { abandoned, uncertain } = await mesh.sweepExpired(graceSeconds * 1000);
  for (const id of abandoned) github.revokeEnded(id);
  const report: SweepReport = { abandoned, uncertain, cleared: [], reported: [], deferred: [] };
  for (const w of await mesh.unsweptUncertainWriters(settleSeconds * 1000)) {
    let effects: SweepEffects, evidence: string;
    try {
      const seen = await github.effects(w.workId);
      if (!seen.known) { effects = 'UNVERIFIABLE'; evidence = seen.reason; }
      else {
        const found = seen.branchExists || seen.pulls.length > 0 || seen.writes > 0 || seen.createdBranch || seen.opened > 0;
        effects = found ? 'FOUND' : 'NONE';
        evidence = `${seen.repository}: branch ${seen.branch} ${seen.branchExists ? 'exists' : 'does not exist'}; ` +
          `pull requests from it: ${seen.pulls.length ? seen.pulls.map(n => '#' + n).join(', ') : 'none'}; ` +
          `writes reserved by its grant: ${seen.writes}; branch created by its grant: ${seen.createdBranch ? 'yes' : 'no'}; ` +
          `pull requests and issues it opened: ${seen.opened}`;
      }
    } catch { report.deferred.push(w.workId); continue; }
    const out = await mesh.sweepVerdict({ ...w, effects, evidence });
    if (!out.recorded) continue;
    if (out.state === 'ABORTED_NO_EFFECTS') { github.revokeEnded(w.workId); report.cleared.push(w.workId); }
    else report.reported.push(w.workId);
  }
  return report;
}

/** Three rings ten minutes apart is what an app host gets (see EVENT_RERING_MS and EVENT_MAX_RINGS); queued work
 * still unclaimed after that long is not going to be picked up by a wake that already happened. */
export const UNCLAIMED_AFTER_SECONDS = 30 * 60;

export type UnclaimedWork = { workId: string; missionId: string; target: string; role: string; neverClaimed: boolean; reassignedFrom: string | null; targetBusy: boolean };
export type UnclaimedMesh<H extends string = string> = {
  unclaimedQueued(afterMs: number): Promise<UnclaimedWork[]>;
  reassignUnclaimed(input: { workId: string; to: H }): Promise<{ reassigned: boolean }>;
  unsettledReassignments(): Promise<Array<{ workId: string; from: string; to: string }>>;
  settleReassignment(input: { workId: string; grant: 'MOVED' | 'NONE' | 'NOT_MOVED' }): Promise<boolean>;
  noteUnclaimed(workId: string): Promise<boolean>;
};
export type UnclaimedGitHub = {
  rehostable(workId: string, from: string): 'NONE' | 'OK' | 'BLOCKED';
  rehost(workId: string, from: string, to: string): 'MOVED' | 'NONE' | 'NOT_MOVED';
};
export type UnclaimedReport = { reassigned: Array<{ workId: string; from: string; to: string }>; reported: string[] };

/** One pass over queued work nobody claims. In owner mode, work that was never claimed moves once to another
 * reachable worker (candidates, best first), its GitHub grant with it; otherwise, and when that worker does not
 * claim it either, the leader gets one message. Work whose worker is busy on something else is waiting its turn:
 * it may move to a free worker, but it is not reported as ignored. Nothing is rung here: moving the work wakes
 * its new worker through the normal routes.
 *
 * A move is two writes in two ledgers (the work, then its grant) and they cannot be one transaction. So the work
 * records the move as unfinished until the grant followed and the leader was told, and every pass starts by
 * finishing the moves it finds unfinished: a server that stops, or a write that fails, between the two leaves
 * nothing stranded. Moving the grant is safe to repeat. Work whose grant could not follow is not moved at all. */
export async function sweepUnclaimedWork<H extends string>(mesh: UnclaimedMesh<H>, github: UnclaimedGitHub,
  candidates: (work: UnclaimedWork) => Promise<H[]>, owner: boolean, afterSeconds = UNCLAIMED_AFTER_SECONDS): Promise<UnclaimedReport> {
  const report: UnclaimedReport = { reassigned: [], reported: [] };
  const settle = async (workId: string, from: string, to: string) => {
    if (await mesh.settleReassignment({ workId, grant: github.rehost(workId, from, to) })) report.reassigned.push({ workId, from, to });
  };
  for (const r of await mesh.unsettledReassignments()) await settle(r.workId, r.from, r.to);
  for (const w of await mesh.unclaimedQueued(afterSeconds * 1000)) {
    let movedTo: H | null = null;
    if (owner && w.neverClaimed && !w.reassignedFrom && github.rehostable(w.workId, w.target) !== 'BLOCKED') {
      for (const to of await candidates(w)) {
        if ((to as string) === w.target) continue;
        if (!(await mesh.reassignUnclaimed({ workId: w.workId, to })).reassigned) continue;
        movedTo = to;
        break;
      }
    }
    if (movedTo) await settle(w.workId, w.target, movedTo);
    else if (!w.targetBusy && await mesh.noteUnclaimed(w.workId)) report.reported.push(w.workId);
  }
  return report;
}
