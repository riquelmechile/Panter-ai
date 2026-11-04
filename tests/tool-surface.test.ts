import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/server';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { createToolSurface, DOMAINS, listedFor, operationName, routerName, toolDomain, workflowTools, type SurfaceRole } from '../src/core/tool-surface.js';

/** Every tool name src/server.ts registers. */
async function serverTools() {
  const src = await readFile(new URL('../src/server.ts', import.meta.url), 'utf8');
  return [...new Set([...src.matchAll(/(?:registerTool|registerLegacyTool|registerAppTool\(server,)\s*\(?\s*'(panter_[a-z_]+)'/g)].map(m => m[1]!))];
}

async function connect(role: SurfaceRole, listAll = false) {
  const server = new McpServer({ name: 't', version: '1' });
  const surface = createToolSurface(server, { role: () => role, listAll });
  const calls: unknown[] = [];
  const echo = (name: string) => async (args: unknown) => { calls.push({ name, args }); return { content: [{ type: 'text' as const, text: name }] }; };
  server.registerTool('panter_harness_tick', { description: 'Tick a run.', inputSchema: z.object({ runId: z.string() }), annotations: { readOnlyHint: false } }, echo('panter_harness_tick'));
  server.registerTool('panter_harness_delivery_strategy_set', { description: 'Set delivery strategy.', inputSchema: z.object({ runId: z.string(), strategy: z.enum(['single-pr', 'stacked-to-main']) }) }, echo('panter_harness_delivery_strategy_set'));
  server.registerTool('panter_workforce_pickup', { description: 'Pick up work.', inputSchema: z.object({ leaseSeconds: z.number().int().default(300) }) }, echo('panter_workforce_pickup'));
  server.registerTool('panter_mission_create', { description: 'Legacy mission.', inputSchema: z.object({ goal: z.string() }) }, echo('panter_mission_create'));
  surface.finalize();
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'c', version: '1' });
  await Promise.all([server.connect(b), client.connect(a)]);
  return { client, calls };
}
const body = (r: any) => JSON.parse(r.content[0].text);

test('every server tool has a domain, routers cover every domain, and the role lists name real tools', async () => {
  const tools = await serverTools();
  assert.ok(tools.length > 100, `found ${tools.length}`);
  for (const d of DOMAINS) assert.ok(tools.some(t => toolDomain(t) === d), `domain ${d} has tools`);
  for (const role of ['leader', 'worker'] as const)
    for (const t of workflowTools(role)) assert.ok(tools.includes(t), `${role} lists unknown tool ${t}`);
  for (const t of tools) assert.ok(!DOMAINS.map(routerName).includes(t), `${t} collides with a router name`);
  const leader = tools.filter(t => listedFor(t, 'leader')).length, worker = tools.filter(t => listedFor(t, 'worker')).length;
  assert.ok(leader + DOMAINS.length <= 45 && worker + DOMAINS.length <= 35, `leader ${leader}, worker ${worker}`);
  assert.equal(tools.filter(t => listedFor(t, 'operator')).length, tools.length, 'the operator sees everything');
  // Operation names are unique inside each router.
  for (const d of DOMAINS) { const ops = tools.filter(t => toolDomain(t) === d).map(operationName); assert.equal(new Set(ops).size, ops.length, d); }
});

test('the hosts\' own worker paths stay listed for workers; leader paths for the leader', () => {
  for (const t of ['panter_workforce_pickup', 'panter_workforce_complete_and_rearm', 'panter_mesh_claim', 'panter_mesh_heartbeat', 'panter_mesh_complete',
    'panter_workforce_schedule_pickup', 'panter_github_read', 'panter_github_commit', 'panter_github_open_pr'])
    assert.ok(listedFor(t, 'worker'), t);
  for (const t of ['panter_harness_start', 'panter_harness_tick', 'panter_harness_report', 'panter_harness_correction_report',
    'panter_native_review_submit', 'panter_native_review_submit_solo', 'panter_github_grant'])
    assert.ok(listedFor(t, 'leader'), t);
  assert.equal(listedFor('panter_harness_tick', 'worker'), false);
  assert.equal(listedFor('panter_mission_create', 'leader'), false);
});

test('tools/list shows routers plus the role\'s tools; hidden tools stay callable by name', async () => {
  const { client, calls } = await connect('worker');
  const names = (await client.listTools()).tools.map(t => t.name).sort();
  assert.deepEqual(names, [...DOMAINS.map(routerName), 'panter_workforce_pickup'].sort());
  // Not listed for a worker, still callable directly with its own schema.
  const r: any = await client.callTool({ name: 'panter_harness_tick', arguments: { runId: 'r1' } });
  assert.equal(r.content[0].text, 'panter_harness_tick');
  assert.deepEqual(calls.at(-1), { name: 'panter_harness_tick', args: { runId: 'r1' } });
});

test('a router indexes its operations, describes one with its schema, and calls it with validation', async () => {
  const { client, calls } = await connect('leader');
  const index = body(await client.callTool({ name: 'panter_harness', arguments: { operation: 'index' } }));
  assert.deepEqual(index.operations.map((o: any) => o.operation).sort(), ['delivery_strategy_set', 'tick']);
  assert.equal(index.operations.find((o: any) => o.operation === 'tick').listedForYou, true);
  assert.equal(index.operations.find((o: any) => o.operation === 'delivery_strategy_set').listedForYou, false);
  const one = body(await client.callTool({ name: 'panter_harness', arguments: { operation: 'index', arguments: { operation: 'delivery_strategy_set' } } }));
  assert.equal(one.tool, 'panter_harness_delivery_strategy_set');
  assert.deepEqual(one.inputSchema.properties.strategy.enum, ['single-pr', 'stacked-to-main']);
  // By short or full name, through the tool's own schema (defaults applied).
  await client.callTool({ name: 'panter_harness', arguments: { operation: 'delivery_strategy_set', arguments: { runId: 'r2', strategy: 'single-pr' } } });
  assert.deepEqual(calls.at(-1), { name: 'panter_harness_delivery_strategy_set', args: { runId: 'r2', strategy: 'single-pr' } });
  await client.callTool({ name: 'panter_workforce', arguments: { operation: 'panter_workforce_pickup' } });
  assert.deepEqual(calls.at(-1), { name: 'panter_workforce_pickup', args: { leaseSeconds: 300 } });
  const bad: any = await client.callTool({ name: 'panter_harness', arguments: { operation: 'delivery_strategy_set', arguments: { runId: 'r3', strategy: 'nope' } } });
  assert.equal(bad.isError, true);
  assert.equal(calls.length, 2, 'invalid arguments never reach the tool');
  const unknown: any = await client.callTool({ name: 'panter_harness', arguments: { operation: 'workforce_pickup' } });
  assert.equal(unknown.isError, true, 'a router only routes its own domain');
  assert.deepEqual(body(unknown).operations.sort(), ['delivery_strategy_set', 'tick']);
});

test('the operator, and PANTER_TOOL_SURFACE=all, list every tool', async () => {
  for (const [role, all] of [['operator', false], ['worker', true]] as const) {
    const { client } = await connect(role, all);
    const names = (await client.listTools()).tools.map(t => t.name);
    assert.ok(['panter_harness_tick', 'panter_harness_delivery_strategy_set', 'panter_workforce_pickup', 'panter_mission_create', 'panter_admin'].every(n => names.includes(n)), names.join());
  }
});
