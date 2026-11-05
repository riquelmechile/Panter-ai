/**
 * Downstream MCP gateway: other MCP servers (each in its own repository and service) mounted behind Panter.
 *
 * The operator lists them in a JSON file (PANTER_DOWNSTREAM_CONFIG). Panter connects to each one with a token only it
 * holds, caches its tools, and exposes it to the hosts allowed to use it as one router tool (`panter_ds_<name>`).
 * Every call is classified from the downstream tool's own annotations (MCP defaults: a tool is destructive unless it
 * says otherwise) and gated by the server's write policy and Panter's write grants, then forwarded with a timeout and
 * a circuit breaker, and audited. The downstream server keeps its own approvals on top (a double lock).
 *
 * Each forwarded call carries a signed actor assertion (`_meta["panter-ai/actor"]`, see actor-assertion.ts) so the
 * downstream server knows which host, in which role and mission, is calling, instead of only seeing "Panter".
 *
 * A server marked `sensitive` (patient data, for example) is proxied without keeping its content: Panter forwards
 * the call and hands the answer back, but stores no argument hash and no error text from it (audit, status and logs
 * keep only metadata), every call must name its mission, and that mission becomes sensitive: Panter then refuses to
 * store personal or clinical data for it anywhere else (reports, tasks, results, messages, memory).
 */
import { Client, StreamableHTTPClientTransport, SdkError, SdkErrorCode, ProtocolError } from '@modelcontextprotocol/client';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import type { SqliteLedger } from './sqlite-ledger.js';
import { ACTOR_TTL_SECONDS, ActorSigner, argsDigest, type ActorRole } from './actor-assertion.js';

export type WritePolicy = 'deny' | 'grant' | 'allow';
export type ToolClass = 'read' | 'write' | 'destructive';
export type DownstreamConfig = {
  name: string; url: string; tokenEnv: string | null; hosts: string[]; writes: WritePolicy; timeoutMs: number; description: string;
  /** Proxy only: keep no content of this server's calls (no argument hash, no error text) and make the mission sensitive. */
  sensitive: boolean;
};
export type DownstreamTool = { name: string; description: string; inputSchema: unknown; cls: ToolClass };
export type DownstreamGrant = {
  id: string; server: string; tools: string[] | '*'; host: string; reason: string; createdAt: string; expiresAt: string;
  usesLeft: number; revokedAt: string | null;
};
export type DownstreamAudit = {
  at: string; host: string; server: string; tool: string; cls: ToolClass; grantId: string | null; outcome: 'OK' | 'TOOL_ERROR' | 'REFUSED' | 'FAILED';
  ms: number; argsSha256: string | null; error: string | null; role?: ActorRole; missionId?: string | null; sensitive?: boolean;
};
export type SensitiveMission = { id: string; server: string; host: string; at: string };
type Data = { version: 1; grants: DownstreamGrant[]; audit: DownstreamAudit[]; hashKey?: string; signingKey?: string };
const seed: Data = { version: 1, grants: [], audit: [] };
/** Sensitive missions live in their own ledger, apart from the bounded audit: a mark is never dropped. */
type Marks = { version: 1; missions: SensitiveMission[] };
const marksSeed: Marks = { version: 1, missions: [] };

