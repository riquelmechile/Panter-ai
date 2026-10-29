import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExternalOAuthVerifier } from '../src/core/oauth.js';

const issuer = 'https://id.example.test';
const resource = 'https://panter.example.test/mcp';
const bindings = [
  { host: 'gpt-a', subject: 'owner', clientId: 'chatgpt-orchestrator' },
  { host: 'gpt-b', subject: 'owner', clientId: 'chatgpt-worker' },
  { host: 'grok', subject: 'owner', clientId: 'grok-app' },
];
async function setup(action: (ctx: {
  verifier: ExternalOAuthVerifier;
  token: (claims?: Record<string, unknown>, key?: 'trusted' | 'attacker') => string;
  keysFile: string;
  actorsFile: string;
}) => Promise<void> | void) {
  const directory = await mkdtemp(join(tmpdir(), 'panter-auth-'));
  try {
    const trusted = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const attacker = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const keysFile = join(directory, 'jwks.json');
    const actorsFile = join(directory, 'actors.json');
    const pub = trusted.publicKey.export({ format: 'jwk' });
    await writeFile(keysFile, JSON.stringify({ keys: [{ ...pub, kid: 'trusted', alg: 'RS256', use: 'sig' }] }));
    await writeFile(actorsFile, JSON.stringify(bindings));
    const verifier = await ExternalOAuthVerifier.open({ issuer, resource, keysFile, actorsFile });
    const token = (claims: Record<string, unknown> = {}, key: 'trusted' | 'attacker' = 'trusted') => {
      const now = Math.floor(Date.now() / 1000);
      const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'at+jwt', kid: 'trusted' })).toString('base64url');
      const payload = Buffer.from(JSON.stringify({ iss: issuer, aud: resource, sub: 'owner', client_id: 'chatgpt-orchestrator', scope: 'panter:mesh panter:lead', iat: now, exp: now + 120, ...claims })).toString('base64url');
      const content = `${header}.${payload}`;
      const signature = sign('RSA-SHA256', Buffer.from(content), key === 'trusted' ? trusted.privateKey : attacker.privateKey).toString('base64url');
      return `Bearer ${content}.${signature}`;
    };
    await action({ verifier, token, keysFile, actorsFile });
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test('valid issuer-bound JWT authenticates GPT-A; distinct client_id maps GPT-B', () => setup(({ verifier, token }) => {
  assert.equal(verifier.verifyBearer(token()), 'gpt-a');
  assert.equal(verifier.verifyBearer(token({ client_id: 'chatgpt-worker', scope: 'panter:mesh' })), 'gpt-b');
  assert.equal(verifier.verifyBearer(token({ client_id: 'grok-app', scope: 'panter:mesh' })), 'grok');
}));

test('JWT authentication rejects impersonation, unsupported algorithm, changed signature and unknown client', () => setup(({ verifier, token }) => {
  assert.throws(() => verifier.verifyBearer(token({ client_id: 'wrong' })), /Unregistered/);
  assert.throws(() => verifier.verifyBearer(token({ client_id: 'chatgpt-worker' }, 'attacker')), /Invalid JWT signature/);
  const tampered = token().replace(/^Bearer ([^.]+)/, (_, x) => `Bearer ${Buffer.from(JSON.stringify({ alg: 'none', kid: 'trusted' })).toString('base64url')}`);
  assert.throws(() => verifier.verifyBearer(tampered), /algorithm/);
  assert.throws(() => verifier.verifyBearer('Bearer abc'), /Malformed/);
}));

test('JWT requires correct issuer and exact MCP audience, not generic login access', () => setup(({ verifier, token }) => {
  assert.throws(() => verifier.verifyBearer(token({ iss: 'https://other.example.test' })), /issuer/);
  assert.throws(() => verifier.verifyBearer(token({ aud: 'https://other.example.test/mcp' })), /audience/);
  assert.equal(verifier.verifyBearer(token({ aud: ['https://other.example.test', resource] })), 'gpt-a');
}));

test('JWT checks expiration, not-before, future-issued and necessary scopes', () => setup(({ verifier, token }) => {
  const now = Math.floor(Date.now() / 1000);
  assert.throws(() => verifier.verifyBearer(token({ exp: now - 90 })), /Expired/);
  assert.throws(() => verifier.verifyBearer(token({ nbf: now + 90 })), /not yet valid/);
  assert.throws(() => verifier.verifyBearer(token({ iat: now + 90 })), /issued-at/);
  assert.throws(() => verifier.verifyBearer(token({ scope: 'openid' })), /scope/);
  assert.throws(() => verifier.verifyBearer(token({ scope: 'panter:mesh' })), /leader scope/);
}));

test('resource discovery and 401 challenge point to exact protected resource', () => setup(({ verifier }) => {
  assert.deepEqual(verifier.protectedResourceMetadata(), { resource, authorization_servers: [issuer], scopes_supported: ['panter:mesh', 'panter:lead'] });
  assert.match(verifier.challenge(), /resource_metadata="https:\/\/panter\.example\.test\/\.well-known\/oauth-protected-resource"/);
}));

test('fail closed for duplicate host bindings, invalid issuer and non-2048-bit keys', () => setup(async ({ keysFile, actorsFile }) => {
  await writeFile(actorsFile, JSON.stringify([bindings[0], bindings[0]]));
  await assert.rejects(ExternalOAuthVerifier.open({ issuer, resource, keysFile, actorsFile }), /One OAuth actor/);
  await assert.rejects(ExternalOAuthVerifier.open({ issuer: 'http://insecure.test', resource, keysFile, actorsFile }), /Invalid OAuth issuer/);
  const weak = generateKeyPairSync('rsa', { modulusLength: 1024 });
  await writeFile(keysFile, JSON.stringify({ keys: [{ ...weak.publicKey.export({ format: 'jwk' }), kid: 'weak', alg: 'RS256' }] }));
  await writeFile(actorsFile, JSON.stringify(bindings));
  await assert.rejects(ExternalOAuthVerifier.open({ issuer, resource, keysFile, actorsFile }), /Weak RSA key/);
}));
