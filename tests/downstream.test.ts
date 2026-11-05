import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { Client, InMemoryTransport, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import * as z from 'zod/v4';
import { DownstreamGateway, classify, parseDownstreamConfig, type DownstreamConfig } from '../src/core/downstream.js';
import { createToolSurface } from '../src/core/tool-surface.js';
import { SqliteLedger } from '../src/core/sqlite-ledger.js';
import { verifyActorAssertion } from '../src/core/actor-assertion.js';

const HOSTS = ['gpt-a', 'gpt-b', 'grok', 'gemini', 'claude'] as const;
const TOKEN = 'downstream-test-token-0123456789';

/** A real downstream MCP server over HTTP that checks its bearer token and records what reached it. */
async function downstreamServer() {
  const seen: Array<{ tool: string; args: unknown; meta: unknown }> = [];
  let lastAuth = '';
  let delayMs = 0, down = false, flipDestructive = false, mode: 'ok' | 'echo500' | 'redirect' = 'ok', pad = 0;
  // Which bearer tokens are accepted, and how long the n-th refusal (from 1) takes to arrive.
  let accepts = (auth: string): boolean => auth === `Bearer ${TOKEN}`, refusals = 0, refuseDelay = (_n: number) => 0, forbid = false;
  const handler = toNodeHandler(createMcpHandler(() => {
    const s = new McpServer({ name: 'shop', version: '1' });
    const record = (tool: string) => async (args: unknown, ctx: any) => {
      seen.push({ tool, args, meta: ctx?.mcpReq?._meta ?? null });
      if (delayMs) await new Promise(r => setTimeout(r, delayMs));
      return { content: [{ type: 'text' as const, text: `${tool} ok` }] };
    };
    s.registerTool('lookup', { description: 'Read a product.', inputSchema: z.object({ sku: z.string() }), annotations: { readOnlyHint: true } }, record('lookup'));
    s.registerTool('set_price', { description: 'Change a price.', inputSchema: z.object({ sku: z.string(), price: z.number() }), annotations: { readOnlyHint: false, destructiveHint: false } }, record('set_price'));
    s.registerTool('delete_item', { description: 'Delete a product.', inputSchema: z.object({ sku: z.string() }), annotations: { readOnlyHint: false, destructiveHint: true } }, record('delete_item'));
    s.registerTool('legacy', { description: 'No annotations at all.', inputSchema: z.object({}) }, record('legacy'));
    s.registerTool('slow', { description: 'Slow read.', inputSchema: z.object({}), annotations: { readOnlyHint: true } },
      async () => { await new Promise(r => setTimeout(r, 1500)); return { content: [{ type: 'text' as const, text: 'slow ok' }] }; });
    s.registerTool('huge', { description: 'Huge read.', inputSchema: z.object({ bytes: z.number().optional() }), annotations: { readOnlyHint: true } },
      async (a: any) => ({ content: [{ type: 'text' as const, text: 'x'.repeat(a.bytes ?? 5_000_000) }] }));
    s.registerTool('leaky', { description: 'A broken read that echoes the request headers.', inputSchema: z.object({}), annotations: { readOnlyHint: true } },
      async (_a: unknown, ctx: any) => { const auth = String(ctx?.http?.req?.headers?.authorization ?? ctx?.http?.headers?.get?.('authorization') ?? lastAuth);
        return { isError: true, content: [{ type: 'text' as const, text: `failed; request had ${auth}` }], structuredContent: { echoed: auth } }; });
    s.registerTool('slow_leaky', { description: 'A slow broken read that echoes the token it was called with.', inputSchema: z.object({}), annotations: { readOnlyHint: true } },
      async () => { const auth = lastAuth; await new Promise(r => setTimeout(r, 300)); return { isError: true, content: [{ type: 'text' as const, text: `failed; request had ${auth}` }] }; });
    s.registerTool('flip', { description: 'Read until it is not.', inputSchema: z.object({}), annotations: flipDestructive ? { readOnlyHint: false } : { readOnlyHint: true } }, record('flip'));
    return s;
  }));
  const http: Server = createServer((req, res) => {
    if (down) { req.socket.destroy(); return; }
    if (mode === 'redirect') { res.writeHead(307, { location: 'http://127.0.0.1:9/mcp' }).end(); return; }
    // A broken server that echoes the request's Authorization header back in an error body.
    if (mode === 'echo500') { res.writeHead(500, { 'content-type': 'text/plain' }).end('e'.repeat(pad) + ' echo ' + String(req.headers.authorization)); return; }
    if (!accepts(String(req.headers.authorization ?? ''))) { setTimeout(() => res.writeHead(401).end(), refuseDelay(++refusals)); return; }
    lastAuth = String(req.headers.authorization);
    if (forbid && req.method === 'POST') {
      let raw = ''; req.on('data', c => { raw += c; });
      req.on('end', () => { if (/"tools\/call"/.test(raw)) res.writeHead(403, { 'www-authenticate': 'Bearer error="insufficient_scope", scope="write"' }).end(); else res.writeHead(400).end(); });
      return;
    }
    handler(req, res);
  });
  await new Promise<void>(r => http.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(http.address() as { port: number }).port}/mcp`;
  return { url, seen, setDelay: (ms: number) => { delayMs = ms; }, setDown: (v: boolean) => { down = v; }, setFlip: (v: boolean) => { flipDestructive = v; },
    setMode: (m: typeof mode, p = 0) => { mode = m; pad = p; },
    setForbid: (v: boolean) => { forbid = v; },
    setAccepts: (f: (auth: string) => boolean, delay: (n: number) => number = () => 0) => { accepts = f; refusals = 0; refuseDelay = delay; }, close: () => new Promise(r => { http.closeAllConnections?.(); http.close(r); }) };
}

async function world(over: Partial<DownstreamConfig> = {}, env: Record<string, string> = { PANTER_DOWNSTREAM_SHOP_TOKEN: TOKEN }) {
  const ds = await downstreamServer();
  const dir = await mkdtemp(join(tmpdir(), 'panter-ds-'));
  const config: DownstreamConfig = { name: 'shop', url: ds.url, tokenEnv: 'PANTER_DOWNSTREAM_SHOP_TOKEN', hosts: ['claude'], writes: 'grant', timeoutMs: 2000, description: 'test shop', sensitive: false, ...over };
  let clock = Date.now();
  const gw = new DownstreamGateway([config], SqliteLedger.open(dir), env, () => clock);
  return { ds, gw, dir, config, env, now: () => clock, advance: (ms: number) => { clock += ms; }, done: async () => { await gw.close(); await ds.close(); await rm(dir, { recursive: true, force: true }); } };
}
const text = (r: any) => r.content?.[0]?.text as string;
const claude = { id: 'claude', operator: false }, grok = { id: 'grok', operator: false }, operator = { id: 'admin', operator: true };

test('config is validated strictly: names, addresses, token variables and hosts', () => {
  const ok = parseDownstreamConfig(JSON.stringify({ servers: [{ name: 'shop', url: 'http://127.0.0.1:18100/mcp', tokenEnv: 'PANTER_DOWNSTREAM_SHOP', hosts: ['claude'] }] }), HOSTS);
  assert.deepEqual(ok[0], { name: 'shop', url: 'http://127.0.0.1:18100/mcp', tokenEnv: 'PANTER_DOWNSTREAM_SHOP', hosts: ['claude'], writes: 'grant', timeoutMs: 30000, description: '', sensitive: false });
  const bad = (server: object, why: RegExp) => assert.throws(() => parseDownstreamConfig(JSON.stringify({ servers: [{ name: 'shop', url: 'http://127.0.0.1:1/mcp', ...server }] }), HOSTS), why);
  bad({ url: 'http://example.com/mcp' }, /url must be https/);
  bad({ url: 'https://user:pw@example.com/mcp' }, /url/);
  bad({ tokenEnv: 'PANTER_TOKEN' }, /tokenEnv/);
  bad({ hosts: ['someone'] }, /hosts/);
  bad({ writes: 'yes' }, /writes/);
  bad({ name: 'Shop!' }, /name/);
  for (const url of ['http://10.evil.example/mcp', 'http://127.attacker.example/mcp', 'http://192.168.x.example/mcp', 'http://8.8.8.8/mcp', 'https://a.example/mcp?token=x'])
    bad({ url }, /url/);
  for (const url of ['http://10.0.0.5:8080/mcp', 'http://[::1]:9000/mcp', 'http://[fd12::1]/mcp', 'http://localhost:1/mcp'])
    assert.equal(parseDownstreamConfig(JSON.stringify({ servers: [{ name: 'ok', url }] }), HOSTS)[0]!.url, url);
  bad({ extra: 1 }, /unknown field/);
  bad({ sensitive: 'yes' }, /sensitive must be true or false/);
  assert.equal(parseDownstreamConfig('{"servers":[{"name":"clinic","url":"https://c.example/mcp","sensitive":true}]}', HOSTS)[0]!.sensitive, true);
  assert.throws(() => parseDownstreamConfig('{"servers":[{"name":"a1","url":"https://a.example/mcp"},{"name":"a1","url":"https://b.example/mcp"}]}', HOSTS), /duplicate/);
  assert.equal(parseDownstreamConfig('{"servers":[{"name":"remote","url":"https://mcp.example.com/mcp"}]}', HOSTS)[0]!.url, 'https://mcp.example.com/mcp');
});

test('tools are classified the MCP way: destructive unless they say otherwise', () => {
  assert.equal(classify({ readOnlyHint: true }), 'read');
  assert.equal(classify({ destructiveHint: false }), 'write');
  assert.equal(classify({ readOnlyHint: false }), 'destructive');
  assert.equal(classify(undefined), 'destructive');
});

test('reads pass through with the token and the calling host; other hosts are refused', async () => {
  const w = await world();
  try {
    assert.deepEqual(await w.gw.refresh('shop'), { server: 'shop', tools: 9 });
    assert.deepEqual(w.gw.tools('shop').slice(0, 4).map(t => [t.name, t.cls]), [['lookup', 'read'], ['set_price', 'write'], ['delete_item', 'destructive'], ['legacy', 'destructive']]);
    const r = await w.gw.call(claude, 'shop', 'lookup', { sku: 'A1' });
    assert.equal(text(r), 'lookup ok');
    assert.deepEqual({ ...w.ds.seen[0], meta: { ...(w.ds.seen[0]!.meta as any), 'panter-ai/callId': undefined, 'panter-ai/actor': undefined } }, { tool: 'lookup', args: { sku: 'A1' }, meta: { 'panter-ai/host': 'claude', 'panter-ai/role': 'worker', 'panter-ai/callId': undefined, 'panter-ai/actor': undefined } });
    const no = await w.gw.call(grok, 'shop', 'lookup', { sku: 'A1' });
    assert.equal(no.isError, true); assert.match(text(no), /may not use/);
    assert.equal(w.ds.seen.length, 1, 'a refused call never reaches the server');
    assert.deepEqual(w.gw.status(grok), [], 'a host not allowed does not even see the server');
    const audit = w.gw.audit(operator);
    assert.deepEqual(audit.map(a => [a.host, a.tool, a.outcome]), [['claude', 'lookup', 'OK']], 'a caller without access is counted, not audited');
    assert.deepEqual(w.gw.refusedOutsiders(operator).map(x => [x.host, x.server, x.refused]), [['grok', 'shop', 1]]);
    assert.ok(audit.every(a => /^[0-9a-f]{64}$/.test(a.argsSha256 ?? '') && !JSON.stringify(a).includes('A1')), 'arguments are only hashed');
  } finally { await w.done(); }
});

test('writes need a grant for that host and tool; destructive tools must be named; uses and expiry are enforced', async () => {
  const w = await world();
  try {
    assert.match(text(await w.gw.call(claude, 'shop', 'set_price', { sku: 'A1', price: 5 })), /needs a grantId/);
    const g = w.gw.grant({ server: 'shop', tools: '*', host: 'claude', ttlSeconds: 600, uses: 1, reason: 'repricing' });
    assert.match(text(await w.gw.call(grok, 'shop', 'set_price', { sku: 'A1', price: 5 }, g.id)), /may not use/);
    assert.match(text(await w.gw.call(claude, 'shop', 'delete_item', { sku: 'A1' }, g.id)), /destructive tools must be named/);
    const ok = await w.gw.call(claude, 'shop', 'set_price', { sku: 'A1', price: 5 }, g.id);
    assert.equal(text(ok), 'set_price ok');
    assert.deepEqual({ ...(w.ds.seen.at(-1)!.meta as any), 'panter-ai/callId': undefined, 'panter-ai/actor': undefined }, { 'panter-ai/host': 'claude', 'panter-ai/role': 'worker', 'panter-ai/grantId': g.id, 'panter-ai/callId': undefined, 'panter-ai/actor': undefined });
    assert.match(text(await w.gw.call(claude, 'shop', 'set_price', { sku: 'A1', price: 6 }, g.id)), /used up/);
    const named = w.gw.grant({ server: 'shop', tools: ['delete_item'], host: 'claude', ttlSeconds: 60, uses: 5, reason: 'cleanup' });
    assert.equal(text(await w.gw.call(claude, 'shop', 'delete_item', { sku: 'A1' }, named.id)), 'delete_item ok');
    assert.match(text(await w.gw.call(claude, 'shop', 'set_price', { sku: 'A1', price: 6 }, named.id)), /does not cover set_price/);
    w.advance(61_000);
    assert.match(text(await w.gw.call(claude, 'shop', 'delete_item', { sku: 'A2' }, named.id)), /expired/);
    const r = w.gw.grant({ server: 'shop', tools: ['legacy'], host: 'claude', ttlSeconds: 600, uses: 5, reason: 'x' });
    assert.deepEqual(w.gw.revoke(r.id), { revoked: true });
    assert.match(text(await w.gw.call(claude, 'shop', 'legacy', {}, r.id)), /revoked/);
    assert.throws(() => w.gw.grant({ server: 'shop', tools: '*', host: 'grok', ttlSeconds: 600, uses: 1, reason: 'x' }), /may not use/);
    // The operator acts without a grant.
    assert.equal(text(await w.gw.call(operator, 'shop', 'delete_item', { sku: 'B1' })), 'delete_item ok');
    assert.equal(w.ds.seen.filter(s => s.tool !== 'lookup').length, 3, 'only granted calls reached the server');
  } finally { await w.done(); }
});

test('two calls cannot share the last use of a grant', async () => {
  const w = await world();
  try {
    await w.gw.refresh('shop');
    const g = w.gw.grant({ server: 'shop', tools: '*', host: 'claude', ttlSeconds: 600, uses: 1, reason: 'once' });
    const results = await Promise.all([1, 2, 3].map(i => w.gw.call(claude, 'shop', 'set_price', { sku: 'A1', price: i }, g.id)));
    assert.equal(results.filter(r => !r.isError).length, 1);
    assert.equal(w.ds.seen.length, 1);
  } finally { await w.done(); }
});

test('writes: deny refuses every write and grant; allow lets allowed hosts write without one', async () => {
  const deny = await world({ writes: 'deny' });
  try {
    assert.match(text(await deny.gw.call(claude, 'shop', 'set_price', { sku: 'A1', price: 5 })), /writes: deny/);
    assert.match(text(await deny.gw.call(operator, 'shop', 'set_price', { sku: 'A1', price: 5 })), /writes: deny/);
    assert.throws(() => deny.gw.grant({ server: 'shop', tools: '*', host: 'claude', ttlSeconds: 600, uses: 1, reason: 'x' }), /accepts no writes/);
    assert.equal(text(await deny.gw.call(claude, 'shop', 'lookup', { sku: 'A1' })), 'lookup ok');
  } finally { await deny.done(); }
  const allow = await world({ writes: 'allow' });
  try { assert.equal(text(await allow.gw.call(claude, 'shop', 'delete_item', { sku: 'A1' })), 'delete_item ok'); }
  finally { await allow.done(); }
});

test('timeouts and failures open the circuit, which fails fast and closes again', async () => {
  const w = await world();
  try {
    await w.gw.refresh('shop');
    w.ds.setDelay(5000);
    const slow = await w.gw.call(claude, 'shop', 'lookup', { sku: 'A1' });
    assert.equal(slow.isError, true); assert.match(text(slow), /failed/);
    w.ds.setDelay(0); w.ds.setDown(true);
    for (let i = 0; i < 2; i++) assert.equal((await w.gw.call(claude, 'shop', 'lookup', { sku: 'A1' })).isError, true);
    assert.equal(w.gw.status(claude)[0]!.state, 'CIRCUIT_OPEN');
    const before = w.ds.seen.length;
    const fast = await w.gw.call(claude, 'shop', 'lookup', { sku: 'A1' });
    assert.match(text(fast), /circuit open/);
    w.ds.setDown(false);
    w.advance(31_000);
    assert.equal(text(await w.gw.call(claude, 'shop', 'lookup', { sku: 'A1' })), 'lookup ok');
    assert.equal(w.gw.status(claude)[0]!.state, 'OK');
    assert.equal(w.ds.seen.length, before + 1);
    assert.ok(w.gw.audit(operator).some(a => a.outcome === 'FAILED'));
  } finally { await w.done(); }
});

test('a missing or wrong token is reported without leaking it', async () => {
  const missing = await world({}, {});
  try {
    assert.equal(missing.gw.status(claude)[0]!.state, 'TOKEN_MISSING');
    assert.match(text(await missing.gw.call(claude, 'shop', 'lookup', { sku: 'A1' })), /PANTER_DOWNSTREAM_SHOP_TOKEN is not set/);
  } finally { await missing.done(); }
  const wrong = await world({}, { PANTER_DOWNSTREAM_SHOP_TOKEN: 'wrong-token-but-secret-123456' });
  try {
    const r = await wrong.gw.call(claude, 'shop', 'lookup', { sku: 'A1' });
    assert.equal(r.isError, true);
    assert.ok(!JSON.stringify(r).includes('wrong-token-but-secret') && !JSON.stringify(wrong.gw.status(claude)).includes('wrong-token-but-secret'));
  } finally { await wrong.done(); }
});

test('a downstream router is listed only where allowed, and the operator sees it', async () => {
  for (const [role, allowed, listed] of [['leader', true, true], ['worker', false, false], ['operator', false, true]] as const) {
    const server = new McpServer({ name: 't', version: '1' });
    const surface = createToolSurface(server, { role: () => role });
    surface.external('panter_ds_shop', { description: 'shop', inputSchema: z.object({ operation: z.string() }) }, async () => ({ content: [{ type: 'text' as const, text: 'hit' }] }), () => allowed);
    surface.finalize();
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'c', version: '1' });
    await Promise.all([server.connect(b), client.connect(a)]);
    const names = (await client.listTools()).tools.map(t => t.name);
    assert.equal(names.includes('panter_ds_shop'), listed, role);
    assert.ok(!JSON.stringify(await client.callTool({ name: 'panter_admin', arguments: { operation: 'index' } })).includes('panter_ds_shop'), 'not inside a domain router');
    await client.close();
  }
});

test('end to end: the built server mounts a downstream server for the hosts its config allows', { skip: !existsSync(new URL('../dist/server.js', import.meta.url)) }, async () => {
  const ds = await downstreamServer();
  const dir = await mkdtemp(join(tmpdir(), 'panter-ds-e2e-'));
  const config = join(dir, 'downstream.json');
  await writeFile(config, JSON.stringify({ servers: [{ name: 'shop', url: ds.url, tokenEnv: 'PANTER_DOWNSTREAM_SHOP_TOKEN', hosts: ['claude'], timeoutMs: 5000 }] }));
  const tokens = { claude: 'panter-actor-claude-ds-token-123456789', grok: 'panter-actor-grok-ds-token-1234567890' };
  const port = String(22000 + Math.floor(Math.random() * 20000));
  const proc = spawn(process.execPath, [new URL('../dist/server.js', import.meta.url).pathname], { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env,
    PANTER_PORT: port, PANTER_BIND_HOST: '127.0.0.1', PANTER_TOKEN: 'panter-admin-ds-token-987654321', PANTER_PEER_TOKENS: JSON.stringify(tokens),
    PANTER_DATA_DIR: join(dir, 'data'), PANTER_LEAD_HOST: 'claude', PANTER_DOWNSTREAM_CONFIG: config, PANTER_DOWNSTREAM_SHOP_TOKEN: TOKEN } });
  let stderr = ''; proc.stderr!.on('data', c => { stderr += String(c); });
  const clients: Client[] = [];
  const connect = async (host: keyof typeof tokens) => {
    const c = new Client({ name: host, version: '1' });
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { authProvider: { token: async () => tokens[host] } } as any));
    clients.push(c); return c;
  };
  try {
    for (let i = 0; i < 100; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch {} await new Promise(r => setTimeout(r, 100)); }
    const lead = await connect('claude'), grokClient = await connect('grok');
    assert.ok((await lead.listTools()).tools.some(t => t.name === 'panter_ds_shop'), stderr);
    assert.ok(!(await grokClient.listTools()).tools.some(t => t.name === 'panter_ds_shop'));
    const index = JSON.parse(text(await lead.callTool({ name: 'panter_ds_shop', arguments: { operation: 'index' } })));
    assert.deepEqual(index.operations.slice(0, 4).map((o: any) => [o.operation, o.class]), [['lookup', 'read'], ['set_price', 'write'], ['delete_item', 'destructive'], ['legacy', 'destructive']]);
    assert.equal(index.status.server, 'shop');
    const peek = await grokClient.callTool({ name: 'panter_ds_shop', arguments: { operation: 'index' } });
    assert.equal(peek.isError, true); assert.match(text(peek), /may not use/);
    assert.equal(text(await lead.callTool({ name: 'panter_ds_shop', arguments: { operation: 'lookup', arguments: { sku: 'A1' } } })), 'lookup ok');
    assert.equal((ds.seen.at(-1)!.meta as any)['panter-ai/host'], 'claude');
    assert.match(text(await lead.callTool({ name: 'panter_ds_shop', arguments: { operation: 'set_price', arguments: { sku: 'A1', price: 2 } } })), /needs a grantId/);
    assert.match(text(await grokClient.callTool({ name: 'panter_ds_shop', arguments: { operation: 'lookup', arguments: { sku: 'A1' } } })), /may not use/);
    assert.match(text(await lead.callTool({ name: 'panter_downstream_grant', arguments: { server: 'shop', host: 'claude', tools: '*', reason: 'x' } })), /Operator/);
    const st = JSON.parse(text(await lead.callTool({ name: 'panter_downstream_status', arguments: {} })));
    assert.equal(st.servers[0].state, 'OK');
    assert.equal(ds.seen.length, 1, 'only the allowed read reached the downstream server');
  } finally {
    for (const c of clients) await c.close().catch(() => undefined);
    proc.kill('SIGTERM'); await ds.close(); await rm(dir, { recursive: true, force: true });
  }
});

test('end to end: a sensitive server signs who calls and keeps its mission free of personal data', { skip: !existsSync(new URL('../dist/server.js', import.meta.url)) }, async () => {
  const ds = await downstreamServer();
  const RUN = '7f4c1a52-3c1e-4c55-9a51-6f1d2b9e0a11';
  const dir = await mkdtemp(join(tmpdir(), 'panter-ds-e2e-s-'));
  const config = join(dir, 'downstream.json');
  await writeFile(config, JSON.stringify({ servers: [{ name: 'clinic', url: ds.url, tokenEnv: 'PANTER_DOWNSTREAM_SHOP_TOKEN', hosts: ['claude', 'grok'], timeoutMs: 5000, sensitive: true }] }));
  const tokens = { claude: 'panter-actor-claude-ds-token-123456789', grok: 'panter-actor-grok-ds-token-1234567890' };
  const port = String(22000 + Math.floor(Math.random() * 20000));
  const proc = spawn(process.execPath, [new URL('../dist/server.js', import.meta.url).pathname], { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env,
    PANTER_PORT: port, PANTER_BIND_HOST: '127.0.0.1', PANTER_TOKEN: 'panter-admin-ds-token-987654321', PANTER_PEER_TOKENS: JSON.stringify(tokens),
    PANTER_DATA_DIR: join(dir, 'data'), PANTER_LEAD_HOST: 'claude', PANTER_DOWNSTREAM_CONFIG: config, PANTER_DOWNSTREAM_SHOP_TOKEN: TOKEN } });
  let stderr = ''; proc.stderr!.on('data', c => { stderr += String(c); });
  const clients: Client[] = [];
  const connect = async (host: keyof typeof tokens) => {
    const c = new Client({ name: host, version: '1' });
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { authProvider: { token: async () => tokens[host] } } as any));
    clients.push(c); return c;
  };
  try {
    for (let i = 0; i < 100; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch {} await new Promise(r => setTimeout(r, 100)); }
    const keys = await (await fetch(`http://127.0.0.1:${port}/.well-known/panter-downstream-keys`)).json() as { keys: any[] };
    assert.equal(keys.keys[0].crv, 'Ed25519', stderr);
    const lead = await connect('claude'), worker = await connect('grok');
    assert.match(text(await lead.callTool({ name: 'panter_ds_clinic', arguments: { operation: 'lookup', arguments: { sku: 'A1' } } })), /must name its missionId/);
    assert.equal(text(await lead.callTool({ name: 'panter_ds_clinic', arguments: { operation: 'lookup', arguments: { sku: 'A1' }, missionId: RUN } })), 'lookup ok');
    assert.equal(text(await worker.callTool({ name: 'panter_ds_clinic', arguments: { operation: 'lookup', arguments: { sku: 'B2' }, missionId: RUN } })), 'lookup ok');
    const [a, b] = ds.seen.map(x => (x.meta as any)['panter-ai/actor']);
    const claimsA = verifyActorAssertion(a, keys.keys[0], { aud: 'clinic', tool: 'lookup', args: { sku: 'A1' } });
    const claimsB = verifyActorAssertion(b, keys.keys[0], { aud: 'clinic', tool: 'lookup', args: { sku: 'B2' } });
    assert.deepEqual([claimsA.sub, claimsA.role, claimsA.mission, claimsB.sub, claimsB.role], ['claude', 'leader', RUN, 'grok', 'worker']);
    const st = JSON.parse(text(await lead.callTool({ name: 'panter_downstream_status', arguments: {} })));
    assert.deepEqual(st.actorKeys, keys);
    assert.equal(st.servers[0].sensitive, true);
    // The mission is now sensitive: Panter refuses to store personal data for it, and still stores clean text.
    const profile = await lead.callTool({ name: 'panter_mesh_profile_set', arguments: { host: 'grok', actorId: 'actor-grok-001', modelRequest: 'host-default', effortRequest: 'max', roles: ['reviewer'], expectedRevision: 0 } });
    assert.notEqual(profile.isError, true, text(profile));
    const delegate = (instruction: string, idempotencyKey: string) => lead.callTool({ name: 'panter_mesh_delegate', arguments: { missionId: RUN, target: 'grok', role: 'reviewer', instruction, idempotencyKey } });
    const refused = await delegate('Check patient 12.345.678-5', 'k1');
    assert.equal(refused.isError, true); assert.match(text(refused), /seems to contain a Chilean RUT/); assert.doesNotMatch(text(refused), /12\.345/);
    const clean = await delegate('Check the triage screen with patient P-0042', 'k2');
    assert.notEqual(clean.isError, true, text(clean));
    const report = await lead.callTool({ name: 'panter_harness_report', arguments: { runId: RUN, stepId: '0b6f8f0e-8b39-4f3c-9d4f-2a7e7c1d5b22',
      report: { summary: 'ok', evidence: ['contact ana@clinica.cl'] }, capabilities: { nativeSubagents: false, maxParallelSubagents: 1, toolsAvailable: true } } });
    assert.equal(report.isError, true); assert.match(text(report), /This report seems to contain an e-mail/);
    const review = await lead.callTool({ name: 'panter_native_review_create', arguments: { missionId: RUN, kind: '4r', objective: 'Review triage for ana@clinica.cl', candidateSha: 'a'.repeat(40), idempotencyKey: 'r1' } });
    assert.match(text(review), /This review objective seems to contain an e-mail/);
    for (const [name, args] of [
      ['panter_mesh_delegate_auto', { missionId: RUN, role: 'reviewer', instruction: 'Ping 12.345.678-5', idempotencyKey: 'a1' }],
      ['panter_review_start', { missionId: RUN, kind: '4r', objective: 'Ask ana@clinica.cl', candidateSha: 'a'.repeat(40), idempotencyKey: 'a2' }],
      ['panter_harness_close', { runId: RUN, reason: 'call +56 9 1234 5678', expectedRevision: 1 }],
    ] as const) assert.match(text(await lead.callTool({ name, arguments: args as any })), /seems to contain/, name);
    const created = JSON.parse(text(await lead.callTool({ name: 'panter_native_review_create', arguments: { missionId: RUN, kind: '4r', objective: 'Review the triage screen', candidateSha: 'a'.repeat(40), idempotencyKey: 'r2' } })));
    const solo = await lead.callTool({ name: 'panter_native_review_submit_solo', arguments: { reviewId: created.reviewId, slotId: '0b6f8f0e-8b39-4f3c-9d4f-2a7e7c1d5b22',
      report: { agentId: 'lens', candidateSha: 'a'.repeat(40), packetDigest: 'b'.repeat(64), evidence: ['ok'],
        findings: [{ id: 'f1', location: 'src/a.ts:1', severity: 'WARNING', claim: 'Leaks a row:\n12.345.678-5', proofRefs: ['log'] }] } } });
    assert.match(text(solo), /This review report seems to contain a Chilean RUT/);
    // The operator can clear a mark set by mistake; a later report is not checked.
    const admin = new Client({ name: 'admin', version: '1' });
    await admin.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { authProvider: { token: async () => 'panter-admin-ds-token-987654321' } } as any));
    clients.push(admin);
    assert.match(text(await lead.callTool({ name: 'panter_downstream_unmark', arguments: { missionId: 'other-run', reason: 'x' } })), /Operator/);
    assert.deepEqual(JSON.parse(text(await admin.callTool({ name: 'panter_downstream_unmark', arguments: { missionId: 'other-run', reason: 'x' } }))), { unmarked: false });
    // With a sensitive server configured, memory saves are checked too (before Engram is even asked).
    const memory = await lead.callTool({ name: 'panter_memory_save', arguments: { title: 'triage', type: 'decision', topicKey: 'clinic/triage', content: 'llamar al +56 9 1234 5678' } });
    assert.match(text(memory), /This memory seems to contain a Chilean phone number/);
    const audit = JSON.parse(text(await lead.callTool({ name: 'panter_downstream_audit', arguments: {} })));
    assert.deepEqual(audit.sensitiveMissions.map((m: any) => m.id), [RUN]);
    assert.deepEqual(JSON.parse(text(await admin.callTool({ name: 'panter_downstream_unmark', arguments: { missionId: RUN, reason: 'test' } }))), { unmarked: true });
    assert.equal((await delegate('Check patient 12.345.678-5', 'k3')).isError ? 'refused' : 'stored', 'stored', 'after unmark the mission is ordinary again');
    assert.ok(audit.audit.every((x: any) => x.argsSha256 === null));
  } finally {
    for (const c of clients) await c.close().catch(() => undefined);
    proc.kill('SIGTERM'); await ds.close(); await rm(dir, { recursive: true, force: true });
  }
});

