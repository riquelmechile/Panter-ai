/**
 * Signed actor assertions: Panter tells a downstream MCP server who is really calling.
 *
 * Every call Panter forwards to a downstream server carries `_meta["panter-ai/actor"]`, a compact token signed with
 * Ed25519 (a JWS with alg EdDSA). It says which authenticated host made the call (`sub`: gpt-a, grok, claude...),
 * with which Panter role (`role`: leader, worker or operator), for which mission (`mission`), and it is bound to this
 * one call: the server it was meant for (`aud`), the tool (`tool`), a digest of the exact arguments (`args`), a unique
 * id (`jti`) and a short lifetime (`iat`/`exp`). The downstream server checks it with Panter's public key
 * (GET /.well-known/panter-downstream-keys) instead of trusting "Panter" blindly.
 *
 * What it proves: which host Panter authenticated (OAuth or a host token) made this exact call. It does not prove
 * which model the host was running: that is the host's own claim and is not part of the assertion.
 *
 * This file depends only on node:crypto so a downstream server can copy it as its verifier.
 */
import { KeyObject, createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type JsonWebKey } from 'node:crypto';

export const ACTOR_TYP = 'panter-actor+jwt';
/** Lifetime of one assertion. A call that takes longer is still checked at arrival, which is what matters. */
export const ACTOR_TTL_SECONDS = 120;
/** Longest lifetime a verifier accepts, whatever the token says. */
export const ACTOR_MAX_TTL_SECONDS = 300;

export type ActorRole = 'leader' | 'worker' | 'operator';
export type ActorClaims = {
  iss: 'panter-ai'; aud: string; sub: string; role: ActorRole; mission?: string;
  jti: string; tool: string; args: string; iat: number; exp: number;
};

const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url');
const fromB64u = (s: string) => {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error('actor assertion: not base64url');
  return Buffer.from(s, 'base64url');
};

/** JSON with object keys sorted at every depth (RFC 8785 ordering and number form for JSON values). */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(v => v === undefined ? 'null' : canonicalJson(v)).join(',')}]`;
  const o = value as Record<string, unknown>;
  return `{${Object.keys(o).sort().filter(k => o[k] !== undefined && typeof o[k] !== 'function')
    .map(k => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
}
/** Digest of a call's arguments as carried in the assertion: base64url SHA-256 of their canonical JSON. */
export const argsDigest = (args: unknown) => b64u(createHash('sha256').update(canonicalJson(args ?? {})).digest());

export class ActorSigner {
  readonly kid: string;
  private readonly publicKey: KeyObject;
  constructor(private readonly privateKey: KeyObject) {
    if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('actor signer: an Ed25519 key is required');
    this.publicKey = createPublicKey(privateKey);
    const x = this.publicKey.export({ format: 'jwk' }).x!;
    this.kid = b64u(createHash('sha256').update(x).digest()).slice(0, 16);
  }
  static generate(): ActorSigner { return new ActorSigner(generateKeyPairSync('ed25519').privateKey); }
  /** Load a key saved with exportPkcs8(). */
  static fromPkcs8(base64: string): ActorSigner { return new ActorSigner(createPrivateKey({ key: Buffer.from(base64, 'base64'), format: 'der', type: 'pkcs8' })); }
  exportPkcs8(): string { return this.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'); }
  /** The public key as a JWK, the form published at /.well-known/panter-downstream-keys. */
  jwk(): JsonWebKey & { kid: string; alg: 'EdDSA'; use: 'sig' } {
    const { kty, crv, x } = this.publicKey.export({ format: 'jwk' });
    return { kty, crv, x, kid: this.kid, alg: 'EdDSA', use: 'sig' };
  }
  sign(claims: ActorClaims): string {
    const head = b64u(JSON.stringify({ alg: 'EdDSA', typ: ACTOR_TYP, kid: this.kid }));
    const body = b64u(JSON.stringify(claims));
    return `${head}.${body}.${b64u(sign(null, Buffer.from(`${head}.${body}`), this.privateKey))}`;
  }
}

/**
 * Reference verifier for downstream servers. Throws unless the token is a valid Panter assertion for exactly this
 * call: this server (`aud`), this tool, these arguments, signed by `key` and not expired. Returns its claims.
 * Keep each `jti` until its `exp` and refuse a repeat, so a captured token cannot be replayed within its lifetime.
 */
export function verifyActorAssertion(token: unknown, key: JsonWebKey | KeyObject,
  expect: { aud: string; tool: string; args: unknown; now?: number; leewaySeconds?: number }): ActorClaims {
  if (typeof token !== 'string' || token.length > 4096) throw new Error('actor assertion: missing');
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('actor assertion: malformed');
  const [head, body, sig] = parts as [string, string, string];
  let header: any, claims: any;
  try { header = JSON.parse(fromB64u(head).toString('utf8')); claims = JSON.parse(fromB64u(body).toString('utf8')); }
  catch { throw new Error('actor assertion: malformed'); }
  if (header?.alg !== 'EdDSA' || header?.typ !== ACTOR_TYP) throw new Error('actor assertion: wrong algorithm or type');
  const publicKey = key instanceof KeyObject ? key : createPublicKey({ key: key as any, format: 'jwk' });
  if (publicKey.asymmetricKeyType !== 'ed25519') throw new Error('actor assertion: an Ed25519 key is required');
  const kid = key instanceof KeyObject ? undefined : (key as { kid?: string }).kid;
  if (kid !== undefined && header.kid !== kid) throw new Error('actor assertion: signed with another key');
  if (!verify(null, Buffer.from(`${head}.${body}`), publicKey, fromB64u(sig))) throw new Error('actor assertion: bad signature');
  const now = Math.floor((expect.now ?? Date.now()) / 1000), leeway = expect.leewaySeconds ?? 30;
  if (claims?.iss !== 'panter-ai') throw new Error('actor assertion: wrong issuer');
  if (claims.aud !== expect.aud) throw new Error('actor assertion: meant for another server');
  if (claims.tool !== expect.tool) throw new Error('actor assertion: meant for another tool');
  if (claims.args !== argsDigest(expect.args)) throw new Error('actor assertion: arguments differ');
  if (typeof claims.sub !== 'string' || !['leader', 'worker', 'operator'].includes(claims.role) || typeof claims.jti !== 'string')
    throw new Error('actor assertion: incomplete');
  if (!Number.isInteger(claims.iat) || !Number.isInteger(claims.exp) || claims.exp <= claims.iat || claims.exp - claims.iat > ACTOR_MAX_TTL_SECONDS)
    throw new Error('actor assertion: bad lifetime');
  if (claims.iat > now + leeway) throw new Error('actor assertion: issued in the future');
  if (claims.exp + leeway < now) throw new Error('actor assertion: expired');
  return claims as ActorClaims;
}
