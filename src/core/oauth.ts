/** OAuth 2.1 resource-server verification against an operator-controlled external IdP.
 * The identity provider owns browser consent, PKCE, token issuance and rotation.
 * This module never implements a password form, DCR, or a model API.
 */
import { createPublicKey, verify, type KeyObject, timingSafeEqual, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Host } from './mesh.js';
import { isHost } from './mesh.js';

const MAX_TOKEN_BYTES = 16_384;
const CLOCK_SKEW_SECONDS = 30;
const jwtPattern = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const HOST_ROLES = ['gpt-a', 'gpt-b', 'grok', 'gemini', 'claude'] as const;

type JsonRecord = Record<string, unknown>;
export type BoundActor = { host: Host; subject: string; clientId: string };
export type OAuthSettings = { issuer: string; resource: string; keysFile: string; actorsFile: string };
function ensure(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }
function record(x: unknown): x is JsonRecord { return !!x && typeof x === 'object' && !Array.isArray(x); }
function exactHttpsUrl(url: string, label: string) {
  const u = new URL(url);
  ensure(u.protocol === 'https:' && !u.username && !u.password && !u.search && !u.hash, `Invalid ${label}`);
  return u;
}
function jwtObject(part: string): JsonRecord {
  ensure(part.length <= MAX_TOKEN_BYTES && /^[A-Za-z0-9_-]+$/.test(part), 'Malformed access token');
  const parsed: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  ensure(record(parsed), 'Malformed access token');
  return parsed;
}
function principalId(host: Host, sub: string, clientId: string) { return `${host}\u0000${sub}\u0000${clientId}`; }

export class ExternalOAuthVerifier {
  private constructor(
    readonly issuer: string,
    readonly resource: string,
    private readonly keys: Map<string, KeyObject>,
    private readonly bindings: Map<string, Host>,
  ) {}

  static async open(config: OAuthSettings) {
    const issuer = exactHttpsUrl(config.issuer, 'OAuth issuer');
    const resource = exactHttpsUrl(config.resource, 'MCP resource');
    ensure(resource.pathname === '/mcp', 'MCP resource must be an HTTPS /mcp URL');
    // No network fetch or untrusted URL dereference. Operators provision public JWKS
    // and bindings from the identity provider using a secured deployment channel.
    const jwks: unknown = JSON.parse(await readFile(config.keysFile, 'utf8'));
    const actors: unknown = JSON.parse(await readFile(config.actorsFile, 'utf8'));
    ensure(record(jwks) && Array.isArray(jwks.keys) && jwks.keys.length > 0 && jwks.keys.length <= 20, 'Invalid JWKS');
    ensure(Array.isArray(actors) && actors.length > 0 && actors.length <= 50, 'Invalid actor bindings');
    const keys = new Map<string, KeyObject>();
    for (const raw of jwks.keys) {
      ensure(record(raw) && raw.kty === 'RSA' && typeof raw.kid === 'string' && raw.kid.length >= 1 && raw.kid.length <= 128 && raw.alg === 'RS256' && (raw.use === undefined || raw.use === 'sig'), 'Unsupported JWK');
      ensure(!keys.has(raw.kid), 'Duplicate JWK kid');
      // Only public fields are passed to crypto, even if a misconfigured file
      // accidentally contains private key material.
      ensure(typeof raw.n === 'string' && typeof raw.e === 'string', 'Invalid RSA public key');
      const publicKey = createPublicKey({ key: { kty: 'RSA', n: raw.n, e: raw.e }, format: 'jwk' });
      ensure(publicKey.asymmetricKeyDetails?.modulusLength !== undefined && publicKey.asymmetricKeyDetails.modulusLength >= 2048, 'Weak RSA key');
      keys.set(raw.kid, publicKey);
    }
    const bindings = new Map<string, Host>();
    const assigned = new Set<Host>();
    const identities = new Set<string>();
    for (const raw of actors) {
      ensure(record(raw) && typeof raw.host === 'string' && isHost(raw.host) && typeof raw.subject === 'string' && raw.subject.length >= 1 && raw.subject.length <= 256 && typeof raw.clientId === 'string' && raw.clientId.length >= 1 && raw.clientId.length <= 256, 'Invalid actor binding');
      ensure(!assigned.has(raw.host), 'One OAuth actor binding per host');
      const key = principalId(raw.host, raw.subject, raw.clientId);
      ensure(!bindings.has(key), 'Duplicate actor identity');
      const identityKey = JSON.stringify([raw.subject, raw.clientId]);
      ensure(!identities.has(identityKey), 'OAuth client identity assigned to multiple hosts');
      identities.add(identityKey);
      assigned.add(raw.host); bindings.set(key, raw.host);
    }
    return new ExternalOAuthVerifier(issuer.toString().replace(/\/$/, ''), resource.toString(), keys, bindings);
  }

