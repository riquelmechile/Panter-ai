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
  let delayMs = 0, down = false;
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
    return s;
  }));
  const http: Server = createServer((req, res) => {
    if (down) { req.socket.destroy(); return; }
    if (req.headers.authorization !== `Bearer ${TOKEN}`) { res.writeHead(401).end(); return; }
    handler(req, res);
  });
  await new Promise<void>(r => http.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(http.address() as { port: number }).port}/mcp`;
  return { url, seen, setDelay: (ms: number) => { delayMs = ms; }, setDown: (v: boolean) => { down = v; }, close: () => new Promise(r => http.close(r)) };
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
    assert.deepEqual(await w.gw.refresh('shop'), { server: 'shop', tools: 4 });
    assert.deepEqual(w.gw.tools('shop').map(t => [t.name, t.cls]), [['lookup', 'read'], ['set_price', 'write'], ['delete_item', 'destructive'], ['legacy', 'destructive']]);
    const r = await w.gw.call(claude, 'shop', 'lookup', { sku: 'A1' });
    assert.equal(text(r), 'lookup ok');
    assert.deepEqual(w.ds.seen[0], { tool: 'lookup', args: { sku: 'A1' }, meta: { 'panter-ai/host': 'claude' } });
    const no = await w.gw.call(grok, 'shop', 'lookup', { sku: 'A1' });
    assert.equal(no.isError, true); assert.match(text(no), /may not use/);
    assert.equal(w.ds.seen.length, 1, 'a refused call never reaches the server');
    assert.deepEqual(w.gw.status(grok), [], 'a host not allowed does not even see the server');
    const audit = w.gw.audit();
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
    assert.ok(w.gw.audit().some(a => a.outcome === 'FAILED'));
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
    assert.deepEqual(index.operations.map((o: any) => [o.operation, o.class]), [['lookup', 'read'], ['set_price', 'write'], ['delete_item', 'destructive'], ['legacy', 'destructive']]);
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
