/** Configurable single orchestrator ("leader") for the workforce mesh.
 *
 * Exactly one authenticated host leads: it delegates work, reads results and
 * owns the harness. Every other host is a worker. The leader is fixed for the
 * life of the process by `PANTER_LEAD_HOST` (default `gpt-a`, the historical
 * behaviour). Changing it requires a restart; it is never taken from tool
 * arguments or OAuth scopes requested by a client.
 */
export const LEADER_CANDIDATES = ['gpt-a', 'gpt-b', 'grok', 'gemini', 'claude'] as const;
export type LeaderHost = typeof LEADER_CANDIDATES[number];

/** Worker order is stable and matches the historical status output for the default leader. */
const WORKER_ORDER: readonly LeaderHost[] = ['gpt-a', 'gpt-b', 'claude', 'grok', 'gemini'];
/** Hosts that run in the ChatGPT or Gemini apps and can use app turns / MCP Events delivery. */
const APP_EVENT_HOSTS: readonly LeaderHost[] = ['gpt-a', 'gpt-b', 'gemini'];

const LABELS: Record<LeaderHost, string> = {
  'gpt-a': 'GPT-A', 'gpt-b': 'GPT-B', grok: 'Grok', gemini: 'Gemini', claude: 'Claude',
};

export function parseLeaderHost(raw: string | undefined): LeaderHost {
  const value = (raw ?? 'gpt-a').trim();
  if (!(LEADER_CANDIDATES as readonly string[]).includes(value))
    throw new Error(`PANTER_LEAD_HOST must be one of ${LEADER_CANDIDATES.join(', ')}`);
  return value as LeaderHost;
}

/** Read on every call so tests can switch leader per process; production sets it once at boot. */
export function leaderHost(): LeaderHost { return parseLeaderHost(process.env.PANTER_LEAD_HOST); }
export function isLeader(host: string | null | undefined): boolean { return host === leaderHost(); }
/** Human-readable leader name used in error messages and tool descriptions. */
export function leaderLabel(): string { return LABELS[leaderHost()]; }
export function hostLabel(host: LeaderHost): string { return LABELS[host]; }
/** Native host policy for the leader: only ChatGPT hosts get the OpenAI model/effort request. */
export function leaderPolicyProfile(): 'chatgpt' | 'host-native' {
  const lead = leaderHost(); return lead === 'gpt-a' || lead === 'gpt-b' ? 'chatgpt' : 'host-native';
}
export function workerHosts(): LeaderHost[] { const lead = leaderHost(); return WORKER_ORDER.filter(h => h !== lead); }
export function isWorker(host: string | null | undefined): host is LeaderHost {
  return !!host && (workerHosts() as string[]).includes(host);
}
export function appEventHosts(): LeaderHost[] { const lead = leaderHost(); return APP_EVENT_HOSTS.filter(h => h !== lead); }
export function isAppEventHost(host: string | null | undefined): host is LeaderHost {
  return !!host && (appEventHosts() as string[]).includes(host);
}