  protectedResourceMetadata() {
    return { resource: this.resource, authorization_servers: [this.issuer], scopes_supported: ['panter:mesh', 'panter:lead'] };
  }
  challenge() {
    const metadata = new URL('/.well-known/oauth-protected-resource', this.resource).toString();
    return `Bearer realm="panter-ai", resource_metadata="${metadata}", scope="panter:mesh"`;
  }
  verifyBearer(authorization: string | undefined, nowSeconds = Math.floor(Date.now() / 1000)): Host {
    ensure(authorization?.startsWith('Bearer ') && authorization.length <= MAX_TOKEN_BYTES + 7, 'Missing bearer token');
    const token = authorization!.slice(7);
    ensure(jwtPattern.test(token), 'Malformed access token');
    const [partHeader, partBody, partSignature] = token.split('.') as [string, string, string];
    const header = jwtObject(partHeader), payload = jwtObject(partBody);
    ensure(header.alg === 'RS256' && typeof header.kid === 'string', 'Unsupported access-token algorithm');
    const key = this.keys.get(header.kid);
    ensure(key, 'Unknown JWT signing key');
    const signature = Buffer.from(partSignature, 'base64url');
    ensure(signature.length > 0 && verify('RSA-SHA256', Buffer.from(`${partHeader}.${partBody}`), key, signature), 'Invalid JWT signature');
    ensure(payload.iss === this.issuer, 'Wrong OAuth issuer');
    ensure(payload.aud === this.resource || (Array.isArray(payload.aud) && payload.aud.includes(this.resource)), 'Wrong MCP token audience');
    ensure(typeof payload.sub === 'string' && payload.sub.length > 0 && payload.sub.length <= 256, 'Missing subject');
    ensure(typeof payload.client_id === 'string' && payload.client_id.length > 0 && payload.client_id.length <= 256, 'Missing OAuth client_id');
    ensure(typeof payload.exp === 'number' && Number.isSafeInteger(payload.exp) && payload.exp > nowSeconds - CLOCK_SKEW_SECONDS, 'Expired access token');
    ensure(typeof payload.iat === 'number' && Number.isSafeInteger(payload.iat) && payload.iat <= nowSeconds + CLOCK_SKEW_SECONDS, 'Invalid token issued-at');
    ensure(payload.nbf === undefined || (typeof payload.nbf === 'number' && Number.isSafeInteger(payload.nbf) && payload.nbf <= nowSeconds + CLOCK_SKEW_SECONDS), 'Access token not yet valid');
    const scope = typeof payload.scope === 'string' ? payload.scope.split(' ') : [];
    ensure(scope.includes('panter:mesh'), 'Insufficient OAuth scope');
    const matches = HOST_ROLES.filter(host => this.bindings.has(principalId(host, payload.sub as string, payload.client_id as string)));
    ensure(matches.length === 1, 'Unregistered OAuth actor');
    const host = matches[0]!;
    if (host === 'gpt-a') ensure(scope.includes('panter:lead'), 'GPT-A leader scope required');
    return host;
  }
}

/** Static alpha token verification is deliberately kept separate from OAuth. */
export function staticBearerMatch(header: string | undefined, secret: string): boolean {
  if (!header?.startsWith('Bearer ')) return false;
  const candidate = header.slice(7);
  const a = createHash('sha256').update(candidate).digest();
  const b = createHash('sha256').update(secret).digest();
  return timingSafeEqual(a, b);
}
