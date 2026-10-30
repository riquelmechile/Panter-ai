/** Exercises the actual SDK's modern HTTP and listen stream against the built MCP server. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const dataDir = await mkdtemp(join(tmpdir(), 'panter-mcp-smoke-'));
const port = String(21000 + Math.floor(Math.random() * 20000));
const tokens = { 'gpt-a': 'panter-actor-a-smoke-token-unique-123456789', 'grok': 'panter-actor-grok-smoke-token-unique-123456789' };
const proc = spawn(process.execPath, ['dist/server.js'], {
  env: { ...process.env, PANTER_PORT: port, PANTER_BIND_HOST: '127.0.0.1', PANTER_TOKEN: 'panter-admin-token-unique-987654321', PANTER_PEER_TOKENS: JSON.stringify(tokens), PANTER_DATA_DIR: dataDir },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let stderr = '';
proc.stderr.on('data', chunk => { stderr += String(chunk); });
const url = new URL(`http://127.0.0.1:${port}/mcp`);
const clients = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function connect(host) {
  const client = new Client({ name: `panter-smoke-${host}`, version: '1.0.0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
  const transport = new StreamableHTTPClientTransport(url, { authProvider: { token: async () => tokens[host] } });
  await client.connect(transport);
  clients.push(client);
  assert.equal(client.getProtocolEra(), 'modern');
  return client;
}
try {
  let ready = false;
  for (let i = 0; i < 80; i++) {
    if (proc.exitCode !== null) throw new Error(`Server exited early: ${stderr}`);
    try { const h = await fetch(`http://127.0.0.1:${port}/health`); if (h.ok) { ready = true; break; } } catch {}
    await sleep(100);
  }
  assert.ok(ready, `MCP server did not start: ${stderr}`);
  const gpt = await connect('gpt-a');
  const grok = await connect('grok');
  const tools = await gpt.listTools();
  assert.ok(tools.tools.some(t => t.name === 'panter_agent_studio'), 'MCP Apps studio tool missing');
  const ui = tools.tools.find(t => t.name === 'panter_agent_studio');
  assert.equal(ui?._meta?.ui?.resourceUri, 'ui://panter/agent-studio.html');
  const resources = await gpt.listResources();
  assert.ok(resources.resources.some(r => r.uri === 'panter://mesh/changed'));
  const view = await gpt.readResource({ uri: 'ui://panter/agent-studio.html' });
  assert.ok(view.contents[0]?.text?.includes('Panter Agent Studio'), 'UI not bundled');
  const html = view.contents[0]?.text ?? '';
  const markerAt = html.indexOf('/*__BUNDLED_APP_JS__*/');
  assert.ok(markerAt < 0, `UI marker remains at ${markerAt} of ${html.length} chars: ${JSON.stringify(html.slice(Math.max(0, markerAt-90), markerAt+100))}`);
  await assert.rejects(grok.readResource({ uri: 'ui://panter/agent-studio.html' }), /./);
  await assert.rejects(grok.readResource({ uri: 'panter://inbox/gpt-a' }), /./);

  let resolveEvent;
  const event = new Promise(resolve => { resolveEvent = resolve; });
  gpt.setNotificationHandler('notifications/resources/updated', notification => {
    if (notification.params?.uri === 'panter://mesh/changed') resolveEvent(notification);
  });
  const subscription = await gpt.listen({ resourceSubscriptions: ['panter://mesh/changed'] });
  assert.ok(subscription.honoredFilter?.resourceSubscriptions?.includes('panter://mesh/changed'));
  const changed = await gpt.callTool({ name: 'panter_mesh_profile_set', arguments: { host: 'grok', actorId: 'actor-grok-smoke', modelRequest: 'host-default', effortRequest: 'high', roles: ['reviewer'], expectedRevision: 0 } });
  assert.ok(!changed.isError, JSON.stringify(changed.content));
  await Promise.race([event, sleep(7000).then(() => { throw new Error('No subscriptions/listen update delivered'); })]);
  const inbox = await gpt.callTool({ name: 'panter_mesh_inbox', arguments: { since: 0 } });
  assert.ok(inbox.content?.some(c => c.type === 'text' && c.text.includes('revision')), 'No durable inbox response');
  // Real cross-actor MCP round trip: GPT-A -> Grok -> GPT-A.
  const delegated = await gpt.callTool({ name: 'panter_mesh_delegate', arguments: {
    missionId: 'smoke-mission', target: 'grok', role: 'reviewer',
    instruction: 'Review the candidate safely', idempotencyKey: 'smoke-review-1',
  } });
  assert.ok(!delegated.isError, JSON.stringify(delegated.content));
  const work = JSON.parse(delegated.content.find(c => c.type === 'text').text);
  const pending = await grok.callTool({ name: 'panter_mesh_pending', arguments: {} });
  assert.ok(JSON.parse(pending.content.find(c => c.type === 'text').text).some(w => w.workId === work.id));
  const claimed = await grok.callTool({ name: 'panter_mesh_claim', arguments: { workId: work.id, leaseSeconds: 60 } });
  assert.ok(!claimed.isError, JSON.stringify(claimed.content));
  const attempt = JSON.parse(claimed.content.find(c => c.type === 'text').text);
  const completed = await grok.callTool({ name: 'panter_mesh_complete', arguments: {
    workId: work.id, attemptId: attempt.attemptId, leaseGeneration: attempt.leaseGeneration,
    result: 'Independent security review complete', success: true,
  } });
  assert.ok(!completed.isError, JSON.stringify(completed.content));
  const returned = await gpt.callTool({ name: 'panter_mesh_inbox', arguments: { since: 0 } });
  const inboxPayload = JSON.parse(returned.content.find(c => c.type === 'text').text);
  assert.ok(inboxPayload.messages.some(m => m.workId === work.id && m.kind === 'RESULT' && m.text === 'Independent security review complete'));
    await subscription.close();
  console.log('PASS modern MCP discover + tools + UI resource + actor guard + live subscriptions/listen event + GPT-A/Grok result return + inbox');
} finally {
  for (const client of clients) await client.close().catch(() => {});
  proc.kill('SIGTERM');
  await rm(dataDir, { recursive: true, force: true });
}