test('a grant is bound to its host and its server', async () => {
  const w = await world({ hosts: ['claude', 'grok'] });
  try {
    const g = w.gw.grant({ server: 'shop', tools: '*', host: 'claude', ttlSeconds: 600, uses: 5, reason: 'x' });
    assert.match(text(await w.gw.call(grok, 'shop', 'set_price', { sku: 'A1', price: 1 }, g.id)), /another host/);
    const ds2 = await downstreamServer();
    const dir = await mkdtemp(join(tmpdir(), 'panter-ds2-'));
    try {
      const ledger = SqliteLedger.open(dir);
      const two = new DownstreamGateway([
        { name: 'shop', url: w.ds.url, tokenEnv: 'PANTER_DOWNSTREAM_SHOP_TOKEN', hosts: ['claude'], writes: 'grant', timeoutMs: 2000, description: '', sensitive: false },
        { name: 'shop2', url: ds2.url, tokenEnv: 'PANTER_DOWNSTREAM_SHOP_TOKEN', hosts: ['claude'], writes: 'grant', timeoutMs: 2000, description: '', sensitive: false },
      ], ledger, { PANTER_DOWNSTREAM_SHOP_TOKEN: TOKEN });
      const g1 = two.grant({ server: 'shop', tools: '*', host: 'claude', ttlSeconds: 600, uses: 5, reason: 'x' });
      assert.match(text(await two.call(claude, 'shop2', 'set_price', { sku: 'A1', price: 1 }, g1.id)), /another server/);
      assert.equal(ds2.seen.length, 0);
      await two.close();
    } finally { await ds2.close(); await rm(dir, { recursive: true, force: true }); }
  } finally { await w.done(); }
});

