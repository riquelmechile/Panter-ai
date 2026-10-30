import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { EmbeddedOAuth } from '../src/core/embedded-oauth.js';
import { ClientAddressPolicy } from '../src/core/trusted-proxy.js';

const issuer = 'https://panter.example.org';
const resource = issuer + '/mcp';
const callbackA = 'https://chatgpt.com/connector_platform_oauth_redirect';
const callbackB = 'https://claude.ai/api/mcp/auth_callback';
const callbackC = 'https://claude.com/api/mcp/auth_callback';
const secret = 'owner-approval-password-32chars-very-private';
const verifier = 'a'.repeat(64);
const challenge = createHash('sha256').update(verifier).digest('base64url');
async function harness(run: (h: { base: string; oauth: EmbeddedOAuth; dir: string; request: (p: string, init?: RequestInit) => Promise<Response> }) => Promise<void>, clientIdentity?: (req:import('node:http').IncomingMessage)=>string) {
  const dir = await mkdtemp(join(tmpdir(), 'panter-embedded-oauth-'));
  let server: Server | undefined;
  try {
    const oauth = await EmbeddedOAuth.open({ dir, resource, redirectUris: [callbackA, callbackB, callbackC], password: secret, clientIdentity });
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
  assert.equal(discovery.status, 200);
  const asMetadata = await discovery.json() as {
    issuer: string;
    authorization_response_iss_parameter_supported?: boolean;
    client_id_metadata_document_supported?: boolean;
    registration_endpoint: string;
    token_endpoint_auth_methods_supported: string[];
    code_challenge_methods_supported: string[];
  };
  assert.equal(asMetadata.issuer, issuer);
  assert.equal(asMetadata.authorization_response_iss_parameter_supported, true);
  assert.equal('client_id_metadata_document_supported' in asMetadata, false, 'Do not advertise unsupported CIMD');
  assert.equal(asMetadata.registration_endpoint, issuer + '/register');
  assert.deepEqual(asMetadata.token_endpoint_auth_methods_supported, ['none']);
  assert.ok(asMetadata.code_challenge_methods_supported.includes('S256'));
  for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
    const metadata = await request(path);
    assert.equal(metadata.status, 200);
    const prm = await metadata.json() as {
      resource: string;
      authorization_servers: string[];
      bearer_methods_supported: string[];
    };
    assert.equal(prm.resource, resource);
    assert.deepEqual(prm.authorization_servers, [asMetadata.issuer]);
    assert.deepEqual(prm.bearer_methods_supported, ['header']);
  }
  const clientId = await register(request);
  const { code } = await authorize(request, clientId, 'gpt-a');
  const response = await token(request, clientId, code);
  assert.equal(response.status, 200);
  const issued = await response.json() as { access_token: string; refresh_token: string; scope: string };
  assert.equal(await oauth.authenticate('Bearer ' + issued.access_token), 'gpt-a');
  assert.ok(issued.scope.includes('panter:lead'));
  const reopened = await EmbeddedOAuth.open({ dir, resource, redirectUris: [callbackA, callbackB, callbackC], password: secret });
  assert.equal(await reopened.authenticate('Bearer ' + issued.access_token), 'gpt-a');
  assert.equal((await token(request, clientId, code)).status, 400);
}));

test('RFC 9207 issuer matches exact metadata on the denied ChatGPT callback', () => harness(async ({ request }) => {
  const metadata = await (await request('/.well-known/oauth-authorization-server')).json() as {
    issuer: string;
    authorization_response_iss_parameter_supported?: boolean;
  };
  assert.equal(metadata.authorization_response_iss_parameter_supported, true);
  const clientId = await register(request);
  const q = new URLSearchParams({
    client_id: clientId, redirect_uri: callbackA, response_type: 'code',
    code_challenge: challenge, code_challenge_method: 'S256',
    scope: 'mcp offline_access', resource, state: 'denial-state',
  });
  const start = await request('/authorize?' + q);
  assert.equal(start.status, 302);
  const cookie = start.headers.get('set-cookie')!.split(';')[0]!;
  const location = start.headers.get('location')!;
  const consent = await request(location, { headers: { cookie } });
  assert.equal(consent.status, 200);
  const csrf = /name="csrf" value="([^"]+)"/.exec(await consent.text())?.[1];
  assert.ok(csrf);
  const denied = await request(location, post(
    { csrf, decision: 'deny', host: 'gpt-a' },
    { cookie, origin: metadata.issuer }
  ));
  assert.equal(denied.status, 302);
  const callback = new URL(denied.headers.get('location')!);
  assert.equal(callback.origin + callback.pathname, callbackA);
  assert.equal(callback.searchParams.get('error'), 'access_denied');
  assert.equal(callback.searchParams.get('state'), 'denial-state');
  assert.equal(callback.searchParams.get('iss'), metadata.issuer);
  assert.equal(callback.searchParams.has('code'), false);
}));

