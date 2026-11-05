/**
 * Downstream MCP gateway: other MCP servers (each in its own repository and service) mounted behind Panter.
 *
 * The operator lists them in a JSON file (PANTER_DOWNSTREAM_CONFIG). Panter connects to each one with a token only it
 * holds, caches its tools, and exposes it to the hosts allowed to use it as one router tool (`panter_ds_<name>`).
 * Every call is classified from the downstream tool's own annotations (MCP defaults: a tool is destructive unless it
 * says otherwise) and gated by the server's write policy and Panter's write grants, then forwarded with a timeout and
 * a circuit breaker, and audited. The downstream server keeps its own approvals on top (a double lock).
 */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createHash, randomUUID } from 'node:crypto';
import type { SqliteLedger } from './sqlite-ledger.js';

export type WritePolicy = 'deny' | 'grant' | 'allow';
export type ToolClass = 'read' | 'write' | 'destructive';
export type DownstreamConfig = {
  name: string; url: string; tokenEnv: string | null; hosts: string[]; writes: WritePolicy; timeoutMs: number; description: string;
};
export type DownstreamTool = { name: string; description: string; inputSchema: unknown; cls: ToolClass };
export type DownstreamGrant = {
  id: string; server: string; tools: string[] | '*'; host: string; reason: string; createdAt: string; expiresAt: string;
  usesLeft: number; revokedAt: string | null;
};
export type DownstreamAudit = {
  at: string; host: string; server: string; tool: string; cls: ToolClass; grantId: string | null; outcome: 'OK' | 'TOOL_ERROR' | 'REFUSED' | 'FAILED';
  ms: number; argsSha256: string; error: string | null;
};
type Data = { version: 1; grants: DownstreamGrant[]; audit: DownstreamAudit[] };
const seed: Data = { version: 1, grants: [], audit: [] };

const NAME = /^[a-z][a-z0-9]{1,23}$/;
const TOKEN_ENV = /^PANTER_DOWNSTREAM_[A-Z0-9_]{1,60}$/;
const MAX_SERVERS = 16, MAX_TOOLS = 200, MAX_AUDIT = 2000, MAX_RESULT_BYTES = 2_000_000;
const FAILURES_TO_OPEN = 3, OPEN_MS = 30_000;
const iso = (ms = Date.now()) => new Date(ms).toISOString();
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
/** Error text safe to show and store: one line, bounded, never a token. */
const clean = (e: unknown, secrets: string[] = []) => {
  let s = (e instanceof Error ? e.message : String(e)).replace(/\s+/g, ' ').slice(0, 300);
  for (const x of secrets) if (x) s = s.split(x).join('[redacted]');
  return s;
};

/** http only to this machine or a private network; https anywhere. */
function allowedUrl(raw: string): boolean {
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  if (u.username || u.password || u.hash) return false;
  if (u.protocol === 'https:') return true;
  if (u.protocol !== 'http:') return false;
  const h = u.hostname.replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h);
}

/** Validate the operator's config file. Throws on anything unclear: a gateway half-configured is worse than none. */
export function parseDownstreamConfig(text: string, knownHosts: readonly string[]): DownstreamConfig[] {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new Error('Downstream config: invalid JSON'); }
  const list = (raw as { servers?: unknown })?.servers;
  if (!Array.isArray(list) || list.length > MAX_SERVERS) throw new Error(`Downstream config: "servers" must be a list of at most ${MAX_SERVERS}`);
  const seen = new Set<string>();
  return list.map((s: any, i) => {
    const where = `Downstream config server ${i + 1}`;
    if (!s || typeof s !== 'object') throw new Error(`${where}: not an object`);
    const allowed = new Set(['name', 'url', 'tokenEnv', 'hosts', 'writes', 'timeoutMs', 'description']);
    for (const k of Object.keys(s)) if (!allowed.has(k)) throw new Error(`${where}: unknown field "${k}"`);
    if (typeof s.name !== 'string' || !NAME.test(s.name)) throw new Error(`${where}: name must be 2-24 lowercase letters or digits`);
    if (seen.has(s.name)) throw new Error(`${where}: duplicate name ${s.name}`); seen.add(s.name);
    if (typeof s.url !== 'string' || !allowedUrl(s.url)) throw new Error(`${where}: url must be https, or http to localhost or a private address`);
    if (s.tokenEnv !== undefined && (typeof s.tokenEnv !== 'string' || !TOKEN_ENV.test(s.tokenEnv)))
      throw new Error(`${where}: tokenEnv must be a PANTER_DOWNSTREAM_* variable name`);
    const hosts = s.hosts ?? [];
    if (!Array.isArray(hosts) || hosts.some((h: unknown) => typeof h !== 'string' || !knownHosts.includes(h)))
      throw new Error(`${where}: hosts must name known hosts (${knownHosts.join(', ')})`);
    const writes = s.writes ?? 'grant';
    if (!['deny', 'grant', 'allow'].includes(writes)) throw new Error(`${where}: writes must be deny, grant or allow`);
    const timeoutMs = s.timeoutMs ?? 30_000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300_000) throw new Error(`${where}: timeoutMs must be 1000-300000`);
    if (s.description !== undefined && (typeof s.description !== 'string' || s.description.length > 300)) throw new Error(`${where}: description too long`);
    return { name: s.name, url: s.url, tokenEnv: s.tokenEnv ?? null, hosts: [...new Set<string>(hosts)], writes, timeoutMs, description: s.description ?? '' };
  });
}