test('the token never leaks, even when a broken server echoes it in a long error', async () => {
  const w = await world();
  try {
    await w.gw.refresh('shop');
    for (const pad of [0, 230, 240, 290, 2000]) {
      w.ds.setMode('echo500', pad);
      const r = await w.gw.call(claude, 'shop', 'lookup', { sku: 'A1' });
      assert.equal(r.isError, true);
      const everywhere = JSON.stringify([r, w.gw.status(claude), w.gw.audit(operator)]);
      for (const piece of [TOKEN, TOKEN.slice(0, 12), TOKEN.slice(-12)]) assert.ok(!everywhere.includes(piece), `pad ${pad}: ${piece}`);
      w.advance(31_000);
    }
  } finally { await w.done(); }
});

test('redirects are refused and huge results are cut off', async () => {
  const w = await world();
  try {
    await w.gw.refresh('shop');
    // Past the 4 MB response cap (cut while reading) and past the 2 MB result cap (checked after).
    for (const bytes of [5_000_000, 3_000_000]) {
      const huge = await w.gw.call(claude, 'shop', 'huge', { bytes });
      assert.equal(huge.isError, true, `${bytes}`);
      assert.ok(JSON.stringify(huge).length < 10_000, 'the huge result is not passed on');
      w.advance(31_000);
    }
    w.ds.setMode('redirect');
    const r = await w.gw.call(claude, 'shop', 'lookup', { sku: 'A1' });
    assert.equal(r.isError, true);
  } finally { await w.done(); }
});

