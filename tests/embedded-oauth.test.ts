import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { EmbeddedOAuth } from '../src/core/embedded-oauth.js';

const issuer = 'https://panter.example.org';
const resource = issuer + '/mcp';
const callbackA = 'https://chatgpt.com/connector_platform_oauth_redirect';
const callbackB = 'https://claude.ai/api/mcp/auth_callback';
const secret = 'owner-approval-password-32chars-very-private';
const verifier = 'a'.repeat(64);
const challenge = createHash('sha256').update(verifier).digest('base64url');
async function harness(run: (h: { base: string; oauth: EmbeddedOAuth; dir: string; request: (p: string, init?: RequestInit) => Promise<Response> }) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'panter-embedded-oauth-'));
  let server: Server | undefined;
  try {
    const oauth = await EmbeddedOAuth.open({ dir, resource, redirectUris: [callbackA, callbackB], password: secret });
    server = createServer(async (req, res) => { if (!await oauth.handle(req, res)) { res.statusCode = 404; res.end(); } });
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    const request = (p: string, init: RequestInit = {}) => fetch(base + p, { ...init, redirect: 'manual' });
    await run({ base, oauth, dir, request });
  } finally { if (server) await new Promise<void>(resolve => server!.close(() => resolve())); await rm(dir, { recursive: true, force: true }); }
}
function post(payload: Record<string, string>, extraHeaders: Record<string, string> = {}): RequestInit {
  return { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...extraHeaders }, body: new URLSearchParams(payload).toString() };
}
async function register(request: (p: string, init?: RequestInit) => Promise<Response>, callback = callbackA) {
  const result = await request('/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: [callback], token_endpoint_auth_method: 'none', response_types: ['code'], grant_types: ['authorization_code', 'refresh_token'] }) });
  assert.equal(result.status, 201); return (await result.json() as { client_id: string }).client_id;
}
async function authorize(request: (p: string, init?: RequestInit) => Promise<Response>, clientId: string, host: string, callback = callbackA) {
  const q = new URLSearchParams({ client_id: clientId, redirect_uri: callback, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', scope: 'mcp offline_access', resource, state: 'opaque-state' });
  const start = await request('/authorize?' + q); assert.equal(start.status, 302);
  const next = new URL(start.headers.get('location')!, issuer);
  const consentCookie = start.headers.get('set-cookie')!.split(';')[0]!;
  const page = await request(next.pathname + next.search, { headers: { cookie: consentCookie } });
  assert.equal(page.status, 200);
  const html = await page.text(); const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1]; assert.ok(csrf);
  const approved = await request(next.pathname + next.search, post({ csrf, password: secret, host, decision: 'allow' }, { origin: issuer, cookie: consentCookie }));
  assert.equal(approved.status, 302);
  const returned = new URL(approved.headers.get('location')!);
  assert.equal(returned.searchParams.get('state'), 'opaque-state');
  assert.equal(returned.searchParams.get('iss'), issuer);
  return { code: returned.searchParams.get('code')!, consentCookie, csrf, next };
}
async function token(request: (p: string, init?: RequestInit) => Promise<Response>, clientId: string, code: string, callback = callbackA) {
  return request('/token', post({ grant_type: 'authorization_code', client_id: clientId, code, code_verifier: verifier, redirect_uri: callback, resource }));
}

test('embedded OAuth discovery, DCR, PKCE, consent, token, restart and no code replay', () => harness(async ({ oauth, dir, request }) => {
  const discovery = await request('/.well-known/oauth-authorization-server');
  assert.equal(discovery.status, 200); assert.equal((await discovery.json() as { issuer: string }).issuer, issuer);
  const metadata = await request('/.well-known/oauth-protected-resource/mcp');
  assert.deepEqual((await metadata.json() as { authorization_servers: string[] }).authorization_servers, [issuer]);
  const clientId = await register(request);
  const { code } = await authorize(request, clientId, 'gpt-a');
  const response = await token(request, clientId, code);
  assert.equal(response.status, 200);
  const issued = await response.json() as { access_token: string; refresh_token: string; scope: string };
  assert.equal(await oauth.authenticate('Bearer ' + issued.access_token), 'gpt-a');
  assert.ok(issued.scope.includes('panter:lead'));
  const reopened = await EmbeddedOAuth.open({ dir, resource, redirectUris: [callbackA, callbackB], password: secret });
  assert.equal(await reopened.authenticate('Bearer ' + issued.access_token), 'gpt-a');
  assert.equal((await token(request, clientId, code)).status, 400);
}));

test('two independent ChatGPT apps bind to different authenticated actors', () => harness(async ({ oauth, request }) => {
  const clientA = await register(request), clientB = await register(request);
  const a = await authorize(request, clientA, 'gpt-a');
  const b = await authorize(request, clientB, 'gpt-b');
  const resA = await token(request, clientA, a.code);
  const resB = await token(request, clientB, b.code);
  assert.equal(resA.status, 200); assert.equal(resB.status, 200);
  const bearerA = (await resA.json() as { access_token: string }).access_token;
  const bearerB = (await resB.json() as { access_token: string; scope: string });
  assert.equal(await oauth.authenticate('Bearer ' + bearerA), 'gpt-a');
  assert.equal(await oauth.authenticate('Bearer ' + bearerB.access_token), 'gpt-b');
  assert.ok(!bearerB.scope.includes('panter:lead'));
}));

test('reject arbitrary callbacks, missing PKCE and token exchange by a different client', () => harness(async ({ request }) => {
  const rejected = await request('/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['https://evil.example/callback'] }) });
  assert.equal(rejected.status, 400);
  const clientA = await register(request), clientB = await register(request);
  const q = new URLSearchParams({ response_type: 'code', client_id: clientA, redirect_uri: callbackA, code_challenge: challenge });
  assert.equal((await request('/authorize?' + q)).status, 400);
  const { code } = await authorize(request, clientA, 'gpt-a');
  assert.equal((await token(request, clientB, code)).status, 400);
  const bad = await request('/token', post({ grant_type: 'authorization_code', client_id: clientA, code, code_verifier: 'b'.repeat(64), redirect_uri: callbackA }));
  assert.equal(bad.status, 400);
  assert.equal((await token(request, clientA, code)).status, 200);
}));

test('invalid Origin, CSRF and operator approval do not issue a code', () => harness(async ({ request }) => {
  const client = await register(request);
  const q = new URLSearchParams({ client_id: client, redirect_uri: callbackA, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', scope: 'mcp' });
  const start = await request('/authorize?' + q);
  const cookie = start.headers.get('set-cookie')!.split(';')[0]!;
  const location = start.headers.get('location')!;
  const page = await request(location, { headers: { cookie } });
  const csrf = /name="csrf" value="([^"]+)"/.exec(await page.text())?.[1]!;
  const payload = { csrf, password: secret, host: 'gpt-a', decision: 'allow' };
  assert.equal((await request(location, post(payload, { origin: 'https://attacker.example', cookie }))).status, 403);
  assert.equal((await request(location, post({ ...payload, csrf: 'forged' }, { origin: issuer, cookie }))).status, 403);
  assert.equal((await request(location, post({ ...payload, password: 'incorrect' }, { origin: issuer, cookie }))).status, 403);
  assert.equal((await request(location, post(payload, { origin: issuer, cookie }))).status, 302);
  assert.equal((await request(location, post(payload, { origin: issuer, cookie }))).status, 403);
}));

test('refresh rotation detects old token replay and revokes the active family', () => harness(async ({ oauth, request }) => {
  const client = await register(request);
  const { code } = await authorize(request, client, 'gpt-a');
  const first = await token(request, client, code);
  const initial = await first.json() as { access_token: string; refresh_token: string };
  const rotated = await request('/token', post({ grant_type: 'refresh_token', client_id: client, refresh_token: initial.refresh_token }));
  assert.equal(rotated.status, 200);
  const newTokens = await rotated.json() as { access_token: string; refresh_token: string };
  assert.equal(await oauth.authenticate('Bearer ' + newTokens.access_token), 'gpt-a');
  const replay = await request('/token', post({ grant_type: 'refresh_token', client_id: client, refresh_token: initial.refresh_token }));
  assert.equal(replay.status, 400);
  await assert.rejects(oauth.authenticate('Bearer ' + newTokens.access_token));
}));

test('revocation immediately invalidates access and its refresh family', () => harness(async ({ oauth, request }) => {
  const client = await register(request);
  const { code } = await authorize(request, client, 'gpt-b');
  const first = await token(request, client, code);
  const issued = await first.json() as { access_token: string; refresh_token: string };
  const revoked = await request('/revoke', post({ client_id: client, token: issued.refresh_token }));
  assert.equal(revoked.status, 200);
  await assert.rejects(oauth.authenticate('Bearer ' + issued.access_token));
  assert.equal((await request('/token', post({ grant_type: 'refresh_token', client_id: client, refresh_token: issued.refresh_token }))).status, 400);
}));

test('tokens are stored by digest, never persisted in plaintext', () => harness(async ({ dir, request }) => {
  const client = await register(request);
  const { code } = await authorize(request, client, 'gpt-b');
  const issued = await (await token(request, client, code)).json() as { access_token: string; refresh_token: string };
  const json = await (await import('node:fs/promises')).readFile(join(dir, 'oauth.json'), 'utf8');
  assert.ok(!json.includes(issued.access_token) && !json.includes(issued.refresh_token));
}));

test('consent password guessing is capped per pending authorization', () => harness(async ({ request }) => {
  const client = await register(request);
  const q = new URLSearchParams({ client_id: client, redirect_uri: callbackA, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', scope: 'mcp' });
  const start = await request('/authorize?' + q);
  const cookie = start.headers.get('set-cookie')!.split(';')[0]!;
  const target = start.headers.get('location')!;
  const page = await request(target, { headers: { cookie } });
  const csrf = /name="csrf" value="([^"]+)"/.exec(await page.text())![1]!;
  for (let i = 0; i < 6; i++) assert.equal((await request(target, post({ csrf, password: 'wrong', host: 'gpt-a', decision: 'allow' }, { cookie, origin: issuer }))).status, 403);
  assert.equal((await request(target, post({ csrf, password: secret, host: 'gpt-a', decision: 'allow' }, { cookie, origin: issuer }))).status, 403);
}));

test('a client cannot silently change its approved host on a subsequent OAuth grant', () => harness(async ({ request }) => {
  const client = await register(request);
  await authorize(request, client, 'gpt-a');
  const q = new URLSearchParams({ client_id: client, redirect_uri: callbackA, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', scope: 'mcp' });
  const start = await request('/authorize?' + q);
  const cookie = start.headers.get('set-cookie')!.split(';')[0]!;
  const target = start.headers.get('location')!;
  const page = await request(target, { headers: { cookie } });
  const csrf = /name="csrf" value="([^"]+)"/.exec(await page.text())![1]!;
  assert.equal((await request(target, post({ csrf, password: secret, host: 'gpt-b', decision: 'allow' }, { cookie, origin: issuer }))).status, 403);
}));

test('embedded DCR reclaims abandoned clients without deleting consented registrations',()=>harness(async({request})=>{
 const originalNow=Date.now;
 try{
   const first=await register(request);
   Date.now=()=>originalNow()+25*3600*1000;
   const next=await register(request);
   assert.notEqual(next,first);
 }finally{Date.now=originalNow;}
}));
