import { SqliteLedger } from './sqlite-ledger.js';
/** Self-hosted OAuth authorization boundary for Panter-ai (single-owner preview).
 * No model inference and no third-party identity provider are required.
 * All public clients require PKCE S256 and explicit operator approval.
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isHost, type Host } from './mesh.js';
import { rateLimitIdentity } from './trusted-proxy.js';

const hosts = ['gpt-a', 'gpt-b', 'grok', 'gemini', 'claude'] as const;
const MAX_BODY = 12_288;
const ACCESS_TTL = 60 * 60;
const REFRESH_TTL = 90 * 86400;
const CODE_TTL = 300;
const PENDING_TTL = 600;
const ALLOWED_SCOPES = new Set(['mcp', 'panter:mesh', 'panter:lead', 'offline_access']);
const secureId = (bytes = 32) => randomBytes(bytes).toString('base64url');
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const ts = () => Math.floor(Date.now() / 1000);
/** Errors raised by check() carry fixed, operator-safe messages (never request data). */
class OAuthCheckError extends Error {}
function check(ok: unknown, why: string): asserts ok { if (!ok) throw new OAuthCheckError(why); }
function eq(a: string, b: string): boolean {
  return timingSafeEqual(Buffer.from(hash(a), 'hex'), Buffer.from(hash(b), 'hex'));
}
function validString(value: unknown, max = 256): value is string { return typeof value === 'string' && value.length > 0 && value.length <= max; }
function escapeHtml(s: string) { return s.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!); }
/** RFC 6749 §2.3.1 HTTP Basic client credentials (form-urlencoded id/secret). Empty when absent/malformed. */
function basicClient(req: IncomingMessage): { id: string; secret: string } {
  const h = req.headers.authorization;
  if (!h?.startsWith('Basic ')) return { id: '', secret: '' };
  try {
    const raw = Buffer.from(h.slice(6).trim(), 'base64').toString('utf8'); const i = raw.indexOf(':');
    if (i < 1) return { id: '', secret: '' };
    return { id: decodeURIComponent(raw.slice(0, i).replace(/\+/g, ' ')), secret: decodeURIComponent(raw.slice(i + 1).replace(/\+/g, ' ')) };
  } catch { return { id: '', secret: '' }; }
}
/** Operator-visible reason for a rejected OAuth step. Messages are fixed strings from check(); never secrets. */
function logOAuthReject(stage: string, err: unknown) {
  // Only fixed check() messages are logged. Other errors (e.g. JSON.parse, which quotes
  // part of the request body) may contain credentials, so only their class is recorded.
  const reason = err instanceof OAuthCheckError ? err.message : err instanceof Error ? `unexpected ${err.name}` : 'unknown';
  console.warn(`[oauth] ${stage} rejected: ${reason}`);
}
/**
 * Gemini web returns through Google-owned relay callbacks (/r/ and /a/) that then
 * navigate to gemini.google.com. Chrome enforces the consent page's form-action CSP
 * over the whole redirect chain after a POST, so a 302 to the relay is blocked and
 * Gemini never receives the code. Answer with a no-script HTML handoff instead,
 * decoupling the form submission from the cross-origin navigation (same approach as
 * DevZana). Only these exact Google relay hosts qualify; the URI itself was already
 * validated against the configured callback allowlist.
 */