test('one slow call fails alone: other calls on the shared connection go on, and a success resets the count', async () => {
  const w = await world({ timeoutMs: 1000, hosts: ['claude', 'grok'] });
  try {
    await w.gw.refresh('shop');
    // The reads are still running when the slow call times out (at 1 s): closing the shared connection would kill them.
    w.ds.setDelay(800);
    const [slow, ...reads] = await Promise.all([w.gw.call(claude, 'shop', 'slow', {}),
      ...[1, 2, 3].map(() => new Promise(r => setTimeout(r, 500)).then(() => w.gw.call(grok, 'shop', 'lookup', { sku: 'A1' })))]);
    w.ds.setDelay(0);
    assert.equal(slow!.isError, true);
    assert.ok(reads.every(r => !r.isError), JSON.stringify(reads));
    assert.notEqual(w.gw.status(claude)[0]!.state, 'CIRCUIT_OPEN');
    assert.equal(text(await w.gw.call(claude, 'shop', 'lookup', { sku: 'A1' })), 'lookup ok');
    assert.equal(w.gw.status(claude)[0]!.failures, 0, 'a success resets the count');
    w.ds.setDown(true);
    for (let i = 0; i < 2; i++) await w.gw.call(claude, 'shop', 'lookup', { sku: 'A1' });
    w.ds.setDown(false);
    assert.equal(text(await w.gw.call(claude, 'shop', 'lookup', { sku: 'A1' })), 'lookup ok');
    w.ds.setDown(true);
    for (let i = 0; i < 2; i++) await w.gw.call(claude, 'shop', 'lookup', { sku: 'A1' });
    assert.notEqual(w.gw.status(claude)[0]!.state, 'CIRCUIT_OPEN', 'the success in between reset the count');
  } finally { w.ds.setDown(false); await w.done(); }
});

test('a tool that turns destructive is treated as destructive once the cached list is a minute old', async () => {
  const w = await world();
  try {
    await w.gw.refresh('shop');
    assert.equal(text(await w.gw.call(claude, 'shop', 'flip', {})), 'flip ok');
    w.ds.setFlip(true);
    w.advance(61_000);
    assert.match(text(await w.gw.call(claude, 'shop', 'flip', {})), /needs a grantId/);
  } finally { await w.done(); }
});

test('a tool result that echoes the token is passed on without it', async () => {
  const w = await world();
  try {
    const r: any = await w.gw.call(claude, 'shop', 'leaky', {});
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /\[redacted\]/);
    assert.ok(!JSON.stringify(r).includes(TOKEN));
  } finally { await w.done(); }
});

test('when the tool list cannot be read again, calls fail closed instead of trusting the old classes', async () => {
  const w = await world();
  try {
    await w.gw.refresh('shop');
    assert.equal(text(await w.gw.call(claude, 'shop', 'lookup', { sku: 'A1' })), 'lookup ok');
    w.ds.setDown(true);
    w.advance(61_000);
    const r = await w.gw.call(claude, 'shop', 'lookup', { sku: 'A1' });
    assert.equal(r.isError, true); assert.match(text(r), /could not read its tool list/);
    assert.equal(w.ds.seen.length, 1);
  } finally { w.ds.setDown(false); await w.done(); }
});

test('a host without access cannot flood the audit', async () => {
  const w = await world();
  try {
    await w.gw.call(claude, 'shop', 'lookup', { sku: 'A1' });
    for (let i = 0; i < 2500; i++) await w.gw.call(grok, 'shop', 'lookup', { sku: 'A1' });
    assert.ok(w.gw.audit(operator, { limit: 500 }).some(a => a.host === 'claude'));
    assert.equal(w.gw.refusedOutsiders(operator)[0]!.refused, 2500);
  } finally { await w.done(); }
});

