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

const HOSTS = ['gpt-a', 'gpt-b', 'grok', 'gemini', 'claude'] as const;
const TOKEN = 'downstream-test-token-0123456789';

/** A real downstream MCP server over HTTP that checks its bearer token and records what reached it. */
async function downstreamServer() {
  const seen: Array<{ tool: string; args: unknown; meta: unknown }> = [];
  let delayMs = 0, down = false, flipDestructive = false, mode: 'ok' | 'echo500' | 'redirect' = 'ok', pad = 0;
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
    s.registerTool('flip', { description: 'Read until it is not.', inputSchema: z.object({}), annotations: flipDestructive ? { readOnlyHint: false } : { readOnlyHint: true } }, record('flip'));
    return s;
  }));
  const http: Server = createServer((req, res) => {
    if (down) { req.socket.destroy(); return; }
    if (mode === 'redirect') { res.writeHead(307, { location: 'http://127.0.0.1:9/mcp' }).end(); return; }
    // A broken server that echoes the request's Authorization header back in an error body.
    if (mode === 'echo500') { res.writeHead(500, { 'content-type': 'text/plain' }).end('e'.repeat(pad) + ' echo ' + String(req.headers.authorization)); return; }
    if (req.headers.authorization !== `Bearer ${TOKEN}`) { res.writeHead(401).end(); return; }
    handler(req, res);
  });
  await new Promise<void>(r => http.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(http.address() as { port: number }).port}/mcp`;
  return { url, seen, setDelay: (ms: number) => { delayMs = ms; }, setDown: (v: boolean) => { down = v; }, setFlip: (v: boolean) => { flipDestructive = v; },
    setMode: (m: typeof mode, p = 0) => { mode = m; pad = p; }, close: () => new Promise(r => { http.closeAllConnections?.(); http.close(r); }) };
}

async function world(over: Partial<DownstreamConfig> = {}, env: Record<string, string> = { PANTER_DOWNSTREAM_SHOP_TOKEN: TOKEN }) {
  const ds = await downstreamServer();
  const dir = await mkdtemp(join(tmpdir(), 'panter-ds-'));
  const config: DownstreamConfig = { name: 'shop', url: ds.url, tokenEnv: 'PANTER_DOWNSTREAM_SHOP_TOKEN', hosts: ['claude'], writes: 'grant', timeoutMs: 2000, description: 'test shop', ...over };
  let clock = Date.now();
  const gw = new DownstreamGateway([config], SqliteLedger.open(dir), env, () => clock);
  return { ds, gw, advance: (ms: number) => { clock += ms; }, done: async () => { await gw.close(); await ds.close(); await rm(dir, { recursive: true, force: true }); } };
}
const text = (r: any) => r.content?.[0]?.text as string;
const claude = { id: 'claude', operator: false }, grok = { id: 'grok', operator: false }, operator = { id: 'admin', operator: true };

test('config is validated strictly: names, addresses, token variables and hosts', () => {
  const ok = parseDownstreamConfig(JSON.stringify({ servers: [{ name: 'shop', url: 'http://127.0.0.1:18100/mcp', tokenEnv: 'PANTER_DOWNSTREAM_SHOP', hosts: ['claude'] }] }), HOSTS);
  assert.deepEqual(ok[0], { name: 'shop', url: 'http://127.0.0.1:18100/mcp', tokenEnv: 'PANTER_DOWNSTREAM_SHOP', hosts: ['claude'], writes: 'grant', timeoutMs: 30000, description: '' });
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
    assert.deepEqual(await w.gw.refresh('shop'), { server: 'shop', tools: 7 });
    assert.deepEqual(w.gw.tools('shop').slice(0, 4).map(t => [t.name, t.cls]), [['lookup', 'read'], ['set_price', 'write'], ['delete_item', 'destructive'], ['legacy', 'destructive']]);
    const r = await w.gw.call(claude, 'shop', 'lookup', { sku: 'A1' });
    assert.equal(text(r), 'lookup ok');
    assert.deepEqual(w.ds.seen[0], { tool: 'lookup', args: { sku: 'A1' }, meta: { 'panter-ai/host': 'claude' } });
    const no = await w.gw.call(grok, 'shop', 'lookup', { sku: 'A1' });
    assert.equal(no.isError, true); assert.match(text(no), /may not use/);
    assert.equal(w.ds.seen.length, 1, 'a refused call never reaches the server');
    assert.deepEqual(w.gw.status(grok), [], 'a host not allowed does not even see the server');
    const audit = w.gw.audit(operator);
    assert.deepEqual(audit.map(a => [a.host, a.tool, a.outcome]), [['grok', 'lookup', 'REFUSED'], ['claude', 'lookup', 'OK']]);
    assert.ok(audit.every(a => /^[0-9a-f]{64}$/.test(a.argsSha256) && !JSON.stringify(a).includes('A1')), 'arguments are only hashed');
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
    assert.deepEqual(w.ds.seen.at(-1)!.meta, { 'panter-ai/host': 'claude', 'panter-ai/grantId': g.id });
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
    assert.deepEqual(ds.seen.at(-1)!.meta, { 'panter-ai/host': 'claude' });
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
        { name: 'shop', url: w.ds.url, tokenEnv: 'PANTER_DOWNSTREAM_SHOP_TOKEN', hosts: ['claude'], writes: 'grant', timeoutMs: 2000, description: '' },
        { name: 'shop2', url: ds2.url, tokenEnv: 'PANTER_DOWNSTREAM_SHOP_TOKEN', hosts: ['claude'], writes: 'grant', timeoutMs: 2000, description: '' },
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