test('consent CSP permits only the active exact callback origin, never wildcard or other client origins', () => harness(async ({ request }) => {
  for (const callback of [callbackA, callbackB, callbackC]) {
    const clientId = await register(request, callback);
    const q = new URLSearchParams({
      client_id: clientId, redirect_uri: callback, response_type: 'code',
      code_challenge: challenge, code_challenge_method: 'S256',
      scope: 'mcp offline_access', resource, state: 'csp-test-state',
    });
    const start = await request('/authorize?' + q);
    assert.equal(start.status, 302);
    const location = start.headers.get('location')!;
    const cookie = start.headers.get('set-cookie')!.split(';')[0]!;
    const consent = await request(location, { headers: { cookie } });
    assert.equal(consent.status, 200);
    const csp = consent.headers.get('content-security-policy') ?? '';
    const expected = new URL(callback).origin;
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /base-uri 'none'/);
    assert.ok(csp.includes(`form-action 'self' ${expected};`), 'Form POST plus cross-origin callback must be allowed');
    assert.ok(!csp.includes('*'), 'Wildcard CSP sources forbidden');
    for (const other of [callbackA, callbackB, callbackC]) {
      if (new URL(other).origin !== expected) assert.ok(!csp.includes(new URL(other).origin), 'Unrelated client callback origin cannot be allowed');
    }
    const html = await consent.text();
    const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1];
    assert.ok(csrf);
    const approved = await request(location, post(
      { csrf, password: secret, host: callback === callbackA ? 'gpt-a' : 'claude', decision: 'allow' },
      { origin: issuer, cookie },
    ));
    assert.equal(approved.status, 302);
    const result = new URL(approved.headers.get('location')!);
    assert.equal(result.origin + result.pathname, callback);
    assert.equal(result.searchParams.get('iss'), issuer);
    assert.ok(result.searchParams.get('code'));
  }
}));

test('DCR allows both exact Claude callbacks but rejects lookalike URLs', () => harness(async ({ request }) => {
  const accepted = await request('/register', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ redirect_uris: [callbackB, callbackC], token_endpoint_auth_method: 'none' }),
  });
  assert.equal(accepted.status, 201);
  const client = await accepted.json() as { redirect_uris: string[] };
  assert.deepEqual(client.redirect_uris, [callbackB, callbackC]);
  for (const uri of [
    'https://claude.com/api/mcp/auth_callback/extra',
    'https://claude.ai.evil.example/api/mcp/auth_callback',
    'http://claude.com/api/mcp/auth_callback',
  ]) {
    const rejected = await request('/register', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: [uri], token_endpoint_auth_method: 'none' }),
    });
    assert.equal(rejected.status, 400);
  }
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

test('unverified consent display labels client provenance and shows registration age',()=>harness(async({request})=>{
 const result=await request('/register',{method:'POST',headers:{'content-type':'application/json'},
   body:JSON.stringify({redirect_uris:[callbackA],client_name:'ChatGPT Official & <team>'})});
 assert.equal(result.status,201);const clientId=(await result.json() as {client_id:string}).client_id;
 const q=new URLSearchParams({client_id:clientId,redirect_uri:callbackA,response_type:'code',
   code_challenge:challenge,code_challenge_method:'S256',scope:'mcp',resource,state:'consent-screen'});
 const first=await request('/authorize?'+q);assert.equal(first.status,302);
 const cookie=first.headers.get('set-cookie')!.split(';')[0]!;
 const page=await request(first.headers.get('location')!,{headers:{cookie}});
 const html=await page.text();
 assert.match(html,/Cliente NO VERIFICADO/);
 assert.match(html,/Registrado hace aproximadamente/);
 assert.match(html,/ChatGPT Official &amp; &lt;team&gt;/);
 assert.doesNotMatch(html,/ChatGPT Official & <team>/);
}));
test('invalid public revocations remain 200 and do not rewrite persisted OAuth ledger',()=>harness(async({request,dir})=>{
 const clientId=await register(request);
 const file=join(dir,'oauth.json');
 const before=await (await import('node:fs/promises')).readFile(file,'utf8');
 const response=await request('/revoke',post({client_id:clientId,token:'x'.repeat(64)}));
 assert.equal(response.status,200);
 const after=await (await import('node:fs/promises')).readFile(file,'utf8');
 assert.equal(after,before);
}));