test('an oversized answer fails its own call, says why, and does not count toward the circuit', async () => {
  const w = await world({ timeoutMs: 1500 });
  try {
    await w.gw.refresh('shop');
    for (let i = 0; i < 3; i++) {
      const r = await w.gw.call(claude, 'shop', 'huge', { bytes: 5_000_000 });
      assert.equal(r.isError, true); assert.match(text(r), /larger than/);
    }
    assert.equal(w.gw.status(claude)[0]!.failures, 0);
    assert.equal(text(await w.gw.call(claude, 'shop', 'lookup', { sku: 'A1' })), 'lookup ok');
  } finally { await w.done(); }
});

test('after a failed tool-list fetch, calls fail fast for a while instead of each waiting on another fetch', async () => {
  const w = await world();
  try {
    await w.gw.refresh('shop');
    w.ds.setDown(true); w.advance(61_000);
    assert.match(text(await w.gw.call(claude, 'shop', 'lookup', { sku: 'A1' })), /could not read its tool list/);
    w.ds.setDown(false);
    const t0 = Date.now();
    assert.match(text(await w.gw.call(claude, 'shop', 'lookup', { sku: 'A1' })), /could not read its tool list/);
    assert.ok(Date.now() - t0 < 200, 'failed fast');
    w.advance(11_000);
    assert.equal(text(await w.gw.call(claude, 'shop', 'lookup', { sku: 'A1' })), 'lookup ok', 'asks again after the retry delay');
  } finally { w.ds.setDown(false); await w.done(); }
});

test('an oversized answer is pinned on its own call: real timeouts of other calls still count', async () => {
  const w = await world({ timeoutMs: 1500, hosts: ['claude', 'grok'] });
  try {
    await w.gw.refresh('shop');
    const [big, ...slow] = await Promise.all([w.gw.call(claude, 'shop', 'huge', { bytes: 5_000_000 }),
      ...[1, 2, 3].map(() => w.gw.call(grok, 'shop', 'slow', {}))]);
    assert.match(text(big), /larger than/);
    assert.ok(slow.every(r => r.isError && !/larger than/.test(text(r))), JSON.stringify(slow.map(text)));
    assert.equal(w.gw.status(claude)[0]!.state, 'CIRCUIT_OPEN', 'the three real timeouts opened the circuit');
  } finally { await w.done(); }
});

test('redaction reaches any depth of a result', async () => {
  const { redactDeep } = await import('../src/core/downstream.js');
  let deep: any = `Bearer ${TOKEN}`;
  for (let i = 0; i < 60; i++) deep = { x: [deep] };
  const out = JSON.stringify(redactDeep({ structuredContent: deep, content: [{ type: 'text', text: `a "${TOKEN}" b` }] }, [`Bearer ${TOKEN}`, TOKEN]));
  assert.ok(!out.includes(TOKEN)); assert.match(out, /redacted/);
});

test('every forwarded call carries a signed actor assertion bound to that call', async () => {
  const w = await world({ hosts: ['claude', 'grok'] });
  try {
    const leader = { id: 'claude', operator: false, role: 'leader' as const };
    assert.equal(text(await w.gw.call(leader, 'shop', 'lookup', { sku: 'A1' }, undefined, { missionId: 'run-1' })), 'lookup ok');
    assert.equal(text(await w.gw.call(grok, 'shop', 'lookup', { sku: 'B2' })), 'lookup ok');
    const [first, second] = w.ds.seen.map(x => x.meta as Record<string, unknown>);
    const key = w.gw.actorKeys().keys[0]!;
    const claims = verifyActorAssertion(first!['panter-ai/actor'], key, { aud: 'shop', tool: 'lookup', args: { sku: 'A1' }, now: w.now() });
    assert.equal(claims.sub, 'claude'); assert.equal(claims.role, 'leader'); assert.equal(claims.mission, 'run-1');
    assert.equal(claims.jti, first!['panter-ai/callId']);
    assert.equal(first!['panter-ai/missionId'], 'run-1');
    const other = verifyActorAssertion(second!['panter-ai/actor'], key, { aud: 'shop', tool: 'lookup', args: { sku: 'B2' }, now: w.now() });
    assert.equal(other.sub, 'grok'); assert.equal(other.role, 'worker'); assert.equal(other.mission, undefined);
    // Bound to this call: other arguments, another tool, another server, later, another key all fail.
    const token = first!['panter-ai/actor'];
    assert.throws(() => verifyActorAssertion(token, key, { aud: 'shop', tool: 'lookup', args: { sku: 'A2' }, now: w.now() }), /arguments differ/);
    assert.throws(() => verifyActorAssertion(token, key, { aud: 'shop', tool: 'set_price', args: { sku: 'A1' }, now: w.now() }), /another tool/);
    assert.throws(() => verifyActorAssertion(token, key, { aud: 'clinic', tool: 'lookup', args: { sku: 'A1' }, now: w.now() }), /another server/);
    assert.throws(() => verifyActorAssertion(token, key, { aud: 'shop', tool: 'lookup', args: { sku: 'A1' }, now: w.now() + 10 * 60_000 }), /expired/);
    const { ActorSigner } = await import('../src/core/actor-assertion.js');
    assert.throws(() => verifyActorAssertion(token, ActorSigner.generate().jwk(), { aud: 'shop', tool: 'lookup', args: { sku: 'A1' }, now: w.now() }), /another key/);
    const { kid: _kid, ...anonymous } = ActorSigner.generate().jwk();
    assert.throws(() => verifyActorAssertion(token, anonymous, { aud: 'shop', tool: 'lookup', args: { sku: 'A1' }, now: w.now() }), /bad signature/);
    const [h, b, sig] = String(token).split('.');
    const forged = JSON.parse(Buffer.from(b!, 'base64url').toString()); forged.sub = 'gpt-a';
    assert.throws(() => verifyActorAssertion(`${h}.${Buffer.from(JSON.stringify(forged)).toString('base64url')}.${sig}`, key, { aud: 'shop', tool: 'lookup', args: { sku: 'A1' }, now: w.now() }), /bad signature/);
    // The key survives a restart: the same ledger signs with the same key.
    const again = new DownstreamGateway([w.config], SqliteLedger.open(w.dir), w.env);
    assert.deepEqual(again.actorKeys(), w.gw.actorKeys());
    // The audit says who and in which role and mission.
    assert.deepEqual(w.gw.audit(operator).map(a => [a.host, a.role, a.missionId]).reverse(), [['claude', 'leader', 'run-1'], ['grok', 'worker', null]]);
  } finally { await w.done(); }
});

test('a sensitive server is proxied without keeping its content, and its mission becomes sensitive', async () => {
  const w = await world({ sensitive: true, hosts: ['claude', 'gpt-b'] });
  try {
    assert.match(text(await w.gw.call(claude, 'shop', 'lookup', { sku: 'A1' })), /every call must name its missionId/);
    assert.equal(w.ds.seen.length, 0);
    assert.equal(w.gw.isSensitiveMission('run-9'), false);
    const ok: any = await w.gw.call(claude, 'shop', 'lookup', { sku: '12.345.678-5' }, undefined, { missionId: 'run-9' });
    assert.equal(text(ok), 'lookup ok', 'the answer still reaches the host');
    assert.equal(ok._meta['panter-ai/sensitive'], true);
    assert.equal(w.gw.isSensitiveMission('run-9'), true);
    // A downstream error can echo the call: for a sensitive server only its kind is shown and kept.
    w.ds.setMode('echo500');
    const failed = await w.gw.call(claude, 'shop', 'lookup', { sku: '12.345.678-5' }, undefined, { missionId: 'run-9' });
    w.ds.setMode('ok');
    assert.match(text(failed), /details withheld: sensitive server/);
    assert.doesNotMatch(text(failed), /echo|500/);
    assert.match(w.gw.status(claude)[0]!.lastError ?? '', /details withheld/);
    assert.equal(w.gw.status(claude)[0]!.sensitive, true);
    const audit = w.gw.audit(operator);
    assert.ok(audit.length >= 3 && audit.every(a => a.argsSha256 === null && a.sensitive === true), 'no argument hash at all');
    assert.ok(audit.every(a => a.error === null || /withheld|missionId|^the server|^timed out$/.test(a.error)), JSON.stringify(audit.map(a => a.error)));
    assert.ok(!JSON.stringify(audit).includes('12.345.678'));
    // The mark survives a restart, and only hosts that may use the server see it.
    const again = new DownstreamGateway([w.config], SqliteLedger.open(w.dir), w.env);
    assert.equal(again.isSensitiveMission('run-9'), true);
    assert.equal(new DownstreamGateway([], SqliteLedger.open(w.dir), w.env).isSensitiveMission('run-9'), true, 'marks hold with no server configured');
    assert.deepEqual(again.sensitiveMissions(operator).map(m => [m.id, m.server, m.host]), [['run-9', 'shop', 'claude']]);
    assert.deepEqual(again.sensitiveMissions(grok), []);
    // A refused call (no grant) does not mark its mission: nothing came back.
    assert.match(text(await w.gw.call(claude, 'shop', 'set_price', { sku: 'A1', price: 1 }, undefined, { missionId: 'run-10' })), /needs a grantId/);
    assert.equal(w.gw.isSensitiveMission('run-10'), false);
    assert.match(text(await w.gw.call(claude, 'shop', 'lookup', {}, undefined, { missionId: 'bad mission!' })), /missionId must be/);
    // A run id written in upper case is the same mission.
    const run = '7f4c1a52-3c1e-4c55-9a51-6f1d2b9e0a11';
    await w.gw.call(claude, 'shop', 'lookup', { sku: 'A1' }, undefined, { missionId: run.toUpperCase() });
    assert.equal(w.gw.isSensitiveMission(run), true);
    // The operator can clear a mark set by mistake, durably.
    assert.deepEqual(w.gw.unmarkSensitive(run, 'marked by mistake'), { unmarked: true });
    assert.deepEqual(w.gw.unmarkSensitive(run, 'again'), { unmarked: false });
    assert.equal(w.gw.isSensitiveMission(run), false);
    assert.equal(new DownstreamGateway([w.config], SqliteLedger.open(w.dir), w.env).isSensitiveMission(run), false);
    // An open circuit says why without the downstream's words.
    w.ds.setMode('echo500');
    for (let i = 0; i < 3; i++) await w.gw.call(claude, 'shop', 'lookup', { sku: 'A1' }, undefined, { missionId: 'run-9' });
    w.ds.setMode('ok');
    const open = text(await w.gw.call(claude, 'shop', 'lookup', { sku: 'A1' }, undefined, { missionId: 'run-9' }));
    assert.match(open, /circuit open/); assert.doesNotMatch(open, /echo|500|Bearer/);
  } finally { await w.done(); }
});