/** MCP tool annotations: read-only only when it says so; otherwise destructive unless it says it is not. */
export function classify(annotations: { readOnlyHint?: unknown; destructiveHint?: unknown } | undefined): ToolClass {
  if (annotations?.readOnlyHint === true) return 'read';
  return annotations?.destructiveHint === false ? 'write' : 'destructive';
}

type ServerState = {
  config: DownstreamConfig; tools: DownstreamTool[]; fetchedAt: string | null; failures: number; openUntil: number;
  lastError: string | null; client: Promise<Client> | null;
};
export type Caller = { id: string; operator: boolean };

export class DownstreamGateway {
  private readonly servers = new Map<string, ServerState>();
  constructor(configs: DownstreamConfig[], private readonly db: SqliteLedger | null,
    private readonly env: Record<string, string | undefined> = process.env, private readonly now: () => number = Date.now) {
    for (const config of configs) this.servers.set(config.name, { config, tools: [], fetchedAt: null, failures: 0, openUntil: 0, lastError: null, client: null });
  }
  get configured(): boolean { return this.servers.size > 0; }
  names(): string[] { return [...this.servers.keys()]; }
  /** Whether this caller may use the server at all (the operator always may). */
  allowed(caller: Caller, name: string): boolean {
    const s = this.servers.get(name);
    return !!s && (caller.operator || s.config.hosts.includes(caller.id));
  }
  private state(name: string): ServerState {
    const s = this.servers.get(name);
    if (!s) throw new Error(`Unknown downstream server "${name}"`);
    return s;
  }
  private token(s: ServerState): string | null { return s.config.tokenEnv ? this.env[s.config.tokenEnv] ?? null : null; }
  private connect(s: ServerState): Promise<Client> {
    if (s.client) return s.client;
    const token = this.token(s);
    if (s.config.tokenEnv && !token) return Promise.reject(new Error(`${s.config.tokenEnv} is not set`));
    const attempt = (async () => {
      const client = new Client({ name: 'panter-ai-gateway', version: '1.0.0' });
      // No redirects: the token is only ever sent to the configured address.
      const transport = new StreamableHTTPClientTransport(new URL(s.config.url),
        { requestInit: { redirect: 'error', ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}) } });
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([client.connect(transport), new Promise((_, no) => { timer = setTimeout(() => no(new Error('connect timed out')), s.config.timeoutMs); })]);
      } catch (error) { await client.close().catch(() => undefined); throw error; }
      finally { clearTimeout(timer); }
      return client;
    })();
    s.client = attempt;
    attempt.catch(() => { if (s.client === attempt) s.client = null; });
    return attempt;
  }
  private drop(s: ServerState) {
    const c = s.client; s.client = null;
    c?.then(x => x.close()).catch(() => undefined);
  }
  /** Run one transport operation under the circuit breaker. */
  private async guarded<T>(s: ServerState, op: (c: Client) => Promise<T>): Promise<T> {
    if (this.now() < s.openUntil) throw new Error(`circuit open until ${iso(s.openUntil)} after ${s.failures} failures: ${s.lastError ?? ''}`);
    try {
      const result = await op(await this.connect(s));
      s.failures = 0; s.lastError = null; s.openUntil = 0;
      return result;
    } catch (error) {
      s.failures++; s.lastError = clean(error, [this.token(s) ?? '']);
      if (s.failures >= FAILURES_TO_OPEN) s.openUntil = this.now() + OPEN_MS;
      this.drop(s);
      throw new Error(s.lastError);
    }
  }
  /** Fetch and cache a server's tools (all pages, bounded). */
  async refresh(name: string): Promise<{ server: string; tools: number }> {
    const s = this.state(name);
    const tools = await this.guarded(s, async c => {
      const out: DownstreamTool[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 20; page++) {
        const r = await c.listTools(cursor ? { cursor } : undefined, { timeout: s.config.timeoutMs } as any);
        for (const t of r.tools) {
          if (out.length >= MAX_TOOLS) break;
          if (typeof t.name !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(t.name)) continue;
          out.push({ name: t.name, description: String(t.description ?? '').slice(0, 2000), inputSchema: t.inputSchema ?? { type: 'object' },
            cls: classify(t.annotations as any) });
        }
        cursor = r.nextCursor;
        if (!cursor || out.length >= MAX_TOOLS) break;
      }
      return out;
    });
    s.tools = tools; s.fetchedAt = iso(this.now());
    return { server: name, tools: tools.length };
  }
  async refreshAll(): Promise<Array<{ server: string; tools?: number; error?: string }>> {
    return Promise.all(this.names().map(n => this.refresh(n).catch(e => ({ server: n, error: clean(e) }))));
  }
  tools(name: string): DownstreamTool[] { return this.state(name).tools; }
  status(caller: Caller) {
    const t = this.now();
    return this.names().filter(n => this.allowed(caller, n)).map(n => {
      const s = this.state(n);
      return { server: n, description: s.config.description, writes: s.config.writes, hosts: s.config.hosts, timeoutMs: s.config.timeoutMs,
        state: t < s.openUntil ? 'CIRCUIT_OPEN' : s.config.tokenEnv && !this.token(s) ? 'TOKEN_MISSING' : s.lastError ? 'DEGRADED' : s.fetchedAt ? 'OK' : 'NOT_CONTACTED',
        tools: s.tools.length, byClass: { read: s.tools.filter(x => x.cls === 'read').length, write: s.tools.filter(x => x.cls === 'write').length,
          destructive: s.tools.filter(x => x.cls === 'destructive').length },
        fetchedAt: s.fetchedAt, failures: s.failures, openUntil: t < s.openUntil ? iso(s.openUntil) : null, lastError: s.lastError,
        router: routerFor(n) };
    });
  }

  private ledger(): SqliteLedger {
    if (!this.db) throw new Error('Downstream grants need the Panter ledger');
    return this.db;
  }
  /** Operator: allow a host to use write tools of a server, for a while and a number of calls. */
  grant(input: { server: string; tools: string[] | '*'; host: string; ttlSeconds: number; uses: number; reason: string }): DownstreamGrant {
    const s = this.state(input.server);
    if (s.config.writes === 'deny') throw new Error(`${input.server} accepts no writes (writes: deny)`);
    if (!s.config.hosts.includes(input.host)) throw new Error(`${input.host} may not use ${input.server}`);
    if (!Number.isInteger(input.ttlSeconds) || input.ttlSeconds < 60 || input.ttlSeconds > 7 * 86400) throw new Error('ttlSeconds must be 60-604800');
    if (!Number.isInteger(input.uses) || input.uses < 1 || input.uses > 1000) throw new Error('uses must be 1-1000');
    const t = this.now();
    const g: DownstreamGrant = { id: randomUUID(), server: input.server, tools: input.tools === '*' ? '*' : [...new Set(input.tools)].sort(), host: input.host,
      reason: input.reason, createdAt: iso(t), expiresAt: iso(t + input.ttlSeconds * 1000), usesLeft: input.uses, revokedAt: null };
    this.ledger().mutate<Data, void>('downstream', seed, d => {
      d.grants = d.grants.filter(x => !x.revokedAt && Date.parse(x.expiresAt) > t && x.usesLeft > 0).slice(-499);
      d.grants.push(g);
    });
    return g;
  }
  revoke(id: string): { revoked: boolean } {
    const t = this.now();
    return { revoked: this.ledger().mutate<Data, boolean>('downstream', seed, d => {
      const g = d.grants.find(x => x.id === id && !x.revokedAt);
      if (g) g.revokedAt = iso(t);
      return !!g;
    }).result };
  }
  grants(): DownstreamGrant[] { return this.db ? this.db.read<Data>('downstream', seed).grants : []; }
  audit(filter: { server?: string; limit?: number } = {}): DownstreamAudit[] {
    if (!this.db) return [];
    const all = this.db.read<Data>('downstream', seed).audit.filter(a => !filter.server || a.server === filter.server);
    return all.slice(-(filter.limit ?? 100)).reverse();
  }
  private record(entry: DownstreamAudit) {
    if (!this.db) return;
    this.db.mutate<Data, void>('downstream', seed, d => { d.audit.push(entry); if (d.audit.length > MAX_AUDIT) d.audit = d.audit.slice(-MAX_AUDIT); });
  }
  /** Spend one use of a grant that covers this host, server and tool. Atomic: two calls cannot share the last use. */
  private spend(caller: Caller, server: string, tool: string, cls: ToolClass, grantId: string | undefined): string {
    if (!grantId) throw new Error(`${server}.${tool} is a ${cls} tool: it needs a grantId from panter_downstream_grant`);
    const t = this.now();
    this.ledger().mutate<Data, void>('downstream', seed, d => {
      const g = d.grants.find(x => x.id === grantId);
      if (!g || g.revokedAt) throw new Error('Grant not found or revoked');
      if (g.server !== server) throw new Error('Grant is for another server');
      if (g.host !== caller.id) throw new Error('Grant is for another host');
      if (Date.parse(g.expiresAt) <= t) throw new Error('Grant expired');
      if (g.usesLeft < 1) throw new Error('Grant used up');
      // A destructive tool must be named in the grant; "*" covers ordinary writes only.
      if (g.tools === '*' ? cls === 'destructive' : !g.tools.includes(tool)) throw new Error(`Grant does not cover ${tool}${cls === 'destructive' ? ' (destructive tools must be named)' : ''}`);
      g.usesLeft--;
    });
    return grantId;
  }

  /** Forward one tool call. Refusals and failures are audited and come back as tool errors, never thrown. */
  async call(caller: Caller, server: string, tool: string, args: Record<string, unknown>, grantId?: string,
    meta: Record<string, unknown> = {}) {
    const started = this.now();
    const argsSha256 = sha(JSON.stringify(args));
    const s = this.servers.get(server);
    let cls: ToolClass = 'destructive', usedGrant: string | null = null;
    const finish = (outcome: DownstreamAudit['outcome'], error: string | null) =>
      this.record({ at: iso(started), host: caller.id, server, tool, cls, grantId: usedGrant, outcome, ms: this.now() - started, argsSha256, error });
    const refuse = (message: string) => { finish('REFUSED', message); return { isError: true, content: [{ type: 'text' as const, text: message }] }; };
    if (!s || !this.allowed(caller, server)) return refuse(`${caller.id} may not use downstream server "${server}"`);
    if (!s.fetchedAt) {
      try { await this.refresh(server); }
      catch (error) { const message = clean(error); finish('FAILED', message); return { isError: true, content: [{ type: 'text' as const, text: `${server} is unreachable: ${message}` }] }; }
    }
    const known = s.tools.find(t => t.name === tool);
    if (!known) return refuse(`Unknown tool "${tool}" on ${server}; call operation "index"`);
    cls = known.cls;
    if (cls !== 'read') {
      if (s.config.writes === 'deny') return refuse(`${server} accepts no ${cls} calls through Panter (writes: deny)`);
      // The operator (a person at the admin socket) acts without a grant; hosts need one.
      if (s.config.writes === 'grant' && !caller.operator) {
        try { usedGrant = this.spend(caller, server, tool, cls, grantId); } catch (error) { return refuse(clean(error)); }
      }
    }
    try {
      const result = await this.guarded(s, c => c.callTool({ name: tool, arguments: args,
        _meta: { ...meta, 'panter-ai/host': caller.id, ...(usedGrant ? { 'panter-ai/grantId': usedGrant } : {}) } } as any,
        { timeout: s.config.timeoutMs } as any));
      if (JSON.stringify(result).length > MAX_RESULT_BYTES) { finish('FAILED', 'result too large'); return { isError: true, content: [{ type: 'text' as const, text: `${server}.${tool} returned more than ${MAX_RESULT_BYTES} bytes` }] }; }
      finish(result.isError ? 'TOOL_ERROR' : 'OK', null);
      return result;
    } catch (error) {
      const message = clean(error, [this.token(s) ?? '']);
      finish('FAILED', message);
      return { isError: true, content: [{ type: 'text' as const, text: `${server}.${tool} failed: ${message}` }] };
    }
  }
  async close() { for (const s of this.servers.values()) this.drop(s); }
}

export const routerFor = (name: string) => `panter_ds_${name}`;