test('trusted proxy preserves separate OAuth registration quotas and fails closed on missing client IP',()=>harness(async({request})=>{
 const body=JSON.stringify({redirect_uris:[callbackA],client_name:'registered client'});
 const call=(ip?:string)=>request('/register',{method:'POST',headers:{
  'content-type':'application/json',...(ip?{'x-panter-client-ip':ip}:{})},body});
 for(let i=0;i<20;i++)assert.equal((await call('198.51.100.4')).status,201);
 assert.equal((await call('198.51.100.4')).status,400,'One public client must not exceed its quota');
 assert.equal((await call('198.51.100.5')).status,201,'Another client behind same proxy keeps a distinct quota');
 assert.equal((await call()).status,400,'Missing sanitized client address fails closed');
 assert.equal((await call('198.51.100.5, 198.51.100.4')).status,400,'Ambiguous client IP fails closed');
},req=>new ClientAddressPolicy('127.0.0.1/32').identify(req)));

test('one IP cannot consume the 100 global consent slots or lock out a second IP',()=>harness(async({request,dir})=>{
 const reg=await request('/register',{method:'POST',headers:{'content-type':'application/json','x-panter-client-ip':'198.51.100.20'},
   body:JSON.stringify({redirect_uris:[callbackA],token_endpoint_auth_method:'none'})});
 assert.equal(reg.status,201);
 const client=(await reg.json() as {client_id:string}).client_id;
 const query=new URLSearchParams({client_id:client,redirect_uri:callbackA,response_type:'code',
   code_challenge:challenge,code_challenge_method:'S256',scope:'mcp',resource,state:'pending-flood'});
 const call=(source:string)=>request('/authorize?'+query,{headers:{'x-panter-client-ip':source}});
 const first=await call('198.51.100.20');
 assert.equal(first.status,302);
 const consentLocation=first.headers.get('location')!;
 const consentCookie=first.headers.get('set-cookie')!.split(';')[0]!;
 for(let i=0;i<4;i++)assert.equal((await call('198.51.100.20')).status,302);
 for(let i=0;i<40;i++)assert.equal((await call('198.51.100.20')).status,400);
 const data=JSON.parse(await (await import('node:fs/promises')).readFile(join(dir,'oauth.json'),'utf8'));
 assert.equal(data.pending.length,5,'Never evict the original pending session');
 assert.equal((await request(consentLocation,{headers:{cookie:consentCookie}})).status,200,
   'The initial legitimate consent remains usable after an abusive retry flood');
 const other=await request('/register',{method:'POST',headers:{
  'content-type':'application/json','x-panter-client-ip':'198.51.100.21'},
  body:JSON.stringify({redirect_uris:[callbackA],token_endpoint_auth_method:'none'})});
 assert.equal(other.status,201);
 const otherId=(await other.json() as {client_id:string}).client_id;
 const otherQuery=new URLSearchParams(query);otherQuery.set('client_id',otherId);
 assert.equal((await request('/authorize?'+otherQuery,{headers:{'x-panter-client-ip':'198.51.100.21'}})).status,302,
  'A separate client and source retain authorization capacity');
},req=>new ClientAddressPolicy('127.0.0.1/32').identify(req)));
test('rate-map saturation never clears live quota entries',()=>harness(async({oauth})=>{
 const internals=oauth as unknown as {throttled:(key:string,limit:number)=>void;
  rate:Map<string,{count:number;since:number}>};
 internals.throttled('revoke:global',2);internals.throttled('revoke:global',2);
 for(let i=0;i<4095;i++)internals.throttled('source:'+i,1);
 assert.equal(internals.rate.size,4096);
 assert.throws(()=>internals.throttled('extra-source',1),/saturated/);
 assert.throws(()=>internals.throttled('revoke:global',2),/Rate limited/);
}));

test('IPv6 /64 rotation cannot exceed the per-source registration quota',()=>harness(async({request})=>{
 const body=JSON.stringify({redirect_uris:[callbackA],token_endpoint_auth_method:'none'});
 for(let i=1;i<=20;i++){
  const response=await request('/register',{method:'POST',headers:{
    'content-type':'application/json','x-panter-client-ip':'2001:db8:abcd:0042::'+i.toString(16)},body});
  assert.equal(response.status,201,'Initial IPv6 /64 bucket must accept twenty registrations');
 }
 for(let i=21;i<=60;i++){
  const response=await request('/register',{method:'POST',headers:{
    'content-type':'application/json','x-panter-client-ip':'2001:db8:abcd:42::'+i.toString(16)},body});
  assert.equal(response.status,400,'Rotating IPv6 within /64 must not reset registration quota');
 }
 assert.equal((await request('/register',{method:'POST',headers:{
   'content-type':'application/json','x-panter-client-ip':'2001:db8:abcd:43::1'},body})).status,201);
},req=>new ClientAddressPolicy('127.0.0.1/32').identify(req)));