test('an ordinary server keeps its diagnostics', async () => {
  const w = await world();
  try {
    w.ds.setMode('echo500');
    const failed = await w.gw.call(claude, 'shop', 'lookup', { sku: 'A1' });
    assert.doesNotMatch(text(failed), /withheld/);
    assert.ok(w.gw.audit(operator).every(a => /^[0-9a-f]{64}$/.test(a.argsSha256 ?? '') && !a.sensitive));
  } finally { w.ds.setMode('ok'); await w.done(); }
});

/** A token endpoint for OAuth client credentials that records what it was sent. */
async function tokenEndpoint(issue: () => { access_token?: string; expires_in?: number; status?: number; pad?: number; hang?: boolean }) {
  const seen: Array<{ auth: string; body: URLSearchParams }> = [];
  const http: Server = createServer((req, res) => {
    let raw = ''; req.on('data', c => { raw += c; });
    req.on('end', () => {
      seen.push({ auth: String(req.headers.authorization ?? ''), body: new URLSearchParams(raw) });
      const t = issue();
      if (t.hang) return; // accepts the request and never answers
      res.writeHead(t.status ?? 200, { 'content-type': 'application/json' }).end(JSON.stringify({ access_token: t.access_token, token_type: 'Bearer', expires_in: t.expires_in ?? 3600, ...(t.pad ? { pad: 'p'.repeat(t.pad) } : {}) }));
    });
  });
  await new Promise<void>(r => http.listen(0, '127.0.0.1', () => r()));
  return { url: `http://127.0.0.1:${(http.address() as { port: number }).port}/oidc/token`, seen, close: () => new Promise(r => { http.closeAllConnections?.(); http.close(r); }) };
}

test('OAuth client credentials: Panter gets a token, renews it when refused, and never shows it', async () => {
  let issued = 0;
  // The first token is stale (the server refuses it); the next one is good.
  const te = await tokenEndpoint(() => ({ access_token: issued++ === 0 ? 'stale-token-000000000000' : TOKEN, expires_in: 3600 }));
  const env = { PANTER_DOWNSTREAM_SHOP_ID: 'panter-client', PANTER_DOWNSTREAM_SHOP_SECRET: 'client-secret-0123456789abcdef' };
  const w = await world({ tokenEnv: null, oauth: { tokenUrl: te.url, clientIdEnv: 'PANTER_DOWNSTREAM_SHOP_ID', clientSecretEnv: 'PANTER_DOWNSTREAM_SHOP_SECRET',
    scope: 'mcp:use', resource: 'https://mcp.example/mercadolibre/mcp', authMethod: 'basic' } }, env);
  try {
    assert.equal(text(await w.gw.call(claude, 'shop', 'lookup', { sku: 'A1' })), 'lookup ok');
    assert.equal(te.seen.length, 2, 'the refused token was renewed once');
    const first = te.seen[0]!;
    assert.equal(first.auth, `Basic ${Buffer.from('panter-client:client-secret-0123456789abcdef').toString('base64')}`);
    assert.deepEqual([first.body.get('grant_type'), first.body.get('scope'), first.body.get('resource')], ['client_credentials', 'mcp:use', 'https://mcp.example/mercadolibre/mcp']);
    // The token is cached: more calls ask the endpoint for nothing.
    assert.equal(text(await w.gw.call(claude, 'shop', 'lookup', { sku: 'A2' })), 'lookup ok');
    assert.equal(te.seen.length, 2);
    // Neither the token nor the client secret ever reaches the host.
    const leak: any = await w.gw.call(claude, 'shop', 'leaky', {});
    assert.ok(!JSON.stringify(leak).includes(TOKEN) && !JSON.stringify(leak).includes(env.PANTER_DOWNSTREAM_SHOP_SECRET));
    assert.equal(w.gw.status(claude)[0]!.state, 'OK');
  } finally { await w.done(); await te.close(); }
});

test('OAuth: form-field client auth, a missing secret, and a refusing token endpoint', async () => {
  const te = await tokenEndpoint(() => ({ access_token: TOKEN }));
  const env = { PANTER_DOWNSTREAM_SHOP_ID: 'panter-client', PANTER_DOWNSTREAM_SHOP_SECRET: 'client-secret-0123456789abcdef' };
  const oauth = { tokenUrl: te.url, clientIdEnv: 'PANTER_DOWNSTREAM_SHOP_ID', clientSecretEnv: 'PANTER_DOWNSTREAM_SHOP_SECRET', scope: null, resource: null, authMethod: 'post' as const };
  const w = await world({ tokenEnv: null, oauth }, env);
  try {
    assert.equal(text(await w.gw.call(claude, 'shop', 'lookup', { sku: 'A1' })), 'lookup ok');
    assert.equal(te.seen[0]!.auth, '');
    assert.deepEqual([te.seen[0]!.body.get('client_id'), te.seen[0]!.body.get('client_secret')], ['panter-client', env.PANTER_DOWNSTREAM_SHOP_SECRET]);
  } finally { await w.done(); }
  const missing = await world({ tokenEnv: null, oauth }, { PANTER_DOWNSTREAM_SHOP_ID: 'panter-client' });
  try {
    assert.match(text(await missing.gw.call(claude, 'shop', 'lookup', { sku: 'A1' })), /PANTER_DOWNSTREAM_SHOP_SECRET is not set/);
    assert.equal(missing.gw.status(claude)[0]!.state, 'TOKEN_MISSING');
  } finally { await missing.done(); await te.close(); }
  const deny = await tokenEndpoint(() => ({ status: 401 }));
  const refused = await world({ tokenEnv: null, oauth: { ...oauth, tokenUrl: deny.url } }, env);
  try {
    const r = text(await refused.gw.call(claude, 'shop', 'lookup', { sku: 'A1' }));
    assert.match(r, /token endpoint answered 401/);
    assert.ok(!r.includes(env.PANTER_DOWNSTREAM_SHOP_SECRET));
  } finally { await refused.done(); await deny.close(); }
});

const OAUTH_ENV = { PANTER_DOWNSTREAM_SHOP_ID: 'panter client', PANTER_DOWNSTREAM_SHOP_SECRET: 'client secret/0123456789+abc' };
const oauthOf = (tokenUrl: string) => ({ tokenUrl, clientIdEnv: 'PANTER_DOWNSTREAM_SHOP_ID', clientSecretEnv: 'PANTER_DOWNSTREAM_SHOP_SECRET', scope: null, resource: null, authMethod: 'basic' as const });

test('OAuth: a token renewed during a call stays redacted in that call\'s result', async () => {
  let n = 0;
  const te = await tokenEndpoint(() => ({ access_token: `issued-token-${++n}-0123456789`, expires_in: 3600 }));
  const w = await world({ tokenEnv: null, oauth: oauthOf(te.url) }, OAUTH_ENV);
  w.ds.setAccepts(a => /^Bearer issued-token-\d+-0123456789$/.test(a));
  try {
    assert.equal(text(await w.gw.call(claude, 'shop', 'lookup', { sku: 'A1' })), 'lookup ok');
    const slow = w.gw.call(claude, 'shop', 'slow_leaky', {});
    await new Promise(r => setTimeout(r, 100));
    w.advance(3_541_000); // past the renewal time of the first token, which is still valid
    assert.equal(text(await w.gw.call(claude, 'shop', 'lookup', { sku: 'A2' })), 'lookup ok');
    assert.equal(te.seen.length, 2, 'the second call renewed the token');
    const leak = JSON.stringify(await slow);
    assert.match(leak, /failed; request had/);
    assert.ok(!leak.includes('issued-token-1-'), 'the older token is still redacted');
    // Basic credentials are form-encoded (RFC 6749), and neither their encoding nor the secret ever shows.
    assert.equal(te.seen[0]!.auth, `Basic ${Buffer.from('panter+client:client+secret%2F0123456789%2Babc').toString('base64')}`);
  } finally { await w.done(); await te.close(); }
});

test('OAuth: late 401s for a revoked token do not throw away the renewed one', async () => {
  let n = 0;
  const te = await tokenEndpoint(() => ({ access_token: `issued-token-${++n}-0123456789`, expires_in: 3600 }));
  const w = await world({ tokenEnv: null, oauth: oauthOf(te.url) }, OAUTH_ENV);
  try {
    w.ds.setAccepts(a => /^Bearer issued-token-\d+-0123456789$/.test(a));
    assert.equal(text(await w.gw.call(claude, 'shop', 'lookup', { sku: 'A1' })), 'lookup ok');
    // The first token is revoked. The first refusal arrives at once, the others after the renewal.
    w.ds.setAccepts(a => /^Bearer issued-token-\d+-0123456789$/.test(a) && a !== 'Bearer issued-token-1-0123456789', k => k === 1 ? 0 : 300);
    const results = await Promise.all(['B1', 'B2', 'B3', 'B4'].map(sku => w.gw.call(claude, 'shop', 'lookup', { sku })));
    assert.deepEqual(results.map(text), ['lookup ok', 'lookup ok', 'lookup ok', 'lookup ok']);
    assert.equal(te.seen.length, 2, 'one renewal for the whole burst');
  } finally { await w.done(); await te.close(); }
});

