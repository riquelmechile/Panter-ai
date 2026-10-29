import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { AsyncLocalStorage } from 'node:async_hooks';
import { MeshEngine, HOSTS, isHost } from './core/mesh.js';
import { createServer } from 'node:http';
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import * as z from 'zod/v4';
import { hostRequest, assessEvidence } from './core/policy.js';
import { PanterStore } from './core/store.js';
import { AgentEngine, AGENT_ROLES, routeFlow } from './core/agents.js';

const port = Number(process.env.PANTER_PORT ?? '8080');
const bind = process.env.PANTER_BIND_HOST ?? '127.0.0.1';
const token = process.env.PANTER_TOKEN ?? '';
const dataDir = process.env.PANTER_DATA_DIR ?? '.panter-data';
const allowedHosts = (process.env.PANTER_ALLOWED_HOSTS ?? '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
const allowedOrigins = (process.env.PANTER_ALLOWED_ORIGINS ?? '').split(',').map(x => x.trim()).filter(Boolean);
const loopback = ['127.0.0.1', 'localhost', '::1'].includes(bind);
if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error('Invalid PANTER_PORT');
if (!token || token.length < 24) throw new Error('PANTER_TOKEN must be at least 24 characters');
if (!loopback && allowedHosts.length === 0) throw new Error('PANTER_ALLOWED_HOSTS is required for public binds');

const digest = (value: string) => createHash('sha256').update(value).digest();
const expected = digest(token);
function authorized(authorization: string | undefined) {
  const candidate = authorization?.startsWith('Bearer ') ? authorization.slice(7) : '';
  return timingSafeEqual(digest(candidate), expected);
}
function hostname(host: string | undefined): string {
  try { return new URL(`http://${host ?? ''}`).hostname.toLowerCase().replace(/^\[|\]$/g, ''); }
  catch { return ''; }
}
function output(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
}
async function execute<T>(work: () => Promise<T>) {
  try { return output(await work()); }
  catch (error) { return { isError: true as const, content: [{ type: 'text' as const, text: error instanceof Error ? error.message : 'Unknown error' }] }; }
}

const store = await PanterStore.open(dataDir);
const agents = await AgentEngine.open(dataDir, store);
const mesh = await MeshEngine.open(dataDir);
const principalContext = new AsyncLocalStorage<string>();
const peerTokens: Record<string,string> = JSON.parse(process.env.PANTER_PEER_TOKENS ?? '{}');
for(const [host,secret] of Object.entries(peerTokens)){if(!isHost(host)||typeof secret!=='string'||secret.length<24||secret===token)throw new Error('Invalid PANTER_PEER_TOKENS');}
if(new Set(Object.values(peerTokens)).size!==Object.keys(peerTokens).length)throw new Error('Peer tokens must be unique');
function principal(){return principalContext.getStore()??'unknown'}
function hostPrincipal(){const p=principal();if(!isHost(p))throw new Error('Peer identity required');return p}
function requireLeader(){if(principal()!=='gpt-a')throw new Error('GPT-A required')}
function requireAdmin(){if(principal()!=='admin')throw new Error('Admin token required')}
const missionStatus = z.enum(['DRAFT', 'READY', 'RUNNING', 'VERIFYING', 'DONE', 'BLOCKED']);
const bounded = (max = 2048) => z.string().trim().min(1).max(max);

const handler = createMcpHandler(() => {
  const server = new McpServer({ name: 'panter-ai', version: '0.4.0' }, {
    capabilities: { resources: { subscribe: true } },
    instructions: 'Panter-ai is a remote MCP engineering workspace. Reasoning, model choice and native subagents belong to the connected AI host. The model and effort policy returned by panter_host_policy is only REQUESTED, never proof. For meaningful work use panter_flow_route to choose inline versus coordinated execution, then create a durable flow only when useful. The parent session coordinates, and focused native host agents perform scoped exploration, implementation, verification and review. Use panter_agent_packet to obtain bounded context; never imply an agent was launched merely because its task was enqueued. Worker completions are reported evidence, not trusted verification. The server runs no model inference or shell. Do not claim a test, review, wake or execution succeeded without external evidence.'
  });

  // Preserve Zod schema inference for legacy admin tools while enforcing
  // actor authorization at the callback boundary.
  function registerLegacyTool<Schema extends z.ZodType>(
    name: string,
    config: {
      description: string;
      inputSchema: Schema;
      annotations?: { readOnlyHint?: boolean; idempotentHint?: boolean };
    },
    callback: (input: z.output<Schema>) => unknown,
  ): void {
    // The SDK overload is version-specific; keep that boundary isolated.
    (server.registerTool as any)(name, config, (input: z.output<Schema>) => {
      requireAdmin();
      return callback(input);
    });
  }

  registerLegacyTool('panter_host_policy', {
    description: 'Describe requested model, reasoning, parallelism and evidence policy; never starts a model.',
    inputSchema: z.object({ profile: z.enum(['chatgpt', 'host-native']).default('chatgpt'),
      reported: z.object({ model: z.string().optional(), reasoningEffort: z.string().optional(), workerCount: z.number().int().nonnegative().optional(), processing: z.string().optional() }).optional() }),
    annotations: { readOnlyHint: true, idempotentHint: true }
  }, async ({ profile, reported }) => { requireAdmin();
    const policy = hostRequest(profile);
    return output({ policy, assessment: assessEvidence(policy, reported ? { ...reported, source: 'host-reported' } : undefined) });
  });

  registerLegacyTool('panter_mission_create', {
    description: 'Create a persistent engineering mission with a defined project and goal.',
    inputSchema: z.object({ project: bounded(100), goal: bounded(4000) })
  }, async ({ project, goal }) => execute(() => store.createMission(project, goal)));

  registerLegacyTool('panter_mission_get', {
    description: 'Read the exact persistent mission state.',
    inputSchema: z.object({ id: z.uuid() }), annotations: { readOnlyHint: true, idempotentHint: true }
  }, async ({ id }) => output(await store.getMission(id)));

  registerLegacyTool('panter_mission_list', {
    description: 'List missions, optionally limited to a project.',
    inputSchema: z.object({ project: bounded(100).optional() }), annotations: { readOnlyHint: true, idempotentHint: true }
  }, async ({ project }) => output(await store.listMissions(project)));

  registerLegacyTool('panter_mission_transition', {
    description: 'Transition a mission through a bounded state machine; requires its current revision.',
    inputSchema: z.object({ id: z.uuid(), status: missionStatus, expectedRevision: z.number().int().positive() })
  }, async ({ id, status, expectedRevision }) => execute(() => store.transitionMission(id, status, expectedRevision)));

  registerLegacyTool('panter_work_enqueue', {
    description: 'Durably queue a task for a named worker; this does not trigger host wake or inference.',
    inputSchema: z.object({ missionId: z.uuid(), target: bounded(100), instruction: bounded(10000), idempotencyKey: bounded(160) })
  }, async ({ missionId, target, instruction, idempotencyKey }) => execute(() => store.enqueueWork(missionId, target, instruction, idempotencyKey)));

  registerLegacyTool('panter_work_claim', {
    description: 'Claim a pending task using a server-generated lease generation. Initial single-tenant mode.',
    inputSchema: z.object({ target: bounded(100) })
  }, async ({ target }) => execute(() => store.claimWork(target)));

  registerLegacyTool('panter_work_complete', {
    description: 'Complete a claimed task using exact lease generation and return result.',
    inputSchema: z.object({ id: z.uuid(), target: bounded(100), leaseGeneration: z.number().int().positive(), result: z.string().max(20000) })
  }, async ({ id, target, leaseGeneration, result }) => execute(() => store.completeWork(id, target, leaseGeneration, result)));

  registerLegacyTool('panter_work_get', {
    description: 'Read task state and recorded result.',
    inputSchema: z.object({ id: z.uuid() }), annotations: { readOnlyHint: true, idempotentHint: true }
  }, async ({ id }) => output(await store.getWork(id)));

  const flowSignals = z.object({ requirementsClear: z.boolean(), resumableFromDiff: z.boolean(),
    risk: z.enum(['low', 'high']), unknownCodeArea: z.boolean(),
    independentWorkUnits: z.number().int().min(0).max(32), writesAuthorized: z.boolean() });
  const agentRole = z.enum(['scout', 'designer', 'builder', 'verifier', 'reviewer']);

  registerLegacyTool('panter_agent_roles', {
    description: 'List scoped, host-operated specialist agents and their required handoffs.',
    inputSchema: z.object({}), annotations: { readOnlyHint: true, idempotentHint: true }
  }, async () => output(AGENT_ROLES));

  registerLegacyTool('panter_flow_route', {
    description: 'Choose inline work, read-only exploration, or coordinated delegation using explicit risk and recoverability signals.',
    inputSchema: flowSignals, annotations: { readOnlyHint: true, idempotentHint: true }
  }, async args => output(routeFlow(args)));

  registerLegacyTool('panter_flow_create', {
    description: 'Record exact user-approved specification with risk, scope, and a resumable flow. No agents are started.',
    inputSchema: z.object({ missionId: z.uuid(), spec: z.string().min(1).max(30000), signals: flowSignals, reviewRequired: z.boolean().default(false) })
  }, async ({ missionId, spec, signals, reviewRequired }) => execute(() => agents.createFlow(missionId, spec, signals, reviewRequired)));

  registerLegacyTool('panter_flow_get', {
    description: 'Read durable agent flow and the exact original specification.',
    inputSchema: z.object({ flowId: z.uuid() }), annotations: { readOnlyHint: true, idempotentHint: true }
  }, async ({ flowId }) => output(await agents.getFlow(flowId)));

  registerLegacyTool('panter_flow_list', {
    description: 'List agent flows, optionally filtered to a mission.',
    inputSchema: z.object({ missionId: z.uuid().optional() }), annotations: { readOnlyHint: true, idempotentHint: true }
  }, async ({ missionId }) => output(await agents.listFlows(missionId)));

  registerLegacyTool('panter_agent_enqueue', {
    description: 'Queue a bounded host-native specialist assignment. Builders require authorized writing and nonoverlapping edit scopes.',
    inputSchema: z.object({ flowId: z.uuid(), role: agentRole, target: bounded(100), objective: bounded(10000),
      scopes: z.array(bounded(256)).max(32).default([]), workspace: bounded(100).default('default'),
      dependsOn: z.array(z.uuid()).max(32).default([]), idempotencyKey: bounded(160) })
  }, async args => execute(() => agents.addTask(args)));

  registerLegacyTool('panter_agent_list', {
    description: 'Read all assignments and completion states in one flow.',
    inputSchema: z.object({ flowId: z.uuid() }), annotations: { readOnlyHint: true, idempotentHint: true }
  }, async ({ flowId }) => output(await agents.listTasks(flowId)));

  registerLegacyTool('panter_agent_packet', {
    description: 'Get a bounded role contract, the verbatim specification, edit boundaries, and prerequisite handoffs.',
    inputSchema: z.object({ taskId: z.uuid() }), annotations: { readOnlyHint: true, idempotentHint: true }
  }, async ({ taskId }) => output(await agents.packet(taskId)));

  registerLegacyTool('panter_agent_claim', {
    description: 'Claim one dependency-ready task with a fenced lease. The named worker is not authenticated in this single-tenant alpha.',
    inputSchema: z.object({ target: bounded(100), workerId: bounded(100), leaseSeconds: z.number().int().min(30).max(3600).default(300) })
  }, async ({ target, workerId, leaseSeconds }) => execute(() => agents.claim(target, workerId, leaseSeconds)));

  registerLegacyTool('panter_agent_heartbeat', {
    description: 'Extend the lease of the currently claimed task, rejecting stale generations.',
    inputSchema: z.object({ taskId: z.uuid(), workerId: bounded(100), leaseGeneration: z.number().int().positive(),
      leaseSeconds: z.number().int().min(30).max(3600).default(300) })
  }, async ({ taskId, workerId, leaseGeneration, leaseSeconds }) => execute(() => agents.heartbeat(taskId, workerId, leaseGeneration, leaseSeconds)));

  registerLegacyTool('panter_agent_ask', {
    description: 'Return a blocking question and release the lease; the parent must answer before work resumes.',
    inputSchema: z.object({ taskId: z.uuid(), workerId: bounded(100), leaseGeneration: z.number().int().positive(), question: bounded(3000) })
  }, async ({ taskId, workerId, leaseGeneration, question }) => execute(() => agents.ask(taskId, workerId, leaseGeneration, question)));

  registerLegacyTool('panter_agent_answer', {
    description: 'Supply a human/parent answer to a waiting assignment and make it ready to reclaim.',
    inputSchema: z.object({ taskId: z.uuid(), answer: bounded(5000) })
  }, async ({ taskId, answer }) => execute(() => agents.answer(taskId, answer)));

  registerLegacyTool('panter_agent_complete', {
    description: 'Store a role-scoped result with host-reported evidence. Independent verifier/reviewer must match a frozen SHA.',
    inputSchema: z.object({ taskId: z.uuid(), workerId: bounded(100), leaseGeneration: z.number().int().positive(),
      success: z.boolean().default(true), result: z.object({ summary: bounded(10000),
        evidence: z.array(bounded(1000)).max(40).default([]), candidateSha: z.string().optional(), approved: z.boolean().optional() }) })
  }, async ({ taskId, workerId, leaseGeneration, result, success }) => execute(() => agents.report(taskId, workerId, leaseGeneration, result, success)));

  registerLegacyTool('panter_flow_candidate', {
    description: 'Freeze exact Git commit SHA for independent verification and review; changing SHA invalidates prior outcomes.',
    inputSchema: z.object({ flowId: z.uuid(), candidateSha: bounded(64), expectedRevision: z.number().int().positive() })
  }, async ({ flowId, candidateSha, expectedRevision }) => execute(() => agents.freezeCandidate(flowId, candidateSha, expectedRevision)));

  registerLegacyTool('panter_flow_close', {
    description: 'Close only when tasks complete and required independent verification and approval are reported.',
    inputSchema: z.object({ flowId: z.uuid(), expectedRevision: z.number().int().positive() })
  }, async ({ flowId, expectedRevision }) => execute(() => agents.closeFlow(flowId, expectedRevision)));

  registerLegacyTool('panter_flow_dashboard', {
    description: 'Recover a resumable per-flow status snapshot for the parent host; no wake or inference implied.',
    inputSchema: z.object({ flowId: z.uuid() }), annotations: { readOnlyHint: true, idempotentHint: true }
  }, async ({ flowId }) => output(await agents.summary(flowId)));

  const hostEnum = z.enum(HOSTS);
  const roleEnum = z.enum(['orchestrator','explorer','architect','implementer','verifier','reviewer']);
  server.registerTool('panter_mesh_profile_set',{description:'GPT-A configures a host agent profile, model and effort are requests only.',inputSchema:z.object({host:hostEnum,actorId:bounded(160),modelRequest:z.string().max(120),effortRequest:z.string().max(32),roles:z.array(roleEnum).min(1),expectedRevision:z.number().int().nonnegative()})},async x=>execute(()=>mesh.setProfile(hostPrincipal(),x,x.expectedRevision)));
  server.registerTool('panter_mesh_profiles',{description:'List configured host profiles.',inputSchema:z.object({}),annotations:{readOnlyHint:true}},async()=>execute(()=>mesh.profiles()));
  server.registerTool('panter_mesh_delegate',{description:'GPT-A creates actor-bound A2A work for one configured host.',inputSchema:z.object({missionId:bounded(120),target:hostEnum,role:roleEnum,instruction:bounded(20000),idempotencyKey:bounded(160)})},async x=>execute(()=>mesh.delegate(hostPrincipal(),x)));
  server.registerTool('panter_mesh_pending',{description:'Return pointers to work assigned to authenticated host.',inputSchema:z.object({}),annotations:{readOnlyHint:true}},async()=>execute(()=>mesh.pending(hostPrincipal())));
  server.registerTool('panter_mesh_claim',{description:'Claim actor-owned work with a fenced attempt and obtain instructions.',inputSchema:z.object({workId:z.uuid(),leaseSeconds:z.number().int().min(30).max(3600).default(300)})},async x=>execute(()=>mesh.claim(hostPrincipal(),x.workId,x.leaseSeconds)));
  server.registerTool('panter_mesh_heartbeat',{description:'Renew exact worker lease.',inputSchema:z.object({workId:z.uuid(),attemptId:z.uuid(),leaseGeneration:z.number().int().positive(),leaseSeconds:z.number().int().min(30).max(3600).default(300)})},async x=>execute(()=>mesh.heartbeat(hostPrincipal(),x.workId,x.attemptId,x.leaseGeneration,x.leaseSeconds)));
  server.registerTool('panter_mesh_complete',{description:'Submit fenced terminal receipt; result is automatically delivered to GPT-A inbox.',inputSchema:z.object({workId:z.uuid(),attemptId:z.uuid(),leaseGeneration:z.number().int().positive(),result:z.string().max(50000),success:z.boolean().default(true)})},async x=>execute(()=>mesh.complete(hostPrincipal(),x.workId,x.attemptId,x.leaseGeneration,x.result,x.success)));
  server.registerTool('panter_mesh_message',{description:'Send actor-bound A2A question, answer or progress update to collaborator or GPT-A.',inputSchema:z.object({missionId:bounded(120),to:hostEnum,workId:z.uuid(),kind:z.enum(['QUESTION','ANSWER','UPDATE']),text:bounded(10000)})},async x=>execute(()=>mesh.message(hostPrincipal(),x)));
  server.registerTool('panter_mesh_inbox',{description:'Retrieve only the authenticated actor inbox; since is a durable per-actor revision cursor.',inputSchema:z.object({since:z.number().int().nonnegative().default(0)}),annotations:{readOnlyHint:true}},async x=>execute(()=>mesh.inbox(hostPrincipal(),x.since)));
  // MCP 2026-07-28 uses subscriptions/listen: the SDK owns the stream and
  // matches resourceSubscriptions against the resourceUpdated URI. The shared
  // notification carries NO private work metadata. Reading inbox data still
  // requires authentication and actor-scoped tools.
  server.registerResource('panter-mesh-change', 'panter://mesh/changed', {
    description: 'Generic notification pointer; never contains private work data',
    mimeType: 'application/json',
  }, async uri => ({ contents: [{ uri: uri.toString(), mimeType: 'application/json', text: JSON.stringify(mesh.changeResource()) }] }));

  const studioUri = 'ui://panter/agent-studio.html';
  registerAppTool(server, 'panter_agent_studio', {
    title: 'Panter Agent Studio',
    description: 'GPT-A opens a visual configuration panel for the five authenticated host agent profiles. Only GPT-A may save profiles.',
    inputSchema: z.object({}),
    _meta: { ui: { resourceUri: studioUri } },
  }, async () => execute(async () => { requireLeader(); return { profiles: await mesh.profiles(), hosts: HOSTS, modelPoliciesAreRequests: true }; }));
  registerAppResource(server, 'Panter Agent Studio', studioUri, { mimeType: RESOURCE_MIME_TYPE }, async () => {
    requireLeader();
    const html = await readFile(resolve('dist/ui/agent-studio.html'), 'utf8');
    return { contents: [{ uri: studioUri, mimeType: RESOURCE_MIME_TYPE, text: html }] };
  });

  for(const host of HOSTS){
    server.registerResource(`panter-inbox-${host}`,`panter://inbox/${host}`,{description:'Authorized actor inbox revision; no task content is exposed',mimeType:'application/json'},async uri=>{
      if(hostPrincipal()!==host)throw new Error('Resource unavailable');
      const summary=await mesh.resource(host);
      return {contents:[{uri:uri.toString(),mimeType:'application/json',text:JSON.stringify(summary)}]};
    });
  }
  return server;
});

// Publish only after atomic ledger persistence. SDK handles modern listen
// streams; the in-memory bus is intentionally single-process in v0.4.
mesh.events.on('changed', () => {
  // Notification failure must never roll back or misreport a persisted write.
  try {
    void Promise.resolve(handler.notify.resourceUpdated('panter://mesh/changed')).catch(() => {
      console.error('MCP change notification delivery failed');
    });
  } catch { console.error('MCP notification publication failed'); }
});
const nodeHandler = toNodeHandler(handler);
const http = createServer(async (req, res) => {
  if (req.url === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ status: 'ok', name: 'panter-ai', version: '0.4.0' }));
    return;
  }
  if (req.url !== '/mcp') { res.writeHead(404); res.end('Not found'); return; }
  const h = hostname(req.headers.host);
  if (!h || !(allowedHosts.length ? allowedHosts.includes(h) : ['localhost', '127.0.0.1', '::1'].includes(h))) {
    res.writeHead(403); res.end('Host not allowed'); return;
  }
  if (req.headers.origin && !allowedOrigins.includes(req.headers.origin)) {
    res.writeHead(403); res.end('Origin not allowed'); return;
  }
  const candidateToken=req.headers.authorization?.startsWith('Bearer ')?req.headers.authorization.slice(7):'';
  const peer=Object.entries(peerTokens).find(([,v])=>timingSafeEqual(digest(candidateToken),digest(v)))?.[0];
  const actor=authorized(req.headers.authorization)?'admin':peer;
  if (!actor) {
    res.writeHead(401, { 'www-authenticate': 'Bearer realm="panter-ai"', 'cache-control': 'no-store' });
    res.end('Unauthorized'); return;
  }
  res.setHeader('Cache-Control', 'no-store');
  try { await principalContext.run(actor,()=>nodeHandler(req, res)); }
  catch (error) {
    console.error('MCP request failed:', error instanceof Error ? error.message : 'error');
    if (!res.headersSent) res.writeHead(500);
    if (!res.writableEnded) res.end('Internal error');
  }
});
http.listen(port, bind, () => console.error(`Panter-ai MCP ready on ${bind}:${port}/mcp`));