test('N1: 4200 fake consent sids from one IP cannot fill global rate-map or block legitimate registration',()=>harness(async({request,oauth})=>{
 const badSid=(i:number)=>'/oauth/consent?sid='+
   (i%2===0?'junk'+i:'A'.repeat(34)+i.toString(36).padStart(4,'0')); // malformed AND valid-format unknown
 for(let i=0;i<4200;i++){
  const response=await request(badSid(i),post({csrf:'invalid',password:'invalid',host:'gpt-a',decision:'allow'},
    {origin:issuer,'x-panter-client-ip':'192.0.2.66'}));
  assert.equal(response.status,403);
 }
 const map=(oauth as unknown as {rate:Map<string,unknown>}).rate;
 assert.ok(map.size<=2,'Fake per-session IDs must not allocate unbounded rate entries');
 assert.equal([...map.keys()].filter(k=>k.startsWith('consent:')).length,0);
 const valid=await request('/register',{method:'POST',headers:{
    'content-type':'application/json','x-panter-client-ip':'203.0.113.200'},
    body:JSON.stringify({redirect_uris:[callbackA],token_endpoint_auth_method:'none'})});
 assert.equal(valid.status,201,'A different source must still register after the fake-sid flood');
 const clientId=(await valid.json() as {client_id:string}).client_id;
 const query=new URLSearchParams({client_id:clientId,redirect_uri:callbackA,response_type:'code',
   code_challenge:challenge,code_challenge_method:'S256',scope:'mcp',resource,state:'still-works'});
 const started=await request('/authorize?'+query,{headers:{'x-panter-client-ip':'203.0.113.200'}});
 assert.equal(started.status,302,'A clean OAuth authorization still starts');
 const cookie=started.headers.get('set-cookie')!.split(';')[0]!;
 const location=started.headers.get('location')!;
 const page=await request(location,{headers:{cookie}});
 assert.equal(page.status,200);
 const csrf=/name="csrf" value="([^"]+)"/.exec(await page.text())?.[1]!;
 const approved=await request(location,post({csrf,password:secret,host:'gpt-a',decision:'allow'},
   {cookie,origin:issuer,'x-panter-client-ip':'203.0.113.200'}));
 assert.equal(approved.status,302,'Valid consent POST remains usable after fake SID flood');
},req=>new ClientAddressPolicy('127.0.0.1/32').identify(req)));

test('M1 residual: 20 sources cannot evict a legitimate pending consent after reaching capacity',()=>harness(async({request,dir})=>{
 const registerAt=async(ip:string)=>{
  const r=await request('/register',{method:'POST',headers:{
    'content-type':'application/json','x-panter-client-ip':ip},
    body:JSON.stringify({redirect_uris:[callbackA],token_endpoint_auth_method:'none'})});
  assert.equal(r.status,201);return (await r.json() as {client_id:string}).client_id;
 };
 const authorizeAt=(ip:string,clientId:string)=>{
  const query=new URLSearchParams({client_id:clientId,redirect_uri:callbackA,response_type:'code',
    code_challenge:challenge,code_challenge_method:'S256',scope:'mcp',resource,state:'flood-capacity'});
  return request('/authorize?'+query,{headers:{'x-panter-client-ip':ip}});
 };
 const originalIp='192.0.2.1';
 const originalClient=await registerAt(originalIp);
 const original=await authorizeAt(originalIp,originalClient);
 assert.equal(original.status,302);
 const location=original.headers.get('location')!;
 const cookie=original.headers.get('set-cookie')!.split(';')[0]!;
 // 20 different source IPs, each using a different client, can fill 99 free
 // slots but must NEVER cause eviction of an already opened consent.
 for(let source=2;source<=21;source++){
  const ip='192.0.2.'+source,client=await registerAt(ip);
  const limit=source===21?4:5;
  for(let j=0;j<limit;j++)assert.equal((await authorizeAt(ip,client)).status,302);
 }
 const ledger=JSON.parse(await (await import('node:fs/promises')).readFile(join(dir,'oauth.json'),'utf8'));
 assert.equal(ledger.pending.length,100);
 const over=await authorizeAt('192.0.2.21',await registerAt('192.0.2.22'));
 assert.equal(over.status,400,'At capacity, new requests fail instead of evicting unrelated pending sessions');
 const page=await request(location,{headers:{cookie}});
 assert.equal(page.status,200,
   'The legitimate operator consent must remain available despite distributed pending saturation');
 const csrf=/name="csrf" value="([^"]+)"/.exec(await page.text())?.[1]!;
 const approval=await request(location,post({csrf,password:secret,host:'gpt-a',decision:'allow'},
   {cookie,origin:issuer,'x-panter-client-ip':originalIp}));
 assert.equal(approval.status,302,'The original operator can finish consent at full pending capacity');
 assert.ok(new URL(approval.headers.get('location')!).searchParams.get('code'));
},req=>new ClientAddressPolicy('127.0.0.1/32').identify(req)));