test('OAuth: a refused write is never sent again by itself', async () => {
  let n = 0;
  const te = await tokenEndpoint(() => ({ access_token: `issued-token-${++n}-0123456789`, expires_in: 3600 }));
  const w = await world({ tokenEnv: null, oauth: oauthOf(te.url) }, OAUTH_ENV);
  try {
    w.ds.setAccepts(a => /^Bearer issued-token-\d+-0123456789$/.test(a));
    assert.equal(text(await w.gw.call(claude, 'shop', 'lookup', { sku: 'A1' })), 'lookup ok');
    const g = w.gw.grant({ server: 'shop', tools: '*', host: 'claude', ttlSeconds: 600, uses: 2, reason: 'repricing' });
    // The token is revoked: the write fails instead of being replayed (a 401 does not prove it did not run).
    w.ds.setAccepts(a => /^Bearer issued-token-\d+-0123456789$/.test(a) && a !== 'Bearer issued-token-1-0123456789');
    const writes = () => w.ds.seen.filter(x => x.tool === 'set_price').length;
    assert.notEqual(text(await w.gw.call(claude, 'shop', 'set_price', { sku: 'A1', price: 5 }, g.id)), 'set_price ok');
    assert.equal(writes(), 0);
    assert.equal(te.seen.length, 1, 'no renewal-and-replay inside the refused write');
    // The refused token was dropped, so the host's next call goes out with a new one.
    assert.equal(text(await w.gw.call(claude, 'shop', 'set_price', { sku: 'A1', price: 5 }, g.id)), 'set_price ok');
    assert.equal(writes(), 1);
    assert.equal(te.seen.length, 2);
  } finally { await w.done(); await te.close(); }
});

