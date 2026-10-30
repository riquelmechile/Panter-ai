/** Real HTTP SDK test: embedded OAuth (DCR, consent, PKCE) -> host-bound MCP -> A2A return. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { request as unixRequest } from 'node:http';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const dir = await mkdtemp(join(tmpdir(), 'panter-embedded-http-'));
const port = String(20000 + Math.floor(Math.random() * 20000));
const base = `http://127.0.0.1:${port}`;
const socketPath=join(dir,'operator.sock');
const issuer = 'https://panter.test.example';
const resource = issuer + '/mcp';
const callback = 'https://chatgpt.com/connector_platform_oauth_redirect';
const secret = 'only-for-test-embedded-oauth-password-with-entropy';
const operatorSecret = 'only-for-test-operator-mcp-control-secret-with-entropy';
const verifier = 'b'.repeat(64);
const challenge = createHash('sha256').update(verifier).digest('base64url');
const clients = [];
let proc;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const post = (data, headers = {}) => ({ method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(data) });
const request = (path, opts = {}) => fetch(base + path, { redirect: 'manual', ...opts });
async function authorize(host) {
  const registration = await request('/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: host, redirect_uris: [callback], token_endpoint_auth_method: 'none' }) });
  assert.equal(registration.status, 201);
  const client = (await registration.json()).client_id;
  const url = new URLSearchParams({ client_id: client, redirect_uri: callback, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', scope: 'mcp offline_access', state: 'verify-return', resource });
  const started = await request('/authorize?' + url); assert.equal(started.status, 302);
  const cookie = started.headers.get('set-cookie').split(';')[0];
  const path = started.headers.get('location');
  const consent = await request(path, { headers: { cookie } }); assert.equal(consent.status, 200);
  const csrf = /name="csrf" value="([^"]+)"/.exec(await consent.text())?.[1]; assert.ok(csrf);
  const approved = await request(path, post({ csrf, password: secret, host, decision: 'allow' }, { origin: issuer, cookie }));
  assert.equal(approved.status, 302);
  const redirect = new URL(approved.headers.get('location'));
  const code = redirect.searchParams.get('code'); assert.ok(code);
  const exchanged = await request('/token', post({ grant_type: 'authorization_code', code, client_id: client, redirect_uri: callback, code_verifier: verifier, resource }));
  assert.equal(exchanged.status, 200);
  return { client, ...await exchanged.json() };
}
async function connect(credentials) {
  const client = new Client({ name: credentials.client, version: '1.0.0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
  const transport = new StreamableHTTPClientTransport(new URL(base + '/mcp'), { authProvider: { token: async () => credentials.access_token } });
  await client.connect(transport); clients.push(client);
  return client;
}
const unpack = result => JSON.parse(result.content.find(x => x.type === 'text').text);
let rpcId=100;
async function operatorCall(name,args={}){
  const body=JSON.stringify({jsonrpc:'2.0',id:rpcId++,method:'tools/call',params:{name,arguments:args}});
  const result=await new Promise((ok,fail)=>{
    const req=unixRequest({socketPath,path:'/mcp',method:'POST',
      headers:{authorization:`Bearer ${operatorSecret}`,'content-type':'application/json',
        accept:'application/json, text/event-stream','mcp-protocol-version':'2026-07-28',
        'content-length':Buffer.byteLength(body)}},res=>{
      let text='';res.setEncoding('utf8');res.on('data',c=>text+=c);
      res.on('end',()=>ok({status:res.statusCode,text}));
    });
    req.on('error',fail);req.end(body);
  });
  assert.equal(result.status,200,'Operator socket request failed: '+result.text);
  const payload=result.text.trim().startsWith('{')?JSON.parse(result.text):
    JSON.parse(result.text.split('\n').filter(x=>x.startsWith('data:')).at(-1).slice(5).trim());
  assert.equal(payload.jsonrpc,'2.0');return payload.result;
}
try {
  proc = spawn(process.execPath, ['dist/server.js'], { env: {
    ...process.env, PANTER_PORT: port, PANTER_BIND_HOST: '127.0.0.1', PANTER_DATA_DIR: dir,
    PANTER_AUTH_MODE: 'embedded', PANTER_PUBLIC_MCP_URL: resource,
    PANTER_OAUTH_REDIRECT_URIS: callback, PANTER_CONSENT_PASSWORD: secret,
    PANTER_OPERATOR_TOKEN: operatorSecret, PANTER_ADMIN_SOCKET: socketPath,
  }, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = ''; proc.stderr.on('data', c => stderr += String(c));
  let ready = false;
  for (let i = 0; i < 80; i++) {
    if (proc.exitCode !== null) throw new Error(`Server failed: ${stderr}`);
    try { if ((await request('/health')).status === 200) { ready = true; break; } } catch {}
    await sleep(100);
  }
  assert.ok(ready, `Server not ready: ${stderr}`);
  assert.equal((await request('/.well-known/oauth-authorization-server')).status, 200);
  assert.equal((await request('/mcp', { method: 'POST' })).status, 401);
  const aCredentials = await authorize('gpt-a'), bCredentials = await authorize('gpt-b');
  assert.notEqual(aCredentials.client, bCredentials.client);
  const a = await connect(aCredentials), b = await connect(bCredentials);
  const socketStat=await stat(socketPath);
  assert.ok(socketStat.isSocket());
  assert.equal(socketStat.mode&0o777,0o600,'Private Unix socket must be mode 0600');
  const forgedOperator=await request('/mcp',{method:'POST',headers:{
    host:'127.0.0.1:'+port,authorization:`Bearer ${operatorSecret}`,
    'content-type':'application/json'},body:'{}'});
  assert.equal(forgedOperator.status,401,
    'Public TCP must never grant operator access, even when Host is localhost');
  const operator={callTool:({name,arguments:args})=>operatorCall(name,args)};
  const requestGrant = { project:'operator-check', objective:'Authorized test change',
    allowedPaths:['src/auth.ts'],ttlSeconds:600 };
  const deniedGrant = await a.callTool({name:'panter_harness_write_grant',arguments:requestGrant});
  assert.ok(deniedGrant.isError,'An OAuth GPT-A client must never issue an operator write grant');
  const granted = await operator.callTool({name:'panter_harness_write_grant',arguments:requestGrant});
  assert.ok(!granted.isError,JSON.stringify(granted.content));
  assert.ok(unpack(granted).grantId,'Only the authenticated loopback operator can grant writes');
  let notify;
  const signal = new Promise(resolve => { notify = resolve; });
  a.setNotificationHandler('notifications/resources/updated', msg => {
    if (msg.params?.uri === 'panter://mesh/changed') notify(msg);
  });
  const listening = await a.listen({ resourceSubscriptions: ['panter://mesh/changed'] });
  assert.ok(listening.honoredFilter?.resourceSubscriptions?.includes('panter://mesh/changed'));
  const profile = await a.callTool({ name: 'panter_mesh_profile_set', arguments: { host: 'gpt-b', actorId: 'embedded-gpt-b', modelRequest: 'host-default', effortRequest: 'max', roles: ['reviewer'], expectedRevision: 0 } });
  assert.ok(!profile.isError, JSON.stringify(profile.content));
  await Promise.race([signal, sleep(7000).then(() => { throw new Error('No authenticated MCP listen event'); })]);
  const denied = await b.callTool({ name: 'panter_mesh_profile_set', arguments: { host: 'gpt-b', actorId: 'hijack', modelRequest: 'bad', effortRequest: 'max', roles: ['reviewer'], expectedRevision: 1 } });
  assert.ok(denied.isError);
  const task = await a.callTool({ name: 'panter_mesh_delegate', arguments: { missionId: 'smoke', target: 'gpt-b', role: 'reviewer', instruction: 'Review RFC 9207', idempotencyKey: 'oauth-embedded-1' } });
  assert.ok(!task.isError, JSON.stringify(task.content)); const work = unpack(task);
  assert.ok(unpack(await b.callTool({ name: 'panter_mesh_pending', arguments: {} })).some(x => x.workId === work.id));
  const attempt = unpack(await b.callTool({ name: 'panter_mesh_claim', arguments: { workId: work.id } }));
  const completed = await b.callTool({ name: 'panter_mesh_complete', arguments: { workId: work.id, attemptId: attempt.attemptId, leaseGeneration: attempt.leaseGeneration, result: 'Reviewed' } });
  assert.ok(!completed.isError);
  const inbox = unpack(await a.callTool({ name: 'panter_mesh_inbox', arguments: { since: 0 } }));
  assert.ok(inbox.messages.some(x => x.workId === work.id && x.text === 'Reviewed'));
  const revoke = await request('/revoke', post({ client_id: bCredentials.client, token: bCredentials.refresh_token }));
  assert.equal(revoke.status, 200);
  const unauthorized = await request('/mcp', { method: 'POST', headers: { authorization: `Bearer ${bCredentials.access_token}`, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(unauthorized.status, 401);
  const list=await operator.callTool({name:'panter_oauth_clients',arguments:{}});
  assert.ok(!list.isError,JSON.stringify(list.content));
  assert.ok(unpack(list).some(x=>x.clientId===aCredentials.client));
  const forbiddenList=await a.callTool({name:'panter_oauth_clients',arguments:{}});
  assert.ok(forbiddenList.isError,'AI clients cannot inspect OAuth connection administration');
  const adminRevoked=await operator.callTool({name:'panter_oauth_client_revoke',arguments:{clientId:aCredentials.client}});
  assert.ok(!adminRevoked.isError,JSON.stringify(adminRevoked.content));
  const revokedAccess=await request('/mcp',{method:'POST',headers:{
    authorization:`Bearer ${aCredentials.access_token}`,'content-type':'application/json'
  },body:'{}'});
  assert.equal(revokedAccess.status,401,'Operator revocation must invalidate live access immediately');
  await listening.close();
  console.log('PASS embedded DCR -> PKCE -> human consent -> Unix-only operator grant / public TCP denied -> subscriptions/listen -> actor-bound A2A -> revoke 401');
} finally {
  for (const client of clients) await client.close().catch(() => {});
  if (proc) proc.kill('SIGTERM');
  await rm(dir, { recursive: true, force: true });
}
