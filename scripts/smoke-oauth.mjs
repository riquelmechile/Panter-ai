/** Exercise the externally signed JWT authorization boundary over actual HTTP MCP. */
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const dir = await mkdtemp(join(tmpdir(), 'panter-oauth-http-'));
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const keysFile = join(dir, 'jwks.json');
const actorsFile = join(dir, 'actors.json');
const port = String(20000 + Math.floor(Math.random() * 20000));
const issuer = 'https://id.panter.example';
const resource = 'https://panter.example/mcp';
const url = new URL(`http://127.0.0.1:${port}/mcp`);
const clients = [];
let proc;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function jwt(clientId, scope = 'panter:mesh') {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test-key' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ iss: issuer, aud: resource, sub: 'owner', client_id: clientId, scope, iat: now, exp: now + 600 })).toString('base64url');
  const body = `${header}.${payload}`;
  return `${body}.${sign('RSA-SHA256', Buffer.from(body), privateKey).toString('base64url')}`;
}
async function connect(clientId, scope) {
  const c = new Client({ name: clientId, version: '1.0.0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
  const t = new StreamableHTTPClientTransport(url, { authProvider: { token: async () => jwt(clientId, scope) } });
  await c.connect(t); clients.push(c);
  return c;
}
try {
  await writeFile(keysFile, JSON.stringify({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'RS256', use: 'sig' }] }));
  await writeFile(actorsFile, JSON.stringify([
    { host: 'gpt-a', subject: 'owner', clientId: 'gpt-a-client' },
    { host: 'gpt-b', subject: 'owner', clientId: 'gpt-b-client' },
  ]));
  proc = spawn(process.execPath, ['dist/server.js'], { env: {
    ...process.env, PANTER_PORT: port, PANTER_BIND_HOST: '127.0.0.1', PANTER_DATA_DIR: dir,
    PANTER_AUTH_MODE: 'external-jwt', PANTER_OAUTH_ISSUER: issuer, PANTER_PUBLIC_MCP_URL: resource,
    PANTER_OAUTH_JWKS_FILE: keysFile, PANTER_OAUTH_ACTORS_FILE: actorsFile,
  }, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = ''; proc.stderr.on('data', c => { stderr += String(c); });
  let ready = false;
  for (let i = 0; i < 80; i++) {
    if (proc.exitCode !== null) throw new Error(`Early server exit: ${stderr}`);
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) { ready = true; break; } } catch {}
    await sleep(100);
  }
  assert.ok(ready, `OAuth MCP server not ready: ${stderr}`);
  const metadata = await fetch(`http://127.0.0.1:${port}/.well-known/oauth-protected-resource`);
  assert.equal(metadata.status, 200);
  assert.deepEqual((await metadata.json()).authorization_servers, [issuer]);
  const denied = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(denied.status, 401);
  assert.match(denied.headers.get('www-authenticate'), /resource_metadata=/);
  const wrong = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${jwt('unknown')}`, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(wrong.status, 401);
  const a = await connect('gpt-a-client', 'panter:mesh panter:lead');
  const b = await connect('gpt-b-client');
  const config = await a.callTool({ name: 'panter_mesh_profile_set', arguments: { host: 'gpt-b', actorId: 'actor-b', modelRequest: 'host-default', effortRequest: 'max', roles: ['reviewer'], expectedRevision: 0 } });
  assert.ok(!config.isError, JSON.stringify(config.content));
  const forbidden = await b.callTool({ name: 'panter_mesh_profile_set', arguments: { host: 'gpt-b', actorId: 'actor-override', modelRequest: 'bad', effortRequest: 'max', roles: ['reviewer'], expectedRevision: 1 } });
  assert.ok(forbidden.isError, 'Non-leader must not be able to configure other hosts');
  const task = await a.callTool({ name: 'panter_mesh_delegate', arguments: { missionId: 'auth-mission', target: 'gpt-b', role: 'reviewer', instruction: 'Review this implementation', idempotencyKey: 'auth-1' } });
  assert.ok(!task.isError, JSON.stringify(task.content));
  const work = JSON.parse(task.content.find(x => x.type === 'text').text);
  const pending = await b.callTool({ name: 'panter_mesh_pending', arguments: {} });
  assert.ok(JSON.parse(pending.content.find(x => x.type === 'text').text).some(x => x.workId === work.id));
  const claimed = await b.callTool({ name: 'panter_mesh_claim', arguments: { workId: work.id } });
  const attempt = JSON.parse(claimed.content.find(x => x.type === 'text').text);
  const finished = await b.callTool({ name: 'panter_mesh_complete', arguments: { workId: work.id, attemptId: attempt.attemptId, leaseGeneration: attempt.leaseGeneration, result: 'Review complete' } });
  assert.ok(!finished.isError, JSON.stringify(finished.content));
  const result = JSON.parse((await a.callTool({ name: 'panter_mesh_inbox', arguments: { since: 0 } })).content.find(x => x.type === 'text').text);
  assert.ok(result.messages.some(x => x.workId === work.id && x.text === 'Review complete'));
  console.log('PASS OAuth resource discovery + JWT verification + client-bound actors + GPT-A/GPT-B A2A round trip');
} finally {
  for (const c of clients) await c.close().catch(() => {});
  if (proc) proc.kill('SIGTERM');
  await rm(dir, { recursive: true, force: true });
}