test('OAuth: a refused write fails alone; a write already running on the same connection completes', async () => {
  let n = 0;
  const te = await tokenEndpoint(() => ({ access_token: `issued-token-${++n}-0123456789`, expires_in: 3600 }));
  const w = await world({ tokenEnv: null, oauth: oauthOf(te.url) }, OAUTH_ENV);
  try {
    w.ds.setAccepts(a => /^Bearer issued-token-\d+-0123456789$/.test(a));
    assert.equal(text(await w.gw.call(claude, 'shop', 'lookup', { sku: 'A1' })), 'lookup ok');
    const g = w.gw.grant({ server: 'shop', tools: '*', host: 'claude', ttlSeconds: 600, uses: 3, reason: 'repricing' });
    w.ds.setDelay(600);
    const running = w.gw.call(claude, 'shop', 'set_price', { sku: 'A1', price: 5 }, g.id);
    await new Promise(r => setTimeout(r, 150));
    w.ds.setAccepts(a => /^Bearer issued-token-\d+-0123456789$/.test(a) && a !== 'Bearer issued-token-1-0123456789');
    const refused = text(await w.gw.call(claude, 'shop', 'set_price', { sku: 'B1', price: 7 }, g.id));
    assert.match(refused, /refused Panter's token \(401\).*may or may not have run/);
    assert.equal(text(await running), 'set_price ok', 'the running write was not cut by the other call\'s refusal');
    const st = w.gw.status(claude)[0]!;
    assert.equal(st.state, 'OK');
  } finally { w.ds.setDelay(0); await w.done(); await te.close(); }
});

test('OAuth: an access token that redaction could not handle safely is refused', async () => {
  for (const bad of ['short', 'a"quoted"token-0123456789', 'back\\slash-token-0123456789', 'space in token 0123456789']) {
    const te = await tokenEndpoint(() => ({ access_token: bad }));
    const w = await world({ tokenEnv: null, oauth: oauthOf(te.url) }, OAUTH_ENV);
    try {
      assert.match(text(await w.gw.call(claude, 'shop', 'lookup', { sku: 'A1' })), /cannot use safely/, bad);
    } finally { await w.done(); await te.close(); }
  }
});

test('OAuth: issued tokens are never forgotten early; past the cap Panter asks for no more', async () => {
  const te = await tokenEndpoint(() => ({ access_token: TOKEN }));
  const w = await world({ tokenEnv: null, oauth: oauthOf(te.url) }, OAUTH_ENV);
  try {
    // White box: 1000 live tokens already issued (reaching that through real renewals would take 1000 refusals).
    const issued = (w.gw as any).servers.get('shop').oauthIssued as Map<string, number>;
    for (let i = 0; i < 1000; i++) issued.set(`live-token-${i}-0123456789`, w.now() + 86_400_000);
    assert.match(text(await w.gw.call(claude, 'shop', 'lookup', { sku: 'A1' })), /1000 tokens issued are still alive/);
    assert.equal(te.seen.length, 0);
    assert.equal(issued.size, 1000, 'none was dropped');
    // Once they expire, Panter asks again.
    w.advance(86_400_001);
    assert.equal(text(await w.gw.call(claude, 'shop', 'lookup', { sku: 'A2' })), 'lookup ok');
    assert.equal(issued.size, 1);
  } finally { await w.done(); await te.close(); }
});

test('OAuth: a short-lived token is remembered only as long as it lives', async () => {
  let n = 0;
  const te = await tokenEndpoint(() => ({ access_token: `issued-token-${++n}-0123456789`, expires_in: 60 }));
  const w = await world({ tokenEnv: null, oauth: oauthOf(te.url) }, OAUTH_ENV);
  try {
    w.ds.setAccepts(a => /^Bearer issued-token-\d+-0123456789$/.test(a));
    const issued = (w.gw as any).servers.get('shop').oauthIssued as Map<string, number>;
    for (let i = 0; i < 6; i++) {
      assert.equal(text(await w.gw.call(claude, 'shop', 'lookup', { sku: `A${i}` })), 'lookup ok');
      w.advance(61_000);
    }
    assert.equal(te.seen.length, 6, 'renewed on schedule');
    assert.ok(issued.size <= 3, `only tokens that may still be alive are kept (kept ${issued.size})`);
  } finally { await w.done(); await te.close(); }
});

test('OAuth: repeated refused writes open the circuit instead of asking for tokens without end', async () => {
  let n = 0;
  const te = await tokenEndpoint(() => ({ access_token: `issued-token-${++n}-0123456789`, expires_in: 3600 }));
  const w = await world({ tokenEnv: null, oauth: oauthOf(te.url) }, OAUTH_ENV);
  try {
    w.ds.setAccepts(a => /^Bearer issued-token-\d+-0123456789$/.test(a));
    assert.equal(text(await w.gw.call(claude, 'shop', 'lookup', { sku: 'A1' })), 'lookup ok');
    const g = w.gw.grant({ server: 'shop', tools: '*', host: 'claude', ttlSeconds: 600, uses: 10, reason: 'repricing' });
    w.ds.setAccepts(() => false);
    const out: string[] = [];
    for (let i = 0; i < 5; i++) out.push(text(await w.gw.call(claude, 'shop', 'set_price', { sku: 'A1', price: i }, g.id)));
    assert.ok(out.slice(0, 3).every(x => /failed: the server refused Panter's token/.test(x)), out.join(' | '));
    assert.ok(out.slice(3).every(x => /circuit open/.test(x)), out.join(' | '));
    assert.ok(te.seen.length <= 4, `token requests stay bounded (${te.seen.length})`);
    assert.notEqual(w.gw.status(claude)[0]!.state, 'OK');
  } finally { await w.done(); await te.close(); }
});

test('OAuth: a 401 that arrives after its call timed out leaves nothing behind', async () => {
  let n = 0;
  const te = await tokenEndpoint(() => ({ access_token: `issued-token-${++n}-0123456789`, expires_in: 3600 }));
  const w = await world({ tokenEnv: null, oauth: oauthOf(te.url), timeoutMs: 1000 }, OAUTH_ENV);
  try {
    w.ds.setAccepts(a => /^Bearer issued-token-\d+-0123456789$/.test(a));
    assert.equal(text(await w.gw.call(claude, 'shop', 'lookup', { sku: 'A1' })), 'lookup ok');
    const g = w.gw.grant({ server: 'shop', tools: '*', host: 'claude', ttlSeconds: 600, uses: 2, reason: 'repricing' });
    w.ds.setAccepts(a => a !== 'Bearer issued-token-1-0123456789' && /^Bearer issued-token-\d+-0123456789$/.test(a), () => 1500);
    assert.match(text(await w.gw.call(claude, 'shop', 'set_price', { sku: 'A1', price: 5 }, g.id)), /timed out/);
    await new Promise(r => setTimeout(r, 800)); // the late 401 arrives
    const st = (w.gw as any).servers.get('shop');
    assert.deepEqual([st.callFailures.size, st.readCalls.size, st.cutCalls.size, st.activeCalls.size], [0, 0, 0, 0]);
  } finally { await w.done(); await te.close(); }
});

test('OAuth: a read refused twice, or a call that gets no token, fails alone without cutting a running write', async () => {
  let n = 0;
  const te = await tokenEndpoint(() => ({ access_token: `issued-token-${++n}-0123456789`, expires_in: 3600 }));
  const w = await world({ tokenEnv: null, oauth: oauthOf(te.url) }, OAUTH_ENV);
  try {
    w.ds.setAccepts(a => /^Bearer issued-token-\d+-0123456789$/.test(a));
    assert.equal(text(await w.gw.call(claude, 'shop', 'lookup', { sku: 'A1' })), 'lookup ok');
    const g = w.gw.grant({ server: 'shop', tools: '*', host: 'claude', ttlSeconds: 600, uses: 3, reason: 'repricing' });
    w.ds.setDelay(600);
    // 1. Every token is refused now (say, a wrong scope): the read is renewed once, refused again, and fails alone.
    let running = w.gw.call(claude, 'shop', 'set_price', { sku: 'A1', price: 5 }, g.id);
    await new Promise(r => setTimeout(r, 150));
    w.ds.setAccepts(() => false);
    assert.match(text(await w.gw.call(claude, 'shop', 'lookup', { sku: 'B1' })), /a freshly issued one too/);
    assert.equal(text(await running), 'set_price ok');
    // 2. No token can be had (the cap on live tokens): the call fails alone too.
    w.ds.setAccepts(a => /^Bearer issued-token-\d+-0123456789$/.test(a));
    assert.equal(text(await w.gw.call(claude, 'shop', 'lookup', { sku: 'A2' })), 'lookup ok');
    running = w.gw.call(claude, 'shop', 'set_price', { sku: 'A2', price: 6 }, g.id);
    await new Promise(r => setTimeout(r, 150));
    const st = (w.gw as any).servers.get('shop');
    for (let i = 0; i < 1000; i++) st.oauthIssued.set(`live-token-${i}-0123456789`, w.now() + 86_400_000);
    st.oauthToken = null;
    assert.match(text(await w.gw.call(claude, 'shop', 'lookup', { sku: 'B2' })), /no OAuth token: .*tokens issued are still alive/);
    assert.equal(text(await running), 'set_price ok');
  } finally { w.ds.setDelay(0); await w.done(); await te.close(); }
});

test('OAuth: refusals of one token count once; big calls and 403s fail alone too', async () => {
  let n = 0;
  const te = await tokenEndpoint(() => ({ access_token: `issued-token-${++n}-0123456789`, expires_in: 3600 }));
  const w = await world({ tokenEnv: null, oauth: oauthOf(te.url) }, OAUTH_ENV);
  try {
    w.ds.setAccepts(a => /^Bearer issued-token-\d+-0123456789$/.test(a));
    assert.equal(text(await w.gw.call(claude, 'shop', 'lookup', { sku: 'A1' })), 'lookup ok');
    const st = (w.gw as any).servers.get('shop');
    const client = st.client;
    const g = w.gw.grant({ server: 'shop', tools: '*', host: 'claude', ttlSeconds: 600, uses: 10, reason: 'repricing' });
    // Three writes in flight with a token that gets revoked: one cause, one failure, the circuit stays closed.
    w.ds.setAccepts(a => /^Bearer issued-token-\d+-0123456789$/.test(a) && a !== 'Bearer issued-token-1-0123456789');
    const refused = await Promise.all([1, 2, 3].map(p => w.gw.call(claude, 'shop', 'set_price', { sku: 'A1', price: p }, g.id)));
    assert.ok(refused.every(r => /refused Panter's token/.test(text(r))));
    assert.equal(st.failures, 1);
    assert.equal(text(await w.gw.call(claude, 'shop', 'lookup', { sku: 'A2' })), 'lookup ok');
    // A write with more than 1 MB of arguments, refused: it fails alone like any other.
    w.ds.setAccepts(a => /^Bearer issued-token-\d+-0123456789$/.test(a) && a !== 'Bearer issued-token-2-0123456789');
    assert.match(text(await w.gw.call(claude, 'shop', 'set_price', { sku: 'x'.repeat(1_100_000), price: 1 }, g.id)), /may or may not have run/);
    // A 403 for a call (a token without the scope it needs) fails that call only.
    w.ds.setForbid(true);
    assert.match(text(await w.gw.call(claude, 'shop', 'set_price', { sku: 'A3', price: 1 }, g.id)), /403/);
    w.ds.setForbid(false);
    assert.equal(st.client, client, 'the shared connection was never closed');
  } finally { await w.done(); await te.close(); }
});

test('OAuth: a long-lived token stays redacted for its whole life, expires_in given as text too', async () => {
  const te = await tokenEndpoint(() => ({ access_token: TOKEN, expires_in: '5184000' as unknown as number })); // 60 days
  const w = await world({ tokenEnv: null, oauth: oauthOf(te.url) }, OAUTH_ENV);
  try {
    assert.equal(text(await w.gw.call(claude, 'shop', 'lookup', { sku: 'A1' })), 'lookup ok');
    const st = (w.gw as any).servers.get('shop');
    assert.ok(st.oauthIssued.get(TOKEN) >= w.now() + 5_184_000_000, 'kept for its whole life');
    w.advance(31 * 86_400_000);
    st.oauthToken = null;
    assert.ok((w.gw as any).secrets(st).includes(TOKEN), 'still redacted on day 31');
  } finally { await w.done(); await te.close(); }
});

test('OAuth: a failed renewal keeps using the token that still works; one failed request counts once', async () => {
  let down = false;
  const te = await tokenEndpoint(() => down ? { status: 500 } : { access_token: TOKEN, expires_in: 3600 });
  const w = await world({ tokenEnv: null, oauth: oauthOf(te.url) }, OAUTH_ENV);
  try {
    assert.equal(text(await w.gw.call(claude, 'shop', 'lookup', { sku: 'A1' })), 'lookup ok');
    const st = (w.gw as any).servers.get('shop');
    // Past the renewal time, before expiry, with the token endpoint down: calls keep working with the current token.
    down = true;
    w.advance(3_550_000);
    assert.equal(text(await w.gw.call(claude, 'shop', 'lookup', { sku: 'A2' })), 'lookup ok');
    assert.equal(te.seen.length, 2, 'one renewal attempt');
    assert.equal(text(await w.gw.call(claude, 'shop', 'lookup', { sku: 'A3' })), 'lookup ok');
    assert.equal(te.seen.length, 2, 'no new attempt right after a failed one');
    // Once it has expired, calls that waited on one failed request count one failure together.
    w.advance(60_000);
    const failed = await Promise.all(['B1', 'B2', 'B3'].map(sku => w.gw.call(claude, 'shop', 'lookup', { sku })));
    assert.ok(failed.every(r => /no OAuth token: token endpoint answered 500/.test(text(r))), failed.map(text).join(' | '));
    assert.equal(te.seen.length, 3, 'one shared request');
    assert.equal(st.failures, 1);
  } finally { await w.done(); await te.close(); }
});

test('OAuth: a token endpoint that hangs never delays a call with a valid token, nor sends one late', async () => {
  let hang = false;
  const te = await tokenEndpoint(() => hang ? { hang: true } : { access_token: TOKEN, expires_in: 100 });
  const w = await world({ tokenEnv: null, oauth: oauthOf(te.url), timeoutMs: 1000 }, OAUTH_ENV);
  try {
    assert.equal(text(await w.gw.call(claude, 'shop', 'lookup', { sku: 'A1' })), 'lookup ok');
    const g = w.gw.grant({ server: 'shop', tools: '*', host: 'claude', ttlSeconds: 600, uses: 3, reason: 'repricing' });
    // Past the renewal time, token still valid, endpoint hanging: the write goes out at once with the current token.
    hang = true;
    w.advance(55_000);
    const t0 = Date.now();
    assert.equal(text(await w.gw.call(claude, 'shop', 'set_price', { sku: 'W1', price: 9 }, g.id)), 'set_price ok');
    assert.ok(Date.now() - t0 < 500, 'did not wait for the hanging renewal');
    // Expired, endpoint still hanging: the write times out waiting for a token and is never sent afterwards.
    await w.gw.refresh('shop'); // the tool list stays fresh, so the call itself is what waits
    w.advance(46_000);
    const before = w.ds.seen.filter(x => x.tool === 'set_price').length;
    assert.match(text(await w.gw.call(claude, 'shop', 'set_price', { sku: 'W2', price: 9 }, g.id)), /timed out|no OAuth token/);
    await new Promise(r => setTimeout(r, 1500)); // the token request gives up (its own timeout)
    assert.equal(w.ds.seen.filter(x => x.tool === 'set_price').length, before, 'nothing was sent late');
  } finally { await w.done(); await te.close(); }
});

test('OAuth: an oversized token endpoint answer is refused without being buffered', async () => {
  const te = await tokenEndpoint(() => ({ access_token: TOKEN, pad: 200_000 }));
  const w = await world({ tokenEnv: null, oauth: oauthOf(te.url) }, OAUTH_ENV);
  try {
    assert.match(text(await w.gw.call(claude, 'shop', 'lookup', { sku: 'A1' })), /token endpoint answer larger than 64000 bytes/);
  } finally { await w.done(); await te.close(); }
});

test('OAuth config is validated strictly', () => {
  const base = { name: 'shop', url: 'https://mcp.example/mcp' };
  const oauth = { tokenUrl: 'https://mcp.example/oidc/token', clientIdEnv: 'PANTER_DOWNSTREAM_ID', clientSecretEnv: 'PANTER_DOWNSTREAM_SECRET' };
  const parse = (s: object) => parseDownstreamConfig(JSON.stringify({ servers: [{ ...base, ...s }] }), HOSTS)[0]!;
  assert.deepEqual(parse({ oauth }).oauth, { ...oauth, scope: null, resource: null, authMethod: 'basic' });
  assert.equal(parse({}).oauth, undefined);
  for (const [s, why] of [
    [{ oauth, tokenEnv: 'PANTER_DOWNSTREAM_X' }, /not both/], [{ oauth: { ...oauth, tokenUrl: 'http://example.com/t' } }, /tokenUrl/],
    [{ oauth: { ...oauth, clientIdEnv: 'HOME' } }, /clientIdEnv/], [{ oauth: { ...oauth, extra: 1 } }, /unknown oauth field/],
    [{ oauth: { ...oauth, authMethod: 'jwt' } }, /authMethod/], [{ oauth: 'x' }, /must be an object/],
  ] as const) assert.throws(() => parse(s), why);
});
