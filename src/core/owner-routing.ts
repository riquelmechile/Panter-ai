/** Owner-mode routing order for panter_mesh_delegate_auto. Pure, so it can be tested without a server. */

/** A worker that claimed or completed something within this window is "answering". */
export const RECENT_ACTIVITY_MS = 72 * 3600_000;

/** Workers that answered recently first, then the least loaded, then the configured order. A worker that has
 * not answered for days is still a candidate (never refuse: it may be the only one), it just goes last. */
export function orderByAvailability<H extends string>(hosts: readonly H[], load: Partial<Record<H, number>>,
  lastActivity: Partial<Record<H, string>>, order: readonly H[], now = Date.now()): H[] {
  const quiet = (h: H) => now - Date.parse(lastActivity[h] ?? '') <= RECENT_ACTIVITY_MS ? 0 : 1;
  return [...hosts].sort((a, b) => quiet(a) - quiet(b) || (load[a] ?? 0) - (load[b] ?? 0) || order.indexOf(a) - order.indexOf(b));
}
