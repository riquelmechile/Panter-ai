import { ownerMode } from './owner-mode.js';

/** Workforce access: how much a worker may do with GitHub without the leader spelling it out for each work.
 *
 * `PANTER_WORKFORCE_ACCESS=restricted` (default): a worker writes only where the leader's grant says.
 * `PANTER_WORKFORCE_ACCESS=open` (only with `PANTER_OWNER_MODE=1`): for a deployment whose owner runs every host
 * and does not want delegated work to come back "not permitted":
 *   - the paths of a grant are advice, not a limit;
 *   - a worker may take GitHub access itself for the work it holds, in a repository of the allowlist;
 *   - agent instruction files (AGENTS.md, CLAUDE.md, GEMINI.md) may be committed.
 *
 * What never opens: workers never merge, approve, force-push or write a default or protected branch, CI and
 * tool configuration, or git configuration; a repository outside PANTER_GITHUB_WORKFORCE_REPOS; a revoked grant.
 *
 * Frozen at boot like owner mode; unit tests that never freeze read the environment per call. */
let frozen: boolean | null = null;

export function parseWorkforceAccess(raw: string | undefined): boolean {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === '' || value === 'restricted') return false;
  if (value === 'open') return true;
  throw new Error('PANTER_WORKFORCE_ACCESS must be restricted or open');
}
export function freezeWorkforceAccess(owner: boolean): boolean {
  if (frozen === null) {
    const open = parseWorkforceAccess(process.env.PANTER_WORKFORCE_ACCESS);
    if (open && !owner) throw new Error('PANTER_WORKFORCE_ACCESS=open requires PANTER_OWNER_MODE=1');
    frozen = open;
  }
  return frozen;
}
export function openAccess(): boolean { return frozen ?? (parseWorkforceAccess(process.env.PANTER_WORKFORCE_ACCESS) && ownerMode()); }
