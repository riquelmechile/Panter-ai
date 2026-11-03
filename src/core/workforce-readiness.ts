/** Evidence-bound Workforce status; no model inference or external wake.
 * A claimed route is not an observed wake. One existing Mesh/SQLite ledger owns work.
 */
import type { ActorProfile, MeshWork } from './mesh.js';

export const WORKER_HOSTS = ['gpt-b', 'claude', 'grok', 'gemini'] as const;
export type WorkerHost = (typeof WORKER_HOSTS)[number];
export const DELIVERY_MODES = [
  'DELIVERY_ONLY', 'TASKS_2026', 'TASKS_2025', 'TASK_BRIDGE_2025',
  'LONG_POLL', 'EXTERNAL_WAKE', 'SCHEDULED_POLL',
] as const;
export type DeliveryMode = (typeof DELIVERY_MODES)[number];
export type ProtocolEra = '2026-07-28' | '2025-11-25' | 'UNKNOWN';

export type WorkerRouteReport = {
  protocolEra: ProtocolEra;
  deliveryMode: DeliveryMode;
  pollIntervalSeconds?: number;
};
export type WorkerObservation = {
  lastPollAt?: string;
  lastClaimAt?: string;
  lastReceiptAt?: string;
  lastScheduledPollAt?: string;
  scheduledPollCount?: number;
  reportedRoute?: WorkerRouteReport;
};

export function validateRouteReport(report: WorkerRouteReport): void {
  if (!['2026-07-28', '2025-11-25', 'UNKNOWN'].includes(report.protocolEra))
    throw new Error('Invalid protocol era');
  if (!(DELIVERY_MODES as readonly string[]).includes(report.deliveryMode))
    throw new Error('Invalid delivery mode');
  if (report.deliveryMode === 'TASKS_2026' && report.protocolEra !== '2026-07-28')
    throw new Error('MCP 2026 Tasks require modern protocol');
  if (['TASKS_2025', 'TASK_BRIDGE_2025'].includes(report.deliveryMode) &&
    report.protocolEra !== '2025-11-25')
    throw new Error('Legacy Tasks require legacy protocol');
  if (report.pollIntervalSeconds !== undefined &&
    (!Number.isInteger(report.pollIntervalSeconds) || report.pollIntervalSeconds < 60 ||
      report.pollIntervalSeconds > 86400 || report.deliveryMode !== 'SCHEDULED_POLL'))
    throw new Error('Invalid poll interval');
  if (report.deliveryMode === 'SCHEDULED_POLL' && report.pollIntervalSeconds === undefined)
    throw new Error('Scheduled poll interval required');
}

function lastTimestamp(...values: Array<string | undefined>): string | null {
  const ordered = values.filter((s): s is string => !!s && Number.isFinite(Date.parse(s)));
  if (!ordered.length) return null;
  return ordered.reduce((a, b) => Date.parse(a) >= Date.parse(b) ? a : b);
}

/** Only server-observed authenticated calls are evidence of presence.
 * Even a real claim + receipt can have been attended by a human; neither proves wake.
 */
export function summarizeWorkforce(
  profiles: ActorProfile[],
  observations: Partial<Record<WorkerHost, WorkerObservation>>,
  works: MeshWork[],
  nowMs: number = Date.now(),
) {
  return WORKER_HOSTS.map(host => {
    const record = observations[host];
    const lastSeenAt = lastTimestamp(record?.lastPollAt, record?.lastClaimAt, record?.lastReceiptAt);
    const age = lastSeenAt ? nowMs - Date.parse(lastSeenAt) : Infinity;
    const presence = !lastSeenAt ? 'UNKNOWN' as const :
      age >= 0 && age <= 120000 ? 'FRESH' as const : 'STALE' as const;
    const own = works.filter(w => w.target === host);
    return {
      host,
      configured: profiles.some(p => p.host === host),
      presence,
      lastSeenAt,
      reportedRoute: record?.reportedRoute ?? null,
      routeEvidence: record?.reportedRoute ? 'REPORTED_UNVERIFIED' as const : 'NONE' as const,
      claimObserved: !!record?.lastClaimAt,
      receiptObserved: !!record?.lastReceiptAt,
      autonomousWakeVerified: false as const,
      effectiveDeliveryMode: 'DELIVERY_ONLY' as const,
      pending: own.filter(w => w.state === 'QUEUED').length,
      running: own.filter(w => w.state === 'RUNNING' && Date.parse(w.leaseUntil ?? '') > nowMs).length,
      outcomesUnknown: own.filter(w => w.state === 'OUTCOME_UNKNOWN' ||
        (w.role === 'implementer' && w.state === 'RUNNING' &&
          Date.parse(w.leaseUntil ?? '') <= nowMs)).length,
    };
  });
}