const GEMINI_RELAY_HOSTS = new Set(['oauth-redirect.googleusercontent.com', 'oauth-redirect-sandbox.googleusercontent.com', 'oauth-redirect-test.googleusercontent.com']);
function isGeminiRelay(uri: string): boolean {
  try { const u = new URL(uri); return u.protocol === 'https:' && GEMINI_RELAY_HOSTS.has(u.hostname) && (u.pathname.startsWith('/r/') || u.pathname.startsWith('/a/')); } catch { return false; }
}
function geminiHandoff(res: ServerResponse, uri: string) {
  const target = escapeHtml(uri);
  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><meta http-equiv="refresh" content="0;url=${target}"><title>Continuar conexión con Gemini</title></head><body style="font:16px system-ui;background:#111827;color:white;max-width:460px;margin:8vh auto;padding:20px"><h2>Completar conexión con Gemini</h2><p>Si el navegador no vuelve automáticamente, usa el enlace.</p><p><a rel="noreferrer noopener" style="color:#93c5fd" href="${target}">Continuar a Gemini</a></p></body></html>`;
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'" });
  res.end(html);
}
function bearer(req: IncomingMessage) { const h = req.headers.authorization; return h?.startsWith('Bearer ') ? h.slice(7) : ''; }
function reply(res: ServerResponse, status: number, data: object, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers });
  res.end(JSON.stringify(data));
}
function redirect(res: ServerResponse, location: string) {
  res.writeHead(302, { location, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }); res.end();
}
async function body(req: IncomingMessage): Promise<URLSearchParams | Record<string, unknown>> {
  const parts: Buffer[] = []; let size = 0;
  for await (const part of req) {
    const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
    size += chunk.length; check(size <= MAX_BODY, 'Request body too large'); parts.push(chunk);
  }
  const raw = Buffer.concat(parts).toString('utf8');
  const contentType = String(req.headers['content-type'] ?? '').split(';')[0]?.trim();
  if (contentType === 'application/json') {
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { throw new OAuthCheckError('Malformed JSON body'); }
    check(parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed), 'Invalid JSON');
    return parsed as Record<string, unknown>;
  }
  check(contentType === 'application/x-www-form-urlencoded', 'Unsupported Content-Type');
  const parsed = new URLSearchParams(raw);
  for (const key of new Set(parsed.keys())) check(parsed.getAll(key).length === 1, 'Duplicate form field');
  return parsed;
}
function field(input: URLSearchParams | Record<string, unknown>, name: string): string {
  const value = input instanceof URLSearchParams ? input.get(name) : input[name];
  return typeof value === 'string' ? value : '';
}
function validateResource(value: string) {
  const url = new URL(value);
  check(url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/mcp', 'Invalid public MCP resource');
  return url.toString();
}
function validateRedirect(value: string) {
  const u = new URL(value);
  check(u.protocol === 'https:' && !u.username && !u.password && !u.hash, 'Invalid redirect URI');
  return u.toString();
}
function params(rawUrl: string) { return new URL(rawUrl, 'http://internal').searchParams; }
function cookie(req: IncomingMessage, name: string) {
  const part = String(req.headers.cookie ?? '').split(';').map(x => x.trim()).find(x => x.startsWith(name + '='));
  return part?.slice(name.length + 1) ?? '';
}
function queryRedirect(uri: string, values: Record<string, string>) {
  const url = new URL(uri);
  for (const [key, value] of Object.entries(values)) url.searchParams.set(key, value);
  return url.toString();
}

type Client = { id: string; name: string; redirectUris: string[]; createdAt: number; secretDigest?: string; authMethod?: ClientAuthMethod };
type ClientAuthMethod = 'none' | 'client_secret_basic' | 'client_secret_post';
const CLIENT_AUTH_METHODS: readonly ClientAuthMethod[] = ['none', 'client_secret_basic', 'client_secret_post'];
type Pending = { id: string; clientId: string; redirectUri: string; challenge: string; state: string; requestedScopes: string[]; csrfDigest: string; expiresAt: number; failures: number; sourceDigest?: string };
type Grant = { clientId: string; host: Host; redirectUri: string; scopes: string[]; approvedAt: number; revoked: boolean };
type Code = { digest: string; clientId: string; host: Host; redirectUri: string; challenge: string; scopes: string[]; expiresAt: number; consumed: boolean };
type Token = { digest: string; familyId: string; clientId: string; host: Host; scopes: string[]; expiresAt: number; kind: 'access' | 'refresh'; revoked: boolean; resource: string };
type Ledger = { version: 1; clients: Client[]; pending: Pending[]; grants: Grant[]; codes: Code[]; tokens: Token[] };
const empty = (): Ledger => ({ version: 1, clients: [], pending: [], grants: [], codes: [], tokens: [] });

export class EmbeddedOAuth {
  readonly issuer: string;
  readonly resource: string;
  private ledger = empty();
  private readonly sqlite: SqliteLedger;
  private serial: Promise<unknown> = Promise.resolve();
  private readonly callbacks: Set<string>;
  private readonly operatorPassword: string;
  private readonly clientIdentity:(req:IncomingMessage)=>string;
  private readonly rate = new Map<string, { count: number; since: number }>();
  private readonly consentCookie = '__Host-panter-consent';
  private constructor(dir: string, resource: string, callbacks: string[], password: string, clientIdentity:(req:IncomingMessage)=>string) {
    this.resource = validateResource(resource);
    this.issuer = new URL(this.resource).origin;
    check(validString(password, 512) && password.length >= 32, 'PANTER_CONSENT_PASSWORD must be at least 32 characters');
    this.operatorPassword = password;
    this.clientIdentity=clientIdentity;
    check(callbacks.length > 0 && callbacks.length <= 30, 'Configure approved OAuth redirect URIs');
    this.callbacks = new Set(callbacks.map(validateRedirect));
    this.sqlite = SqliteLedger.open(dir);
  }
  static async open(cfg: { dir: string; resource: string; redirectUris: string[]; password: string; clientIdentity?:(req:IncomingMessage)=>string }) {
    const provider = new EmbeddedOAuth(cfg.dir, cfg.resource, cfg.redirectUris, cfg.password,
      cfg.clientIdentity??(req=>req.socket.remoteAddress??'unknown'));
    const parsed: Ledger = provider.sqlite.read('oauth', empty());
    check(parsed.version === 1 && Array.isArray(parsed.clients) && Array.isArray(parsed.pending) &&
      Array.isArray(parsed.grants) && Array.isArray(parsed.codes) && Array.isArray(parsed.tokens), 'Invalid OAuth ledger');
    provider.ledger = parsed;
    return provider;
  }
  private async read<T>(fn: (ledger: Ledger) => T): Promise<T> {
    await this.serial;
    this.ledger = this.sqlite.read('oauth', this.ledger);
    return structuredClone(fn(this.ledger));
  }
  private async change<T>(fn: (ledger: Ledger) => T): Promise<T> {
    const next = this.serial.then(() => {
      const { after, result } = this.sqlite.mutate('oauth', this.ledger, fn);
      this.ledger = after;
      return result;
    });
    this.serial = next.then(() => {}, () => {});
    return next;
  }

  protectedResourceMetadata() {
    return { resource: this.resource, authorization_servers: [this.issuer], bearer_methods_supported: ['header'], scopes_supported: [...ALLOWED_SCOPES] };
  }
  authorizationServerMetadata() {
    // RFC 9207: both consent outcomes return the exact `iss` in the redirect.
    // ChatGPT needs this advertised to bind its stable OAuth callback.
    return { issuer: this.issuer, authorization_response_iss_parameter_supported: true, authorization_endpoint: this.issuer + '/authorize', token_endpoint: this.issuer + '/token', registration_endpoint: this.issuer + '/register', revocation_endpoint: this.issuer + '/revoke', response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], token_endpoint_auth_methods_supported: [...CLIENT_AUTH_METHODS], code_challenge_methods_supported: ['S256'], scopes_supported: [...ALLOWED_SCOPES] };
  }
  challenge() {
    return `Bearer realm="panter-ai", resource_metadata="${this.issuer}/.well-known/oauth-protected-resource", scope="mcp"`;
  }
  async authenticate(authHeader: string | undefined): Promise<Host> {
    const raw = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : '';
    check(/^[\w-]{32,150}$/.test(raw), 'Invalid token');
    return this.read(d => {
      const found = d.tokens.find(t => t.digest === hash(raw) && t.kind === 'access' && !t.revoked && t.expiresAt > ts() && t.resource === this.resource);
      check(found && found.scopes.includes('mcp') && found.scopes.includes('panter:mesh'), 'Invalid token');
      check(d.grants.some(g => g.clientId === found.clientId && g.host === found.host && !g.revoked), 'Revoked connection');
      return found.host;
    });
  }
  private throttled(key: string, limit = 10) {
    const now = ts();
    const row = this.rate.get(key);
    if (!row || now - row.since > 3600) {
      if(this.rate.size>=4096){
        for(const [name,item] of this.rate)if(now-item.since>3600)this.rate.delete(name);
        check(this.rate.size<4096,'Rate limiter saturated; retry later');
      }
      this.rate.set(key,{count:1,since:now});return;
    }
    check(row.count < limit, 'Rate limited'); row.count++;
  }
  private async register(raw: URLSearchParams | Record<string, unknown>) {
    check(!(raw instanceof URLSearchParams), 'JSON registration required');
    const input = raw as Record<string, unknown>;
    check(Array.isArray(input.redirect_uris) && input.redirect_uris.length > 0 && input.redirect_uris.length <= 10, 'Redirect URIs required');
    const redirectUris = input.redirect_uris.map(x => validateRedirect(String(x)));
    check(redirectUris.every(u => this.callbacks.has(u)), 'Unapproved redirect URI');
    const authMethod = (input.token_endpoint_auth_method ?? 'none') as ClientAuthMethod;
    check(CLIENT_AUTH_METHODS.includes(authMethod), 'Unsupported client authentication');
    check(input.grant_types === undefined || (Array.isArray(input.grant_types) && input.grant_types.every(x => x === 'authorization_code' || x === 'refresh_token') && input.grant_types.includes('authorization_code')), 'Unsupported grants');
    check(input.response_types === undefined || (Array.isArray(input.response_types) && input.response_types.length === 1 && input.response_types[0] === 'code'), 'Unsupported response type');
    const name = typeof input.client_name === 'string' ? input.client_name.slice(0, 120) : 'MCP client';
    return this.change(d => {
      d.clients=d.clients.filter(c=>c.createdAt>ts()-86400||d.grants.some(g=>g.clientId===c.id));
      check(d.clients.length < 100, 'Registration capacity reached');
      // Confidential clients (e.g. Gemini) get a one-time-displayed secret; only its digest is stored.
      const secret = authMethod === 'none' ? '' : 'ps_' + secureId(32);
      const client: Client = { id: 'pc_' + secureId(24), name, redirectUris, createdAt: ts(), ...(secret ? { secretDigest: hash(secret), authMethod } : {}) };
      d.clients.push(client);
      return { client_id: client.id, client_name: client.name, redirect_uris: client.redirectUris, token_endpoint_auth_method: authMethod, ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}), grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], client_id_issued_at: client.createdAt };
    });
  }
  private async authorize(query: URLSearchParams, clientIp: string) {
    const sourceDigest=hash(rateLimitIdentity(clientIp));
    const clientId = query.get('client_id') ?? '';
    const redirectUri = query.get('redirect_uri') ?? '';
    const challenge = query.get('code_challenge') ?? '';
    const state = query.get('state') ?? '';
    const resource = query.get('resource') ?? this.resource;
    const scope = query.get('scope') ?? 'mcp';
    const scopes = [...new Set(scope.split(' ').filter(Boolean))];
    check(query.get('response_type') === 'code', 'Authorization code only');
    check(resource === this.resource, 'Invalid resource audience');
    check(query.get('code_challenge_method') === 'S256' && /^[A-Za-z0-9_-]{43}$/.test(challenge), 'PKCE S256 is required');
    check(state.length <= 2048 && scopes.length > 0 && scopes.every(s => ALLOWED_SCOPES.has(s)), 'Invalid scopes/state');
    const client = await this.read(d => d.clients.find(c => c.id === clientId));
    check(client && client.redirectUris.includes(redirectUri), 'Unknown client or redirect URI');
    const id = secureId(28); const csrf = secureId(32);
    await this.change(d => {
      d.pending = d.pending.filter(p => p.expiresAt > ts());
      // Do not evict live consent sessions, including when an attacker knows
      // another public client ID. A flood can deny *new* sessions until the TTL,
      // but it can no longer silently invalidate a legitimate open consent.
      check(d.pending.filter(p=>p.sourceDigest===sourceDigest).length<5,
        'Pending consent quota for this source');
      check(d.pending.filter(p=>p.clientId===clientId).length<5,
        'Pending consent quota for this client');
      check(d.pending.length<100,'Too many pending authorizations');
      d.pending.push({ id, clientId, redirectUri, challenge, state, requestedScopes: scopes, csrfDigest: hash(csrf), expiresAt: ts() + PENDING_TTL, failures: 0,sourceDigest });
    });
    return { id, csrf };
  }
  private async consent(id: string) {
    return this.read(d => {
      const pending = d.pending.find(x => x.id === id && x.expiresAt > ts());
      check(pending, 'Consent expired');
      const client = d.clients.find(x => x.id === pending.clientId);
      check(client, 'Client unavailable');
      return { pending, client };
    });
  }
  private async approve(id: string, csrf: string, password: string, host: string, decision: string) {
    const result = await this.change(d => {
      const p = d.pending.find(x => x.id === id && x.expiresAt > ts());
      check(p, 'Consent expired');
      check(p.failures < 6, 'Consent locked');
      if (!eq(hash(csrf), p.csrfDigest)) { p.failures++; return { denied: true }; }
      if (decision === 'allow' && !eq(password, this.operatorPassword)) { p.failures++; return { denied: true }; }
      // For valid approval the one-time request is atomically consumed.
      d.pending = d.pending.filter(x => x.id !== id);
      if (decision === 'deny') return { uri: queryRedirect(p.redirectUri, { error: 'access_denied', state: p.state, iss: this.issuer }) };
      check(decision === 'allow' && isHost(host), 'Choose one approved host');
      const existing = d.grants.find(g => g.clientId === p.clientId && !g.revoked);
      check(!existing || existing.host === host, 'Client cannot switch host without revocation');
      // Clients such as Gemini request every advertised scope. The leader scope is
      // never granted to a non-coordinator host: drop it instead of failing consent.
      const requested = host === 'gpt-a' ? p.requestedScopes : p.requestedScopes.filter(s => s !== 'panter:lead');
      // Operator-approved connections always get a rotating refresh token. ChatGPT does not
      // request offline_access and would otherwise be disconnected when the 1h access token
      // expires; refresh rotation and replay-family revocation still apply.
      const scopes = [...new Set([...requested, 'mcp', 'panter:mesh', 'offline_access'])];
      if (host === 'gpt-a') scopes.push('panter:lead');
      if (!existing) d.grants.push({ clientId: p.clientId, host, redirectUri: p.redirectUri, scopes: [...new Set(scopes)], approvedAt: ts(), revoked: false });
      const code = secureId(32);
      d.codes.push({ digest: hash(code), clientId: p.clientId, host, redirectUri: p.redirectUri, challenge: p.challenge, scopes: [...new Set(scopes)], expiresAt: ts() + CODE_TTL, consumed: false });
      return { uri: queryRedirect(p.redirectUri, { code, state: p.state, iss: this.issuer }) };
    });
    check('uri' in result && typeof result.uri === 'string', 'Approval denied');
    return { uri: result.uri };
  }
  private issue(d: Ledger, clientId: string, host: Host, scopes: string[], family: string = randomUUID()) {
    const now = ts();
    d.codes = d.codes.filter(c => c.expiresAt > now - 86400);
    d.tokens = d.tokens.filter(t => t.expiresAt > now - 86400);
    const access = secureId(32), refresh = scopes.includes('offline_access') ? secureId(48) : '';
    d.tokens.push({ digest: hash(access), familyId: family, clientId, host, scopes, kind: 'access', expiresAt: now + ACCESS_TTL, revoked: false, resource: this.resource });
    if (refresh) d.tokens.push({ digest: hash(refresh), familyId: family, clientId, host, scopes, kind: 'refresh', expiresAt: now + REFRESH_TTL, revoked: false, resource: this.resource });
    return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL, scope: scopes.join(' '), ...(refresh ? { refresh_token: refresh } : {}) };
  }
  private async exchange(input: URLSearchParams | Record<string, unknown>, basic: { id: string; secret: string } = { id: '', secret: '' }) {
    const grant = field(input, 'grant_type'); const bodyId = field(input, 'client_id');
    check(!(basic.id && bodyId && basic.id !== bodyId), 'Conflicting client credentials');
    const clientId = basic.id || bodyId; const secret = basic.secret || field(input, 'client_secret');
    check(validString(clientId), 'client_id required');
    const authed = await this.read(d => d.clients.find(c => c.id === clientId));
    if (authed?.secretDigest) check(secret.length >= 32 && eq(hash(secret), authed.secretDigest), 'Invalid client secret');
    if (grant === 'authorization_code') {
      const code = field(input, 'code'), verifier = field(input, 'code_verifier'), redirectUri = field(input, 'redirect_uri');
      check(/^[A-Za-z0-9_-]{43,128}$/.test(verifier), 'Invalid PKCE verifier');
      check(field(input, 'resource') === '' || field(input, 'resource') === this.resource, 'Wrong resource audience');
      return this.change(d => {
        const record = d.codes.find(c => c.digest === hash(code) && c.clientId === clientId && !c.consumed && c.expiresAt > ts());
        check(record && record.redirectUri === redirectUri, 'Invalid or reused authorization code');
        const actual = createHash('sha256').update(verifier).digest('base64url');
        check(eq(record.challenge, actual), 'PKCE verification failed');
        const connection = d.grants.find(g => g.clientId === clientId && g.host === record.host && !g.revoked);
        check(connection, 'Connection revoked');
        record.consumed = true;
        return this.issue(d, clientId, record.host, record.scopes);
      });
    }
    if (grant === 'refresh_token') {
      const refresh = field(input, 'refresh_token');
      check(refresh.length >= 32, 'Missing refresh token');
      return this.change(d => {
        const token = d.tokens.find(t => t.digest === hash(refresh) && t.clientId === clientId && t.kind === 'refresh');
        check(token, 'Invalid refresh token');
        if (token.revoked) {
          for (const row of d.tokens) if (row.familyId === token.familyId) row.revoked = true;
          // persisted replay rejection; no new tokens issued
          return { error: 'invalid_grant' };
        }
        check(token.expiresAt > ts(), 'Expired refresh token');
        const connection = d.grants.find(g => g.clientId === clientId && g.host === token.host && !g.revoked);
        check(connection, 'Connection revoked');
        const requested = field(input, 'scope').split(' ').filter(Boolean);
        check(requested.every(s => token.scopes.includes(s)), 'Scope escalation denied');
        token.revoked = true;
        return this.issue(d, clientId, token.host, requested.length > 0 ? requested : token.scopes, token.familyId);
      });
    }
    throw new OAuthCheckError('Unsupported grant_type');
  }
  /** Only expose this through the authenticated operator MCP, never over public OAuth. */
  listClients(){
    return this.read(d=>d.clients.map(c=>{
      const grants=d.grants.filter(g=>g.clientId===c.id);
      return {clientId:c.id,name:c.name,createdAt:c.createdAt,redirectUris:c.redirectUris,
        approvedHosts:[...new Set(grants.filter(g=>!g.revoked).map(g=>g.host))],
        revoked:grants.length>0&&grants.every(g=>g.revoked)};
    }));
  }
  async revokeClient(clientId: string) {
    check(/^pc_[A-Za-z0-9_-]{24,64}$/.test(clientId),'Invalid client identifier');
    return this.change(d => {
      const grants = d.grants.filter(g => g.clientId === clientId);
      for (const g of grants) g.revoked = true;
      for (const row of d.tokens) if (row.clientId === clientId) row.revoked = true;
      d.codes=d.codes.filter(c=>c.clientId!==clientId);
      d.pending=d.pending.filter(p=>p.clientId!==clientId);
      return grants.length;
    });
  }
  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const path = (req.url ?? '').split('?')[0] ?? '';
    if (req.method === 'GET' && (path === '/.well-known/oauth-protected-resource' || path === '/.well-known/oauth-protected-resource/mcp')) {
      reply(res, 200, this.protectedResourceMetadata()); return true;
    }
    if (req.method === 'GET' && path === '/.well-known/oauth-authorization-server') {
      reply(res, 200, this.authorizationServerMetadata()); return true;
    }
    if (req.method === 'POST' && path === '/register') {
      try { this.throttled(`register:${rateLimitIdentity(this.clientIdentity(req))}`, 20); const registered = await this.register(await body(req)); reply(res, 201, registered); }
      catch (err) { logOAuthReject('register', err); reply(res, 400, { error: 'invalid_client_metadata', error_description: err instanceof Error ? err.message : 'Invalid request' }); }
      return true;
    }
    if (req.method === 'GET' && path === '/authorize') {
      try {
        this.throttled(`authorize:${rateLimitIdentity(this.clientIdentity(req))}`,60);
        const { id, csrf } = await this.authorize(params(req.url ?? ''),this.clientIdentity(req));
        res.setHeader('Set-Cookie', `${this.consentCookie}=${csrf}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600`);
        redirect(res, `/oauth/consent?sid=${encodeURIComponent(id)}`);
      } catch (err) { logOAuthReject('authorize', err); reply(res, 400, { error: 'invalid_request' }); }
      return true;
    }
    if (path === '/oauth/consent' && req.method === 'GET') {
      try {
        const id = params(req.url ?? '').get('sid') ?? '';
        const { pending, client } = await this.consent(id);
        const csrf = cookie(req, this.consentCookie);
        check(csrf.length > 30 && eq(hash(csrf), pending.csrfDigest), 'Invalid consent session');
        // A registration is not an authorization to redirect to arbitrary origins.
        // Use ONLY the pending request's exact, previously approved callback origin.
        check(this.callbacks.has(pending.redirectUri) && client.redirectUris.includes(pending.redirectUri), 'Unapproved consent redirect');
        const callbackOrigin = new URL(pending.redirectUri).origin;
        const options = hosts.map(h => `<option value="${h}">${h.toUpperCase()}</option>`).join('');
        const ageMinutes=Math.max(0,Math.floor((ts()-client.createdAt)/60));
        const html = `<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Panter-ai · Autorizar conexión</title><style>body{font:16px system-ui;max-width:460px;margin:8vh auto;padding:20px;background:#111827;color:white}main{background:#1f2937;border-radius:12px;padding:24px}input,select,button{display:block;width:100%;padding:10px;margin:12px 0;box-sizing:border-box}.warning{border:1px solid #f4b400;padding:12px;color:#fff}</style><main><h2>Autorizar conexión a Panter-ai</h2><p class="warning"><strong>Cliente NO VERIFICADO.</strong> El nombre y callback pueden ser declarados por otra persona. Una URL de redirección conocida no demuestra que sea tu sesión de ChatGPT o Claude. Confirma la solicitud desde la aplicación que tú abriste; si no la iniciaste, pulsa Denegar.</p><p>Nombre declarado (no verificado): ${escapeHtml(client.name)}</p><p>Identificador de registro: ${escapeHtml(client.id)}</p><p>Registrado hace aproximadamente ${ageMinutes} minutos</p><p>Destino de redirección: ${escapeHtml(pending.redirectUri)}</p><form method="post" action="/oauth/consent?sid=${encodeURIComponent(id)}"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><label>Host autorizado<select name="host">${options}</select></label><label>Clave del operador<input name="password" type="password" required autocomplete="off"></label><button name="decision" value="allow">Autorizar</button><button name="decision" value="deny">Denegar</button></form></main></html>`;
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff', 'content-security-policy': `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${callbackOrigin}; base-uri 'none'; frame-ancestors 'none'` }); res.end(html);
      } catch (err) { logOAuthReject('consent-page', err); reply(res, 400, { error: 'invalid_request' }); }
      return true;
    }
    if (path === '/oauth/consent' && req.method === 'POST') {
      try {
        const origin = String(req.headers.origin ?? '');
        const fromSameOrigin = req.headers['sec-fetch-site'] === 'same-origin';
        check(origin === this.issuer || ((origin === '' || origin === 'null') && fromSameOrigin), 'Invalid Origin');
        // Bound all POST attempts from an IP (including invalid sids) before
        // allocating a per-session rate key. An arbitrary sid MUST NOT create a
        // new rate-map entry; valid sessions are bounded by the pending ledger.
        this.throttled(`consent-ip:${rateLimitIdentity(this.clientIdentity(req))}`, 60);
        const id = params(req.url ?? '').get('sid') ?? '';
        check(/^[A-Za-z0-9_-]{38}$/.test(id),'Invalid consent session ID');
        await this.consent(id); // validate existence and expiry before slot quota
        this.throttled(`consent:${id}`, 6);
        const payload = await body(req);
        const result = await this.approve(id, field(payload, 'csrf'), field(payload, 'password'), field(payload, 'host'), field(payload, 'decision'));
        res.setHeader('Set-Cookie', `${this.consentCookie}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`);
        if (isGeminiRelay(result.uri)) geminiHandoff(res, result.uri); else redirect(res, result.uri);
      } catch (err) { logOAuthReject('consent-submit', err); reply(res, 403, { error: 'access_denied' }); }
      return true;
    }
    if (path === '/token' && req.method === 'POST') {
      try { this.throttled(`token:${rateLimitIdentity(this.clientIdentity(req))}`, 100); const result = await this.exchange(await body(req), basicClient(req)); reply(res, 'error' in result ? 400 : 200, result); }
      catch (err) { logOAuthReject('token', err); reply(res, 400, { error: 'invalid_grant' }); }
      return true;
    }
    if (path === '/revoke' && req.method === 'POST') {
      try {
        // RFC 7009 allows unauthenticated public clients to revoke a token they
        // possess. The opaque token is the capability; invalid values remain 200.
        // Rate-limit the endpoint and avoid rewriting the full ledger for misses.
        this.throttled(`revoke:${rateLimitIdentity(this.clientIdentity(req))}`,100);
        this.throttled('revoke:global',5000);
        const input = await body(req); const basic = basicClient(req); const bodyId = field(input, 'client_id');
        check(!(basic.id && bodyId && basic.id !== bodyId), 'Conflicting client credentials');
        const clientId = basic.id || bodyId; const token = field(input, 'token');
        check(/^pc_[A-Za-z0-9_-]{24,64}$/.test(clientId)&&token.length>=32&&token.length<=200,'Invalid revocation request');
        const owner = await this.read(d => d.clients.find(c => c.id === clientId));
        if (owner?.secretDigest) { const sec = basic.secret || field(input, 'client_secret'); check(sec.length >= 32 && eq(hash(sec), owner.secretDigest), 'Invalid client secret'); }
        const digest=hash(token);
        const matchingFamily=await this.read(d=>d.tokens.find(t=>t.digest===digest&&t.clientId===clientId&&!t.revoked)?.familyId??null);
        if(matchingFamily)await this.change(d=>{
          const found=d.tokens.find(t=>t.digest===digest&&t.clientId===clientId&&!t.revoked);
          if(found)for(const row of d.tokens)if(row.familyId===found.familyId)row.revoked=true;
        });
        reply(res, 200, {});
      } catch (err) { logOAuthReject('revoke', err); reply(res, 400, { error: 'invalid_request' }); }
      return true;
    }
    return false;
  }
}