const NAME = /^[a-z][a-z0-9]{1,23}$/;
const TOKEN_ENV = /^PANTER_DOWNSTREAM_[A-Z0-9_]{1,60}$/;
const MAX_SERVERS = 16, MAX_TOOLS = 200, MAX_AUDIT = 2000, MAX_RESULT_BYTES = 2_000_000, MAX_SENSITIVE_MISSIONS = 100_000;
/** A mission id as harness runs and mesh work use them. */
export const MISSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
/** Harness run ids are lowercase UUIDs: the same id written in upper case is the same mission. */
export const normalizeMission = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ? id.toLowerCase() : id;
/** Any single HTTP response from a downstream server (a result, a tools page) is cut off past this many bytes. */
const MAX_RESPONSE_BYTES = 4_000_000, MAX_SCHEMA_BYTES = 64_000;
const FAILURES_TO_OPEN = 3, OPEN_MS = 30_000;
/** Tools are fetched again before a call when the cached list is older than this, so a changed annotation counts. */
const FRESH_MS = 60_000;
const iso = (ms = Date.now()) => new Date(ms).toISOString();
/** Error text safe to show and store: secrets removed from the whole text first, then one line, bounded. */
export const clean = (e: unknown, secrets: string[] = []) => {
  let s = e instanceof Error ? e.message : String(e);
  for (const x of secrets) if (x) s = s.split(x).join('[redacted]');
  return s.replace(/\s+/g, ' ').slice(0, 300);
};
/** The call a request belongs to: guarded() puts its own id in the request's _meta. */
const callIdOf = (body: unknown): string | null => {
  if (typeof body !== 'string' || body.length > 1_000_000) return null;
  try { const id = JSON.parse(body)?.params?._meta?.['panter-ai/callId']; return typeof id === 'string' ? id : null; } catch { return null; }
};
/** fetch that refuses redirects and stops reading a response past MAX_RESPONSE_BYTES, telling `cut` which call it was. */
const limitedFetch = (cut: (callId: string | null) => void) => async (url: string | URL, init?: RequestInit): Promise<Response> => {
  const callId = callIdOf(init?.body);
  const res = await fetch(url, { ...init, redirect: 'error' });
  if (!res.body) return res;
  let seen = 0;
  const cap = new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, ctl) {
    seen += chunk.byteLength;
    if (seen > MAX_RESPONSE_BYTES) { cut(callId); ctl.error(new Error(`response larger than ${MAX_RESPONSE_BYTES} bytes`)); } else ctl.enqueue(chunk);
  } });
  return new Response(res.body.pipeThrough(cap), { status: res.status, statusText: res.statusText, headers: res.headers });
};
/** An error whose message is already safe to show and store (cleaned, or withheld for a sensitive server). */
class SafeError extends Error {}
/** After a failed tool-list fetch, calls fail fast (closed) for this long before Panter asks again. */
const REFRESH_RETRY_MS = 10_000;

/** http only to this machine or a private network; https anywhere. */
function allowedUrl(raw: string): boolean {
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  // No credentials anywhere in the address: the token travels only in the Authorization header.
  if (u.username || u.password || u.hash || u.search) return false;
  if (u.protocol === 'https:') return true;
  if (u.protocol !== 'http:') return false;
  // Plain http only to a literal private address (a name like 10.evil.example is not one) or localhost.
  const h = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost') return true;
  if (isIP(h) === 4) {
    const [a, b] = h.split('.').map(Number) as [number, number];
    return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
  }
  if (isIP(h) === 6) return h === '::1' || /^f[cd][0-9a-f]{2}:/.test(h);
  return false;
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
    const allowed = new Set(['name', 'url', 'tokenEnv', 'hosts', 'writes', 'timeoutMs', 'description', 'sensitive']);
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
    if (s.sensitive !== undefined && typeof s.sensitive !== 'boolean') throw new Error(`${where}: sensitive must be true or false`);
    return { name: s.name, url: s.url, tokenEnv: s.tokenEnv ?? null, hosts: [...new Set<string>(hosts)], writes, timeoutMs, description: s.description ?? '',
      sensitive: s.sensitive ?? false };
  });
}

/** MCP tool annotations: read-only only when it says so; otherwise destructive unless it says it is not. */
export function classify(annotations: { readOnlyHint?: unknown; destructiveHint?: unknown } | undefined): ToolClass {
  if (annotations?.readOnlyHint === true) return 'read';
  return annotations?.destructiveHint === false ? 'write' : 'destructive';
}

type ServerState = {
  config: DownstreamConfig; tools: DownstreamTool[]; fetchedAt: string | null; fetchedMs: number; failures: number; openUntil: number;
  lastError: string | null; client: Promise<Client> | null; refreshing: Promise<{ server: string; tools: number }> | null;
  refreshFailedMs: number; refreshError: string | null; cutCalls: Set<string>;
};
/** Who is calling: the authenticated host (or "admin"), whether it is the operator, and its Panter role. */
export type Caller = { id: string; operator: boolean; role?: ActorRole };
const roleOf = (c: Caller): ActorRole => c.role ?? (c.operator ? 'operator' : 'worker');

