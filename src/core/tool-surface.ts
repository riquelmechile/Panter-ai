import { z } from 'zod';

/**
 * Tool surface: how Panter's tools are presented to each connected host.
 *
 * Nothing here grants or removes a capability. Every tool stays registered and callable by its own name, and every
 * tool is also reachable through its domain router (`panter_<domain>` with `operation`). Each tool keeps its own
 * authorization checks. The only thing that changes per role is which tools appear in `tools/list`: the domain
 * routers plus the tools that role uses in its normal workflow, so a host is not handed 100+ tools to choose from.
 */
export type SurfaceRole = 'leader' | 'worker' | 'operator';

export const DOMAINS = ['harness', 'review', 'mesh', 'workforce', 'github', 'memory', 'catalog', 'admin'] as const;
export type Domain = typeof DOMAINS[number];

const DOMAIN_TEXT: Record<Domain, string> = {
  harness: 'automatic ODD harness: start, tick, report, status, corrections, GitHub binding, write grants',
  review: '4R / Judgment Day review sessions, native review slots and Panter-RDD verdicts',
  mesh: 'A2A mesh: host profiles, delegation, claims, heartbeats, completion, messages, specialist bindings',
  workforce: 'workforce: pickup, wait/listen, receipts, results, wake and presence status',
  github: 'GitHub: work-scoped grants and audit (leader); read, commit, PR, comment, issue (worker)',
  memory: 'Engram project memory: status, context, search, save',
  catalog: 'Gentle Shell catalog: agents, skills, orchestrator sections, ODD route, specialist packets, Agent Studio',
  admin: 'operator and legacy tools: missions, work, agents, flows, native workflow, OAuth clients, host policy',
};

/** Which domain a tool belongs to (its router). */
export function toolDomain(name: string): Domain {
  const n = name.replace(/^panter_/, '');
  if (n.startsWith('harness_')) return 'harness';
  if (n.startsWith('review_') || n.startsWith('rdd_') || n.startsWith('native_review_')) return 'review';
  if (n.startsWith('mesh_') || n.startsWith('specialist_')) return 'mesh';
  if (n.startsWith('workforce_')) return 'workforce';
  if (n.startsWith('github_')) return 'github';
  if (n.startsWith('memory_')) return 'memory';
  if (n.startsWith('gentle_') || n === 'odd_route' || n === 'native_packet' || n === 'agent_studio') return 'catalog';
  return 'admin';
}

/** Tools the leader uses in its normal workflow (listed flat for the leader). */
const LEADER = new Set([
  'harness_start', 'harness_tick', 'harness_report', 'harness_status', 'harness_correction_report', 'harness_github_bind',
  'harness_github_check', 'harness_unit_report', 'harness_units_set', 'harness_write_grant',
  'review_status', 'rdd_status', 'native_review_submit', 'native_review_submit_solo', 'native_review_progress',
  'specialist_delegate', 'specialist_assignments', 'mesh_inbox', 'mesh_profiles', 'mesh_message',
  'workforce_status', 'workforce_result_get', 'workforce_receipts', 'workforce_grok_wake_status',
  'github_grant', 'github_revoke', 'github_audit',
  'memory_context', 'memory_search', 'memory_save',
  'agent_studio',
].map(x => `panter_${x}`));

/** Tools a worker host uses in its normal workflow (listed flat for workers). Kept wide on purpose: a host such as
 * ChatGPT can only call listed tools, so every pickup/claim/complete path the hosts' own routines use stays listed. */
const WORKER = new Set([
  'workforce_pickup', 'workforce_complete_and_rearm', 'workforce_next', 'workforce_wait', 'workforce_listen',
  'workforce_task_bridge', 'workforce_schedule_pickup', 'workforce_rearm_status', 'workforce_app_turn', 'workforce_receipts',
  'mesh_claim', 'mesh_heartbeat', 'mesh_complete', 'mesh_pending', 'mesh_inbox', 'mesh_message',
  'github_read', 'github_commit', 'github_open_pr', 'github_comment', 'github_create_issue',
  'memory_context', 'memory_search', 'memory_save',
].map(x => `panter_${x}`));

/** The workflow tools listed flat for a role (besides the routers). */
export const workflowTools = (role: 'leader' | 'worker') => [...(role === 'leader' ? LEADER : WORKER)];
export const routerName = (d: Domain) => `panter_${d}`;
const ROUTERS = new Set<string>(DOMAINS.map(routerName));