export class DownstreamGateway {
  private readonly servers = new Map<string, ServerState>();
  constructor(configs: DownstreamConfig[], private readonly db: SqliteLedger | null,
    private readonly env: Record<string, string | undefined> = process.env, private readonly now: () => number = Date.now) {
    for (const config of configs) this.servers.set(config.name, { config, tools: [], fetchedAt: null, fetchedMs: 0, failures: 0, openUntil: 0, lastError: null, client: null, refreshing: null, refreshFailedMs: 0, refreshError: null, cutCalls: new Set() });
    // Load the sensitive missions now, so the checks other stores run inside their own transactions read no database.
    if (this.servers.size) this.sensitiveSet();
  }
  get configured(): boolean { return this.servers.size > 0; }
  isSensitiveServer(name: string): boolean { return !!this.servers.get(name)?.config.sensitive; }
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
      // No redirects (the token is only ever sent to the configured address) and bounded responses.
      const transport = new StreamableHTTPClientTransport(new URL(s.config.url),
        { fetch: limitedFetch(id => { if (id && s.cutCalls.size < 1000) s.cutCalls.add(id); }) as any, requestInit: token ? { headers: { authorization: `Bearer ${token}` } } : {} });
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
  /** Close a connection, but only if it is still the server's current one (never one another call reopened). */
  private drop(s: ServerState, which: Promise<Client> | null) {
    if (!which || s.client !== which) return;
    s.client = null;
    which.then(x => x.close()).catch(() => undefined);
  }
  private readonly failedConnections = new WeakSet<Promise<Client>>();
  private secrets(s: ServerState): string[] { const t = this.token(s); return t ? [`Bearer ${t}`, t] : []; }
  /** The text of an error that may be shown and stored: cleaned, or for a sensitive server only its kind (a
   * downstream error message can echo the call's content). */
  private describe(s: ServerState, error: unknown): string {
    if (error instanceof SafeError) return error.message;
    if (!s.config.sensitive) return clean(error, this.secrets(s));
    if (error instanceof ProtocolError) return 'the server answered with an error (details withheld: sensitive server)';
    if (error instanceof SdkError && error.code === SdkErrorCode.RequestTimeout) return 'timed out';
    return 'transport error (details withheld: sensitive server)';
  }
  /** Run one transport operation under the circuit breaker. A slow call only fails itself: the shared connection is
   * closed (and a failure counted) only for a broken connection, and only once per connection. */
  private async guarded<T>(s: ServerState, op: (c: Client, callId: string) => Promise<T>): Promise<T> {
    if (this.now() < s.openUntil) throw new SafeError(`circuit open until ${iso(s.openUntil)} after ${s.failures} failures: ${s.lastError ?? ''}`);
    const used = this.connect(s), callId = randomUUID();
    try {
      const result = await op(await used, callId);
      s.cutCalls.delete(callId);
      s.failures = 0; s.lastError = null; s.openUntil = 0;
      return result;
    } catch (error) {
      // An oversized response is the server's answer being refused, not a transport failure (the SDK only notices
      // it at the timeout): it fails this call alone, says why, and counts nothing.
      if (s.cutCalls.delete(callId)) throw new SafeError(`response larger than ${MAX_RESPONSE_BYTES} bytes`);
      const message = this.describe(s, error);
      // A JSON-RPC error is the server answering: the connection is fine and nothing counts.
      if (error instanceof ProtocolError) throw new SafeError(message);
      const timeout = error instanceof SdkError && error.code === SdkErrorCode.RequestTimeout;
      // Calls that fail together because one connection broke count once (one failure per connection).
      if (timeout || !this.failedConnections.has(used)) {
        if (!timeout) this.failedConnections.add(used);
        s.failures++; s.lastError = message;
        if (s.failures >= FAILURES_TO_OPEN) s.openUntil = this.now() + OPEN_MS;
      }
      if (!timeout) this.drop(s, used);
      throw new SafeError(message);
    }
  }
  /** Fetch and cache a server's tools (all pages, bounded). */
  async refresh(name: string): Promise<{ server: string; tools: number }> {
    const s = this.state(name);
    // Concurrent refreshes of one server share a single tools/list.
    if (s.refreshing) return s.refreshing;
    s.refreshing = this.fetchTools(s)
      .then(r => { s.refreshFailedMs = 0; s.refreshError = null; return r; },
        e => { s.refreshFailedMs = this.now(); s.refreshError = this.describe(s, e); throw e; })
      .finally(() => { s.refreshing = null; });
    return s.refreshing;
  }
  private async fetchTools(s: ServerState): Promise<{ server: string; tools: number }> {
    const name = s.config.name;
    const tools = await this.guarded(s, async (c, callId) => {
      const out: DownstreamTool[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 20; page++) {
        const r = await c.listTools({ ...(cursor ? { cursor } : {}), _meta: { 'panter-ai/callId': callId } } as any, { timeout: s.config.timeoutMs } as any);
        for (const t of r.tools) {
          if (out.length >= MAX_TOOLS) break;
          if (typeof t.name !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(t.name)) continue;
          const schema = t.inputSchema ?? { type: 'object' };
          out.push({ name: t.name, description: String(t.description ?? '').slice(0, 2000),
            inputSchema: Buffer.byteLength(JSON.stringify(schema)) > MAX_SCHEMA_BYTES ? { type: 'object', description: 'schema too large to show' } : schema,
            cls: classify(t.annotations as any) });
        }
        cursor = r.nextCursor;
        if (!cursor || out.length >= MAX_TOOLS) break;
      }
      return out;
    });
    s.tools = tools; s.fetchedAt = iso(this.now()); s.fetchedMs = this.now();
    return { server: name, tools: tools.length };
  }
  async refreshAll(): Promise<Array<{ server: string; tools?: number; error?: string }>> {
    return Promise.all(this.names().map(n => this.refresh(n).catch(e => ({ server: n, error: this.describe(this.state(n), e) }))));
  }
  tools(name: string): DownstreamTool[] { return this.state(name).tools; }
  status(caller: Caller) {
    const t = this.now();
    return this.names().filter(n => this.allowed(caller, n)).map(n => {
      const s = this.state(n);
      return { server: n, description: s.config.description, writes: s.config.writes, sensitive: s.config.sensitive, hosts: s.config.hosts, timeoutMs: s.config.timeoutMs,
        state: s.config.tokenEnv && !this.token(s) ? 'TOKEN_MISSING' : t < s.openUntil ? 'CIRCUIT_OPEN' : s.lastError ? 'DEGRADED' : s.fetchedAt ? 'OK' : 'NOT_CONTACTED',
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
  /** Calls refused because the caller may not use the server at all (since start, in memory). */
  private readonly outsiders = new Map<string, { host: string; server: string; refused: number; lastAt: string }>();
  refusedOutsiders(caller: Caller) { return [...this.outsiders.values()].filter(x => this.allowed(caller, x.server)); }
  /** Grants and audit of the servers this caller may use (the operator sees all). */
  grants(caller: Caller): DownstreamGrant[] { return this.db ? this.db.read<Data>('downstream', seed).grants.filter(g => this.allowed(caller, g.server)) : []; }
  audit(caller: Caller, filter: { server?: string; limit?: number } = {}): DownstreamAudit[] {
    if (!this.db) return [];
    const all = this.db.read<Data>('downstream', seed).audit.filter(a => this.allowed(caller, a.server) && (!filter.server || a.server === filter.server));
    return all.slice(-(filter.limit ?? 100)).reverse();
  }
  /** Arguments are audited as a keyed hash (the key lives in the ledger), so short values cannot be guessed back. */
  private hashKey: string | null = null;
  private argsHash(args: Record<string, unknown>): string {
    if (!this.hashKey) this.hashKey = this.db ? this.db.mutate<Data, string>('downstream', seed, d => (d.hashKey ??= randomBytes(32).toString('hex'))).result
      : randomBytes(32).toString('hex');
    return createHmac('sha256', this.hashKey).update(JSON.stringify(args)).digest('hex');
  }
  /** The Ed25519 key that signs actor assertions, made once and kept in the ledger (an ephemeral one without it). */
  private signerCache: ActorSigner | null = null;
  private signer(): ActorSigner {
    if (this.signerCache) return this.signerCache;
    if (!this.db) return this.signerCache = ActorSigner.generate();
    const saved = this.db.mutate<Data, string>('downstream', seed, d => (d.signingKey ??= ActorSigner.generate().exportPkcs8())).result;
    return this.signerCache = ActorSigner.fromPkcs8(saved);
  }
  /** Public keys that verify actor assertions, as a JWK set (served at /.well-known/panter-downstream-keys). */
  actorKeys() { return { keys: [this.signer().jwk()] }; }
  /** Whether any configured server is sensitive (memory saves are then checked for personal data). */
  get hasSensitive(): boolean { return [...this.servers.values()].some(s => s.config.sensitive); }
  /** Missions that called a sensitive server, cached from the ledger. */
  private sensitiveCache: Set<string> | null = null;
  private sensitiveSet(): Set<string> {
    if (!this.sensitiveCache) this.sensitiveCache = new Set(this.db ? this.db.read<Marks>('downstream_sensitive', marksSeed).missions.map(m => m.id) : []);
    return this.sensitiveCache;
  }
  isSensitiveMission(id: string | null | undefined): boolean { return !!id && this.sensitiveSet().has(normalizeMission(id)); }
  /** Operator: clear a mission's sensitive mark (a mission marked by mistake, or by a host naming another's run). */
  unmarkSensitive(id: string): { unmarked: boolean } {
    const key = normalizeMission(id);
    const unmarked = this.db ? this.db.mutate<Marks, boolean>('downstream_sensitive', marksSeed, d => {
      const before = d.missions.length; d.missions = d.missions.filter(m => m.id !== key); return d.missions.length < before;
    }).result : this.sensitiveSet().has(key);
    this.sensitiveSet().delete(key);
    return { unmarked };
  }
  /** Sensitive missions of the servers this caller may use. */
  sensitiveMissions(caller: Caller): SensitiveMission[] {
    return this.db ? this.db.read<Marks>('downstream_sensitive', marksSeed).missions.filter(m => this.allowed(caller, m.server)) : [];
  }
  /** Mark a mission sensitive, durably, before anything comes back. Throws (the call is refused) rather than drop
   * an old mark when the list is full. */
  private markSensitive(id: string, server: string, host: string) {
    const set = this.sensitiveSet();
    if (set.has(id)) return;
    if (set.size >= MAX_SENSITIVE_MISSIONS) throw new Error(`${MAX_SENSITIVE_MISSIONS} sensitive missions are marked; Panter refuses new ones rather than forget an old mark`);
    this.db?.mutate<Marks, void>('downstream_sensitive', marksSeed, d => {
      if (!d.missions.some(m => m.id === id)) d.missions.push({ id, server, host, at: iso(this.now()) });
    });
    set.add(id);
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

  /** Forward one tool call. Refusals and failures are audited and come back as tool errors, never thrown.
   * `missionId` names the mission the call belongs to (required for a sensitive server); it travels in the signed
   * actor assertion. */
  async call(caller: Caller, server: string, tool: string, args: Record<string, unknown>, grantId?: string,
    opts: { missionId?: string } = {}) {
    const started = this.now();
    const s = this.servers.get(server);
    const sensitive = !!s?.config.sensitive, missionId = opts.missionId === undefined ? null : normalizeMission(opts.missionId), role = roleOf(caller);
    // A sensitive server's arguments are not even hashed: a hash of a short value (a RUT) can be guessed back.
    const argsSha256 = sensitive ? null : this.argsHash(args);
    let cls: ToolClass = 'destructive', usedGrant: string | null = null;
    const mark = <T extends { isError?: boolean; _meta?: Record<string, unknown> }>(r: T): T =>
      sensitive ? { ...r, _meta: { ...(r._meta ?? {}), 'panter-ai/sensitive': true } } : r;
    const finish = (outcome: DownstreamAudit['outcome'], error: string | null) =>
      this.record({ at: iso(started), host: caller.id, server, tool, cls, grantId: usedGrant, outcome, ms: this.now() - started, argsSha256, error,
        role, missionId: missionId !== null && MISSION_ID.test(missionId) ? missionId : null, ...(sensitive ? { sensitive: true } : {}) });
    const fail = (message: string) => mark({ isError: true, content: [{ type: 'text' as const, text: message }] });
    const refuse = (message: string) => { finish('REFUSED', message); return fail(message); };
    // A caller with no access is counted, not written to the audit one call at a time (it could flood it).
    if (!s || !this.allowed(caller, server)) {
      const key = `${caller.id} ${server}`, c = this.outsiders.get(key);
      this.outsiders.set(key, { host: caller.id, server, refused: (c?.refused ?? 0) + 1, lastAt: iso(started) });
      if (this.outsiders.size > 200) this.outsiders.delete(this.outsiders.keys().next().value!);
      return { isError: true, content: [{ type: 'text' as const, text: `${caller.id} may not use downstream server "${server}"` }] };
    }
    if (missionId !== null && !MISSION_ID.test(missionId)) return refuse('missionId must be 1-120 letters, digits or . _ : -');
    if (sensitive && missionId === null) return refuse(`${server} is a sensitive server: every call must name its missionId (a harness run id, for example)`);
    // A stale list is fetched again first: the class of a tool is read from what the server says now. If that fails
    // the call fails too (fail closed): an old "read" must never let a tool that became destructive through.
    if (!s.fetchedAt || this.now() - s.fetchedMs > FRESH_MS) {
      // Right after a failed fetch, fail fast instead of making every call wait for another one.
      if (s.refreshFailedMs && this.now() - s.refreshFailedMs < REFRESH_RETRY_MS) {
        finish('FAILED', s.refreshError); return fail(`${server}: could not read its tool list: ${s.refreshError ?? ''}`);
      }
      try { await this.refresh(server); }
      catch (error) { const message = this.describe(s, error); finish('FAILED', message); return fail(`${server}: could not read its tool list: ${message}`); }
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
    // From here the answer may hold sensitive data: the mission is sensitive before anything comes back.
    if (sensitive) { try { this.markSensitive(missionId!, server, caller.id); } catch (error) { return refuse(clean(error)); } }
    const digest = argsDigest(args);
    try {
      const result = await this.guarded(s, (c, callId) => {
        const iat = Math.floor(this.now() / 1000);
        const actor = this.signer().sign({ iss: 'panter-ai', aud: server, sub: caller.id, role, ...(missionId ? { mission: missionId } : {}),
          jti: callId, tool, args: digest, iat, exp: iat + ACTOR_TTL_SECONDS });
        return c.callTool({ name: tool, arguments: args,
          _meta: { 'panter-ai/callId': callId, 'panter-ai/host': caller.id, 'panter-ai/role': role, 'panter-ai/actor': actor,
            ...(missionId ? { 'panter-ai/missionId': missionId } : {}), ...(usedGrant ? { 'panter-ai/grantId': usedGrant } : {}) } } as any,
          { timeout: s.config.timeoutMs } as any);
      });
      if (Buffer.byteLength(JSON.stringify(result)) > MAX_RESULT_BYTES) { finish('FAILED', 'result too large'); return fail(`${server}.${tool} returned more than ${MAX_RESULT_BYTES} bytes`); }
      finish(result.isError ? 'TOOL_ERROR' : 'OK', null);
      // Whatever the server sends back (an error echoing headers included) reaches the host without the token.
      return mark(redactDeep(result, this.secrets(s)) as typeof result);
    } catch (error) {
      const message = this.describe(s, error);
      finish('FAILED', message);
      return fail(`${server}.${tool} failed: ${message}`);
    }
  }
  async close() { for (const s of this.servers.values()) this.drop(s, s.client); }
}

export const routerFor = (name: string) => `panter_ds_${name}`;

/** The value with every occurrence of the secrets removed, at any depth: done on its JSON text (raw and as JSON
 * escapes it), so nothing is left unvisited. */
export function redactDeep(value: unknown, secrets: string[]): unknown {
  const list = secrets.filter(Boolean);
  if (!list.length || value === undefined) return value;
  let text = JSON.stringify(value);
  for (const x of list) for (const form of new Set([x, JSON.stringify(x).slice(1, -1)])) text = text.split(form).join('[redacted]');
  return JSON.parse(text);
}