/** Whether a tool appears in `tools/list` for this role. Routers always do; the operator sees everything. */
export function listedFor(name: string, role: SurfaceRole): boolean {
  if (ROUTERS.has(name) || role === 'operator') return true;
  return (role === 'leader' ? LEADER : WORKER).has(name);
}

/** The short operation name of a tool inside its router: `panter_harness_tick` -> `tick`, `panter_rdd_status` -> `rdd_status`. */
export function operationName(name: string): string {
  const n = name.replace(/^panter_/, ''), d = toolDomain(name);
  return n.startsWith(`${d}_`) ? n.slice(d.length + 1) : n;
}

type Entry = { config: { description?: string; inputSchema?: z.ZodType; annotations?: { readOnlyHint?: boolean } }; cb: (args: unknown, ctx: unknown) => unknown };
const text = (value: unknown, isError = false) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }], ...(isError ? { isError: true } : {}) });

/**
 * Attach the tool surface to a freshly created server, before any tool is registered. It records every registered
 * tool; `finalize()` then adds the domain routers and the per-role `tools/list` (call it after the last tool).
 * `listAll` keeps the old behaviour: every tool listed for every role.
 */
export function createToolSurface(server: any, opts: { role: () => SurfaceRole; listAll?: boolean }) {
  const catalog = new Map<string, Entry>();
  const register = server.registerTool.bind(server);
  server.registerTool = (name: string, config: Entry['config'], cb: Entry['cb']) => {
    catalog.set(name, { config, cb });
    return register(name, config, cb);
  };
  const domainOps = (d: Domain) => [...catalog].filter(([n]) => !ROUTERS.has(n) && toolDomain(n) === d);
  const describe = (name: string, e: Entry, detail: boolean) => {
    const base = { operation: operationName(name), tool: name, readOnly: e.config.annotations?.readOnlyHint === true,
      listedForYou: opts.listAll === true || listedFor(name, opts.role()) };
    if (!detail) return { ...base, description: (e.config.description ?? '').slice(0, 240) };
    let inputSchema: unknown = null;
    try { inputSchema = e.config.inputSchema ? z.toJSONSchema(e.config.inputSchema, { unrepresentable: 'any', io: 'input' }) : { type: 'object' }; }
    catch { inputSchema = 'unavailable'; }
    return { ...base, description: e.config.description ?? '', inputSchema };
  };
  return {
    finalize() {
      for (const d of DOMAINS) {
        register(routerName(d), {
          description: `Domain router for ${DOMAIN_TEXT[d]}. Call with operation "index" to list its operations (add arguments {"operation":"<name>"} for one operation's full description and input schema), then with operation "<name>" and that operation's arguments. Same tools, same authorization as calling them by name.`,
          inputSchema: z.object({ operation: z.string().trim().min(1).max(80), arguments: z.record(z.string(), z.unknown()).optional() }).strict(),
        }, async (input: { operation: string; arguments?: Record<string, unknown> }, ctx: unknown) => {
          const ops = domainOps(d);
          const find = (op: string) => ops.find(([n]) => n === op || operationName(n) === op);
          if (input.operation === 'index') {
            const one = typeof input.arguments?.operation === 'string' ? find(input.arguments.operation) : undefined;
            if (input.arguments?.operation !== undefined && !one) return text({ error: `Unknown ${d} operation`, operations: ops.map(([n]) => operationName(n)) }, true);
            return text(one ? describe(one[0], one[1], true) : { domain: d, operations: ops.map(([n, e]) => describe(n, e, false)) });
          }
          const hit = find(input.operation);
          if (!hit) return text({ error: `Unknown ${d} operation "${input.operation}"; call operation "index"`, operations: ops.map(([n]) => operationName(n)) }, true);
          const [name, entry] = hit;
          const parsed = entry.config.inputSchema ? await entry.config.inputSchema.safeParseAsync(input.arguments ?? {}) : { success: true as const, data: input.arguments ?? {} };
          if (!parsed.success) return text({ error: `Invalid arguments for ${name}`, issues: parsed.error.issues.slice(0, 20) }, true);
          return entry.cb(parsed.data, ctx);
        });
      }
      if (opts.listAll) return;
      // Same tools/list the SDK builds, filtered per role. tools/call is untouched: unlisted tools stay callable.
      const inner = server.server._getRequestHandler('tools/list');
      if (typeof inner !== 'function') throw new Error('tools/list handler missing');
      server.server.setRequestHandler('tools/list', async (request: unknown, ctx: unknown) => {
        const result = await inner(request, ctx);
        const role = opts.role();
        return { ...result, tools: (result.tools ?? []).filter((t: { name: string }) => listedFor(t.name, role)) };
      });
    },
  };
}
