import { ExternalOAuthVerifier, staticBearerMatch } from './core/oauth.js';
import { EmbeddedOAuth } from './core/embedded-oauth.js';
import { openEngramBridge } from './core/engram-runtime.js';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { EngramMemory } from './core/engram-memory.js';
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
import { gentleCatalog, readAgent, readSkill, readOrchestratorSection, GENTLE_ORCHESTRATOR_SECTIONS, GENTLE_AGENTS, GENTLE_SKILLS, REVIEW_4R, JUDGMENT_DAY } from './core/gentle-catalog.js';
import { planHostNative, nativePacket, nativeOddInstructions } from './core/native-fallback.js';
import { NativeReviewBridge, assessMeshReview } from './core/native-review.js';
import { NativeSubagentReview } from './core/native-review-workflow.js';
import { AutomaticHarness } from './core/auto-harness.js';
import { GitHubDeliveryGate } from './core/github-delivery.js';
import { PanterRdd } from './core/panter-rdd.js';
import { LocalGitVerifier } from './core/local-git-verifier.js';

const port = Number(process.env.PANTER_PORT ?? '8080');
const bind = process.env.PANTER_BIND_HOST ?? '127.0.0.1';
const authMode = process.env.PANTER_AUTH_MODE ?? 'dev-static';
if (!['dev-static', 'external-jwt', 'embedded'].includes(authMode)) throw new Error('Unsupported PANTER_AUTH_MODE');
const token = process.env.PANTER_TOKEN ?? '';
// OAuth-mode operator control is separate from AI clients and accepted on loopback only.
const operatorToken=process.env.PANTER_OPERATOR_TOKEN??'';
if(operatorToken&&(operatorToken.length<32||operatorToken===token))throw new Error('Invalid PANTER_OPERATOR_TOKEN');
const dataDir = process.env.PANTER_DATA_DIR ?? '.panter-data';
const allowedHosts = (process.env.PANTER_ALLOWED_HOSTS ?? '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
const allowedOrigins = (process.env.PANTER_ALLOWED_ORIGINS ?? '').split(',').map(x => x.trim()).filter(Boolean);
const loopback = ['127.0.0.1', 'localhost', '::1'].includes(bind);
if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error('Invalid PANTER_PORT');
if (authMode === 'dev-static' && token.length < 24) throw new Error('PANTER_TOKEN must be at least 24 characters in dev-static mode');
if (!loopback && allowedHosts.length === 0) throw new Error('PANTER_ALLOWED_HOSTS is required for public binds');

const oauth = authMode === 'external-jwt' ? await ExternalOAuthVerifier.open({
  issuer: process.env.PANTER_OAUTH_ISSUER ?? '',
  resource: process.env.PANTER_PUBLIC_MCP_URL ?? '',
  keysFile: process.env.PANTER_OAUTH_JWKS_FILE ?? '',
  actorsFile: process.env.PANTER_OAUTH_ACTORS_FILE ?? '',
}) : null;
const embedded = authMode === 'embedded' ? await EmbeddedOAuth.open({
  dir: dataDir, resource: process.env.PANTER_PUBLIC_MCP_URL ?? '',
  redirectUris: (process.env.PANTER_OAUTH_REDIRECT_URIS ?? '').split(',').map(s => s.trim()).filter(Boolean),
  password: process.env.PANTER_CONSENT_PASSWORD ?? '',
}) : null;
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
const nativeSubagentReview = await NativeSubagentReview.open(dataDir);
const githubGate = new GitHubDeliveryGate({
  allowedRepositories:(process.env.PANTER_GITHUB_ALLOWED_REPOS??'').split(',').map(x=>x.trim()).filter(Boolean),
  requiredChecks:(process.env.PANTER_GITHUB_REQUIRED_CHECKS??'').split(',').map(x=>x.trim()).filter(Boolean),
  token:process.env.PANTER_GITHUB_TOKEN||undefined,
});
const nativeReview = await NativeReviewBridge.open({enabled:process.env.PANTER_NATIVE_REVIEW_ENABLED==='1',binary:process.env.PANTER_GENTLE_AI_BIN??'gentle-ai',repositoryRoot:process.env.PANTER_NATIVE_REVIEW_WORKTREE??''});
const rddKeysFile=process.env.PANTER_RDD_RUNNER_KEYS_FILE;
const rddRunnerKeys:Record<string,string>=rddKeysFile?JSON.parse(await readFile(rddKeysFile,'utf8')):{};
const localGit=process.env.PANTER_RDD_LOCAL_WORKTREES_FILE?await LocalGitVerifier.open(process.env.PANTER_RDD_LOCAL_WORKTREES_FILE):null;
const panterRdd = await PanterRdd.open(dataDir,nativeSubagentReview,mesh,githubGate,rddRunnerKeys,localGit);
const harness = await AutomaticHarness.open(dataDir,mesh,nativeSubagentReview,githubGate,nativeReview,panterRdd,true);
// Legacy/direct A2A writers cannot bypass the operator-issued harness grant.
mesh.setWriteGuard((missionId,paths)=>harness.authorizeDelegatedWrite(missionId,paths));
const engramEnabled = process.env.PANTER_ENGRAM_ENABLED === '1';
const memory = engramEnabled ? await openEngramBridge(dataDir, process.env.PANTER_ENGRAM_COMMAND ?? 'engram') : null;
const projectMemories=new Map<string,Promise<EngramMemory>>();
function projectKey(project:string){return 'p-'+createHash('sha256').update(project).digest('hex').slice(0,24);}
async function memoryFor(project?:string){
  if(!engramEnabled)throw new Error('Engram not configured');
  if(!project){if(!memory)throw new Error('Engram not configured');return memory;}
  if(!project.trim()||project.length>100)throw new Error('Invalid memory project');
  const key=projectKey(project);
  if(!projectMemories.has(key))projectMemories.set(key,openEngramBridge(dataDir,process.env.PANTER_ENGRAM_COMMAND??'engram',key));
  return projectMemories.get(key)!;
}
/** Persist the durable ODD state first; Engram is a recovery mirror, not an authority. */
async function checkpoint(runId:string){
  const run=await harness.get(runId);if(!run)return 'HARNESS_NOT_FOUND';
  if(!engramEnabled)return 'ENGRAM_DISABLED';
  const document={project:run.project,objective:run.objective,revision:run.revision,
    candidateSha:run.candidateSha,steps:run.steps.map(s=>({id:s.id,phase:s.phase,status:s.status,evidence:s.result?.evidence??[],digest:s.result?.digest??null})),
    reviewId:run.reviewId,judgmentId:run.judgmentId,deliveryStrategy:run.deliveryStrategy??null};
  const body=JSON.stringify(document);
  if(Buffer.byteLength(body)>15500)return 'MIRROR_TOO_LARGE';
  try{await (await memoryFor(run.project)).save('gpt-a',{title:`ODD ${run.id}`,type:'architecture',topicKey:`odd/${run.id}/tasks`,content:body});
    return 'ENGRAM_SAVED';}catch{return 'ENGRAM_UNAVAILABLE';}
}

const principalContext = new AsyncLocalStorage<string>();
const peerTokens: Record<string,string> = authMode === 'dev-static' ? JSON.parse(process.env.PANTER_PEER_TOKENS ?? '{}') : {};
for(const [host,secret] of Object.entries(peerTokens)){if(!isHost(host)||typeof secret!=='string'||secret.length<24||secret===token)throw new Error('Invalid PANTER_PEER_TOKENS');}
if(new Set(Object.values(peerTokens)).size!==Object.keys(peerTokens).length)throw new Error('Peer tokens must be unique');
function principal(){return principalContext.getStore()??'unknown'}
function hostPrincipal(){const p=principal();if(!isHost(p))throw new Error('Peer identity required');return p}
function requireLeader(){if(principal()!=='gpt-a')throw new Error('GPT-A required')}
function requireAdmin(){if(principal()!=='admin')throw new Error('Admin token required')}
const missionStatus = z.enum(['DRAFT', 'READY', 'RUNNING', 'VERIFYING', 'DONE', 'BLOCKED']);
const bounded = (max = 2048) => z.string().trim().min(1).max(max);

const handler = createMcpHandler(() => {
  const server = new McpServer({ name: 'panter-ai', version: '0.15.0' }, {
    capabilities: { resources: { subscribe: true } },
    instructions: 'Panter-ai is a host-operated development harness with NO provider inference. GPT-A is the coordinator. For a new user development request start with panter_harness_start (goal + permitted work and observed facts, NEVER ask the user to pick agents, roles, skills or review lenses). Then call panter_harness_tick and execute the returned phase automatically with host tools or native subagents; call panter_harness_report after observing actual results, and repeat until blocked by actual authorization/evidence or completed. The server automatically selects ODD discovery, planning, scoped implementation, independent verification and 4R by risk; Judgment Day only when explicitly requested. An initial Agent Studio preference may bind model/host but never requires per-task specialist selection. GPT_A_ONLY forbids remote delegation while preserving maximum requested model/effort, fast native worker processing, and maximum safe host-observed parallelism. If no remote peer is connected continue with GPT-A native/inline. The host owns model selection and subagent execution; claims of model, effort, speed or children are REQUESTED, not verified. Do not misstate packet preparation as subagent execution. Panter-RDD is an independently implemented SHA-bound review gate, not the official Gentle AI Go controller; human delivery authorization remains separate. Do not merge or deploy without separately authorized tools and exact-candidate proof.'

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

  // Engram is a separate upstream stdio MCP process. Only the authenticated
  // orchestrator can curate project-scoped memory; workers hand off facts
  // through A2A receipts, never through an unrestricted memory tool.
  const memoryTypes = z.enum(['decision','architecture','bugfix','pattern','config','discovery','learning']);
  server.registerTool('panter_memory_status', {
    description:'Check whether the external Engram memory runtime is configured. Disabled is not a successful memory connection.',
    inputSchema:z.object({project:bounded(100).optional()}),annotations:{readOnlyHint:true},
  }, async ({project}) => execute(async () => {
    requireLeader();
    return {enabled:engramEnabled,project:project?projectKey(project):'panter-ai',backend:engramEnabled?'engram-mcp-stdio':'disabled',ready:'NOT_PROBED'};
  }));
  server.registerTool('panter_memory_context', {
    description:'GPT-A loads compact, project-scoped Engram recovery context. Historical observations are not current instructions.',
    inputSchema:z.object({project:bounded(100).optional(),maxBytes:z.number().int().min(512).max(16384).default(8192)}),annotations:{readOnlyHint:true},
  }, async ({project,maxBytes}) => execute(async () => {
    requireLeader();return (await memoryFor(project)).context(hostPrincipal(), maxBytes);
  }));
  server.registerTool('panter_memory_search', {
    description:'GPT-A searches curated Engram project memory; no all-project or private/personal memory access.',
    inputSchema:z.object({project:bounded(100).optional(),query:bounded(500),limit:z.number().int().min(1).max(20).default(8)}),annotations:{readOnlyHint:true},
  }, async ({project,query,limit}) => execute(async () => {
    requireLeader();return (await memoryFor(project)).search(hostPrincipal(),query,limit);
  }));
  server.registerTool('panter_memory_save', {
    description:'GPT-A saves one verified, durable engineering decision/discovery to upstream Engram with a canonical topic key. Do not save secrets or unverified worker reports.',
    inputSchema:z.object({project:bounded(100).optional(),title:bounded(160),type:memoryTypes,topicKey:bounded(160),content:bounded(16000)}),
  }, async item => execute(async () => {
    requireLeader();const {project,...save}=item;
    return (await memoryFor(project)).save(hostPrincipal(),save);
  }));
  // Worker learning/proposals stay in panter_mesh_message until GPT-A
  // independently verifies them and chooses to save them in Engram.

  const hostEnum = z.enum(HOSTS);
  const roleEnum = z.enum(['orchestrator','explorer','architect','implementer','verifier','reviewer']);
  server.registerTool('panter_mesh_profile_set',{description:'GPT-A configures a host agent profile, model and effort are requests only.',inputSchema:z.object({host:hostEnum,actorId:bounded(160),modelRequest:z.string().max(120),effortRequest:z.string().max(32),roles:z.array(roleEnum).min(1),coordinationMode:z.enum(['AUTO','GPT_A_ONLY']).optional(),preferNativeSubagents:z.boolean().optional(),maxRequestedNativeWorkers:z.number().int().min(0).max(32).optional(),expectedRevision:z.number().int().nonnegative()})},async x=>execute(()=>mesh.setProfile(hostPrincipal(),x,x.expectedRevision)));
  server.registerTool('panter_mesh_profiles',{description:'List configured host profiles.',inputSchema:z.object({}),annotations:{readOnlyHint:true}},async()=>execute(()=>mesh.profiles()));
  server.registerTool('panter_mesh_delegate',{description:'GPT-A creates actor-bound A2A work for one configured host.',inputSchema:z.object({missionId:bounded(120),target:hostEnum,role:roleEnum,instruction:bounded(20000),idempotencyKey:bounded(160)})},async x=>execute(()=>mesh.delegate(hostPrincipal(),x)));
  server.registerTool('panter_mesh_pending',{description:'Return pointers to work assigned to authenticated host.',inputSchema:z.object({}),annotations:{readOnlyHint:true}},async()=>execute(()=>mesh.pending(hostPrincipal())));
  server.registerTool('panter_mesh_claim',{description:'Claim actor-owned work with a fenced attempt and obtain instructions.',inputSchema:z.object({workId:z.uuid(),leaseSeconds:z.number().int().min(30).max(3600).default(300)})},async x=>execute(()=>mesh.claim(hostPrincipal(),x.workId,x.leaseSeconds)));
  server.registerTool('panter_mesh_heartbeat',{description:'Renew exact worker lease.',inputSchema:z.object({workId:z.uuid(),attemptId:z.uuid(),leaseGeneration:z.number().int().positive(),leaseSeconds:z.number().int().min(30).max(3600).default(300)})},async x=>execute(()=>mesh.heartbeat(hostPrincipal(),x.workId,x.attemptId,x.leaseGeneration,x.leaseSeconds)));
  server.registerTool('panter_mesh_complete',{description:'Submit fenced terminal receipt; result is automatically delivered to GPT-A inbox.',inputSchema:z.object({workId:z.uuid(),attemptId:z.uuid(),leaseGeneration:z.number().int().positive(),result:z.string().max(50000),success:z.boolean().default(true)})},async x=>execute(()=>mesh.complete(hostPrincipal(),x.workId,x.attemptId,x.leaseGeneration,x.result,x.success)));
  server.registerTool('panter_mesh_message',{description:'Send actor-bound A2A question, answer or progress update to collaborator or GPT-A.',inputSchema:z.object({missionId:bounded(120),to:hostEnum,workId:z.uuid(),kind:z.enum(['QUESTION','ANSWER','UPDATE']),text:bounded(10000)})},async x=>execute(()=>mesh.message(hostPrincipal(),x)));
  server.registerTool('panter_mesh_inbox',{description:'Retrieve only the authenticated actor inbox; since is a durable per-actor revision cursor.',inputSchema:z.object({since:z.number().int().nonnegative().default(0)}),annotations:{readOnlyHint:true}},async x=>execute(()=>mesh.inbox(hostPrincipal(),x.since)));

  // The catalog is centrally stored in MCP: hosts receive only a frozen,
  // relevant packet after assignment. Skills do not grant execution rights.
  server.registerTool('panter_gentle_catalog',{
    description:'List all ten Gentle Shell specialist definitions, thirteen MCP-hosted skills, 4R lenses and Judgment Day agents; only GPT-A configures them.',
    inputSchema:z.object({}),annotations:{readOnlyHint:true}
  },async()=>execute(async()=>{requireLeader();return gentleCatalog()}));

  server.registerTool('panter_gentle_orchestrator_read',{
    description:'GPT-A lazily reads one pinned ODD orchestration section from the upstream Gentle Shell assets; Pi-specific mechanisms are reference only.',
    inputSchema:z.object({section:z.enum(GENTLE_ORCHESTRATOR_SECTIONS)}),annotations:{readOnlyHint:true}
  },async ({section})=>execute(async()=>{requireLeader();return readOrchestratorSection(section)}));
  server.registerTool('panter_gentle_agent_read',{
    description:'GPT-A reads one allowlisted, version-pinned upstream agent definition.',
    inputSchema:z.object({id:z.enum(GENTLE_AGENTS.map(a=>a.id) as [string,...string[]])}),annotations:{readOnlyHint:true}
  },async ({id})=>execute(async()=>{requireLeader();return readAgent(id)}));
  server.registerTool('panter_gentle_skill_read',{
    description:'GPT-A reads one MCP-hosted skill; worker packets contain only assigned skills.',
    inputSchema:z.object({id:z.enum(GENTLE_SKILLS.map(s=>s.id) as [string,...string[]])}),annotations:{readOnlyHint:true}
  },async ({id})=>execute(async()=>{requireLeader();return readSkill(id)}));
  server.registerTool('panter_specialist_bind',{
    description:'GPT-A assigns an individual specialist to one authenticated host, requested model/effort and selected MCP skills. Separate from host credentials.',
    inputSchema:z.object({agentId:z.enum(GENTLE_AGENTS.map(a=>a.id) as [string,...string[]]),host:hostEnum,
      modelRequest:z.string().max(120),effortRequest:z.string().max(32),skillIds:z.array(z.enum(GENTLE_SKILLS.map(s=>s.id) as [string,...string[]])).max(8),expectedRevision:z.number().int().nonnegative()})
  },async ({expectedRevision,...input})=>execute(()=>mesh.bindSpecialist(hostPrincipal(),input,expectedRevision)));
  server.registerTool('panter_specialist_assignments',{
    description:'Read individual specialist assignments (distinct from five host connection profiles).',
    inputSchema:z.object({}),annotations:{readOnlyHint:true}
  },async()=>execute(async()=>{requireLeader();return mesh.specialistBindings()}));
  server.registerTool('panter_specialist_delegate',{
    description:'GPT-A dispatches a centrally versioned agent + assigned skills as a frozen A2A task to its configured host; result returns to GPT-A inbox.',
    inputSchema:z.object({missionId:bounded(120),agentId:z.enum(GENTLE_AGENTS.map(a=>a.id) as [string,...string[]]),objective:bounded(6000),idempotencyKey:bounded(160),candidateSha:z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/).optional(),allowedEditSurfaces:z.array(z.string().min(1).max(256)).max(16).optional()})
  },async input=>execute(()=>mesh.delegateBoundSpecialist(hostPrincipal(),input)));

  server.registerTool('panter_odd_route',{
    description:'GPT-A applies the Gentle Shell ODD small/inline vs exploratory/coordinated and risk-based verification rules; planning-only.',
    inputSchema:z.object({requirementsClear:z.boolean(),resumableFromDiff:z.boolean(),risk:z.enum(['low','high']),unknownCodeArea:z.boolean(),independentWorkUnits:z.number().int().min(0).max(32),writesAuthorized:z.boolean()}),
    annotations:{readOnlyHint:true}
  },async input=>execute(async()=>{requireLeader();return routeFlow(input)}));
  server.registerTool('panter_review_start',{
    description:'GPT-A atomically delegates 4R four independent lenses or exactly two blind Judgment Day judges to their configured hosts using one frozen candidate SHA. No automatic approval or fix.',
    inputSchema:z.object({missionId:bounded(120),kind:z.enum(['4r','judgment-day']),objective:bounded(6000),candidateSha:z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/),idempotencyKey:bounded(160)})
  },async input=>execute(()=>mesh.startReview(hostPrincipal(),input)));
  server.registerTool('panter_review_status',{
    description:'Read durable 4R / Judgment Day receipts for a review session. When complete, GPT-A must independently assess outputs; this is not native provider approval.',
    inputSchema:z.object({reviewId:z.uuid()}),annotations:{readOnlyHint:true}
  },async ({reviewId})=>execute(()=>mesh.reviewStatus(hostPrincipal(),reviewId)));
  server.registerTool('panter_review_blueprints',{
    description:'Return native 4R and Judgment Day workflow blueprints. Requires a frozen SHA; planned tasks are not executed by this read.',
    inputSchema:z.object({candidateSha:z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/),kind:z.enum(['4r','judgment-day'])}),annotations:{readOnlyHint:true}
  },async ({candidateSha,kind})=>execute(async()=>{requireLeader();const ids=kind==='4r'?REVIEW_4R:JUDGMENT_DAY;
    const bindings=await mesh.specialistBindings();const steps=ids.map((id,index)=>({agentId:id,host:bindings.find(b=>b.agentId===id)?.host??null,stage:kind==='judgment-day'?(index<2?'BLIND_JUDGE':'CONDITIONAL_SCOPED_FIX'):'INDEPENDENT_LENS',candidateSha}));
    return {kind,candidateSha,steps,ready:steps.every(s=>s.host!==null),rules:kind==='4r'?'Four independent lens reports; do not claim verified until external evidence.':'Exactly two initially blind judge delegations; correction only for frozen severe findings after controller validation; no automatic merge.'};
  }));

  const nativeAssignmentSchema = z.object({agentId:z.enum(GENTLE_AGENTS.map(a=>a.id) as [string,...string[]]), objective:bounded(6000),candidateSha:z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/).optional(),allowedEditSurfaces:z.array(z.string().min(1).max(256)).max(16).optional()});
  // GPT-A uses the existing durable ODD AgentEngine without the legacy
  // administrator bearer. No collaborator is needed to make progress.
  server.registerTool('panter_native_mission_create',{
    description:'GPT-A creates a durable engineering mission for ODD fallback. Does not authorize filesystem writes.',
    inputSchema:z.object({project:bounded(100),goal:bounded(4000)})
  },async x=>execute(async()=>{requireLeader();return store.createMission(x.project,x.goal)}));
  server.registerTool('panter_native_flow_start',{
    description:'GPT-A records the verbatim request, risk, authorizations and review requirement to recover ODD across sessions.',
    inputSchema:z.object({missionId:z.uuid(),spec:bounded(30000),signals:flowSignals,reviewRequired:z.boolean().default(false)})
  },async x=>execute(async()=>{requireLeader();return agents.createFlow(x.missionId,x.spec,x.signals,x.reviewRequired)}));
  server.registerTool('panter_native_phase_enqueue',{
    description:'GPT-A records a durable scout/designer/builder phase for inline or genuine native-subagent execution; never self-registers as an independent reviewer.',
    inputSchema:z.object({flowId:z.uuid(),role:z.enum(['scout','designer','builder']),objective:bounded(10000),
      scopes:z.array(bounded(256)).max(32).default([]),workspace:bounded(100).default('default'),dependsOn:z.array(z.uuid()).max(32).default([]),idempotencyKey:bounded(160)})
  },async x=>execute(async()=>{requireLeader();if(x.role==='builder')throw new Error('Legacy native builders require the operator-granted automatic harness');return agents.addTask({...x,target:'gpt-a'})}));
  server.registerTool('panter_native_phase_claim',{
    description:'GPT-A claims the next dependency-ready native phase. This is a durable lease, NOT proof of model invocation.',
    inputSchema:z.object({leaseSeconds:z.number().int().min(30).max(3600).default(300)})
  },async ({leaseSeconds})=>execute(async()=>{requireLeader();return agents.claim('gpt-a','gpt-a',leaseSeconds)}));
  server.registerTool('panter_native_phase_packet',{
    description:'GPT-A reads the exact ODD requirement and handoff of a recorded phase. Use panter_native_packet for agent+skill instructions.',
    inputSchema:z.object({taskId:z.uuid()}),annotations:{readOnlyHint:true}
  },async ({taskId})=>execute(async()=>{requireLeader();const task=await agents.getTask(taskId);if(task?.target!=='gpt-a')throw new Error('Not GPT-A native phase');return agents.packet(taskId)}));
  server.registerTool('panter_native_phase_complete',{
    description:'GPT-A records a claimed inline/native-subagent phase result and its host-reported evidence. Independent verification is never inferred.',
    inputSchema:z.object({taskId:z.uuid(),leaseGeneration:z.number().int().positive(),result:z.object({summary:bounded(10000),evidence:z.array(bounded(1000)).max(40)}),success:z.boolean().default(true)})
  },async x=>execute(async()=>{requireLeader();const task=await agents.getTask(x.taskId);if(task?.target!=='gpt-a'||!['scout','designer','builder'].includes(task.role))throw new Error('Not a permitted GPT-A native phase');return agents.report(x.taskId,'gpt-a',x.leaseGeneration,x.result,x.success)}));
  server.registerTool('panter_native_flow_status',{
    description:'Recover a durable GPT-A ODD flow and its native-phase evidence after context loss or disconnection.',
    inputSchema:z.object({flowId:z.uuid()}),annotations:{readOnlyHint:true}
  },async ({flowId})=>execute(async()=>{requireLeader();return agents.summary(flowId)}));
  server.registerTool('panter_native_candidate_freeze',{
    description:'GPT-A records the candidate commit SHA for subsequent independent verification; a SHA string is not independently verified.',
    inputSchema:z.object({flowId:z.uuid(),candidateSha:z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/),expectedRevision:z.number().int().positive()})
  },async x=>execute(async()=>{requireLeader();return agents.freezeCandidate(x.flowId,x.candidateSha,x.expectedRevision)}));
  server.registerTool('panter_native_flow_close',{
    description:'Close a completed GPT-A ODD flow only if the stored verification/review gates allow it. High-risk flows cannot self-approve.',
    inputSchema:z.object({flowId:z.uuid(),expectedRevision:z.number().int().positive()})
  },async x=>execute(async()=>{requireLeader();return agents.closeFlow(x.flowId,x.expectedRevision)}));

  // Organic harness: one user objective, automatic role/skill/risk routing, durable phase recovery.
  // There is no agent picker in this surface; GPT-A supplies observations, not selections.
  const harnessRuntimeSchema=z.object({nativeSubagents:z.boolean(),maxParallelSubagents:z.number().int().min(0).max(32),
    toolsAvailable:z.boolean(),peerStates:z.partialRecord(z.enum(HOSTS),z.enum(['CONNECTED','UNAVAILABLE','UNKNOWN'])).optional()});
  server.registerTool('panter_harness_write_grant',{
    description:'Admin-only explicit bounded write authorization for a particular project/objective; GPT-A cannot issue its own permission.',
    inputSchema:z.object({project:bounded(100),objective:bounded(6000),allowedPaths:z.array(bounded(256)).min(1).max(16),ttlSeconds:z.number().int().min(60).max(86400)})
  },async x=>execute(async()=>{requireAdmin();return harness.grantWrite(x)}));
  server.registerTool('panter_harness_start',{ 
    description:'Automatically classify an engineering objective and persist ODD phases. GPT-A does NOT select agents/skills; no inference or edits run on the MCP.',
    inputSchema:z.object({project:bounded(100),githubRepository:z.string().max(120).optional(),githubPrNumber:z.number().int().positive().optional(),githubExpectedBase:z.string().max(100).optional(),objective:bounded(6000),idempotencyKey:bounded(160),writesAuthorized:z.boolean(),writeGrantId:z.uuid().optional(),
      changeSurfaces:z.array(z.string().min(1).max(256)).max(16).optional(),
      judgmentDayRequested:z.boolean().optional(),
      observations:z.object({requirementsClear:z.boolean().optional(),resumableFromDiff:z.boolean().optional(),
        unknownCodeArea:z.boolean().optional(),independentWorkUnits:z.number().int().min(0).max(32).optional()}).optional(),
      capabilities:harnessRuntimeSchema.optional()})
  },async x=>execute(async()=>{requireLeader();const profile=(await mesh.profiles()).find(p=>p.host==='gpt-a');
    const {capabilities,...spec}=x;const run=await harness.start({...spec,coordinationMode:profile?.coordinationMode??'AUTO'});
    const memoryCheckpoint=await checkpoint(run.id);
    return capabilities?{run,next:await harness.tick(run.id,capabilities),memoryCheckpoint}:{run,memoryCheckpoint};}));
  server.registerTool('panter_harness_tick',{
    description:'Automatically choose the next ODD phase, load MCP-hosted skills, dispatch an available configured remote specialist or return native child packets. No user agent selection.',
    inputSchema:z.object({runId:z.uuid(),capabilities:harnessRuntimeSchema})
  },async x=>execute(async()=>{requireLeader();return harness.tick(x.runId,x.capabilities)}));
  server.registerTool('panter_harness_report',{
    description:'Record observed evidence from an automatically selected ODD phase and continue; high-risk candidate SHA and independent verification are mandatory.',
    inputSchema:z.object({runId:z.uuid(),stepId:z.uuid(),report:z.object({summary:bounded(6000),evidence:z.array(bounded(1000)).min(1).max(40),
      runId:z.string().max(160).optional(),candidateSha:z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/).optional(),
      discoveredPaths:z.array(z.string().min(1).max(256)).max(16).optional()}),capabilities:harnessRuntimeSchema})
  },async x=>execute(async()=>{requireLeader();await harness.report(x.runId,x.stepId,x.report);const memoryCheckpoint=await checkpoint(x.runId);
    return {...await harness.tick(x.runId,x.capabilities),memoryCheckpoint}}));
  server.registerTool('panter_harness_github_bind',{
    description:'GPT-A attaches a verified, previously authorized existing/created PR to an automatic ODD run. Metadata only: no GitHub writes, no agent selection, no approval.',
    inputSchema:z.object({runId:z.uuid(),repository:bounded(120),prNumber:z.number().int().positive(),
      expectedBase:z.string().max(100).optional(),expectedRevision:z.number().int().positive()})
  },async x=>execute(async()=>{requireLeader();return harness.bindGithub(x.runId,{repository:x.repository,
    prNumber:x.prNumber,expectedBase:x.expectedBase},x.expectedRevision)}));
  server.registerTool('panter_harness_correction_report',{
    description:'GPT-A registers an authorized bounded correction with a fresh real Git SHA. Automatically resets verifier, 4R and Judgment Day, and invalidates old review evidence.',
    inputSchema:z.object({runId:z.uuid(),expectedRevision:z.number().int().positive(),report:z.object({candidateSha:z.string().regex(/^[a-f0-9]{40}$/),runId:bounded(160),evidence:z.array(bounded(1000)).min(1).max(30)})})
  },async x=>execute(async()=>{requireLeader();return harness.recordCorrection(x.runId,x.report,x.expectedRevision)}));
  server.registerTool('panter_harness_units_set',{
    description:'GPT-A automatically decomposes completed design into disjoint, scoped implementation units. Requires actual separate host worktrees for parallel writers.',
    inputSchema:z.object({runId:z.uuid(),expectedRevision:z.number().int().positive(),units:z.array(z.object({objective:bounded(3000),paths:z.array(bounded(256)).min(1).max(12)})).min(2).max(16)})
  },async x=>execute(async()=>{requireLeader();return harness.defineUnits(x.runId,x.units,x.expectedRevision)}));
  server.registerTool('panter_harness_unit_report',{
    description:'Record one actually executed implementation child with unique run ID and concrete evidence; no fabricated invocation is permitted.',
    inputSchema:z.object({runId:z.uuid(),unitId:z.uuid(),result:z.object({runId:bounded(160),summary:bounded(3000),evidence:z.array(bounded(1000)).min(1).max(30)})})
  },async x=>execute(async()=>{requireLeader();return harness.reportUnit(x.runId,x.unitId,x.result)}));
  server.registerTool('panter_harness_delivery_strategy_set',{
    description:'Operator-only, explicitly authorized GitHub delivery strategy; no merge/push/write authority. Persists the choice for automatic GitHub and RDD gates.',
    inputSchema:z.object({runId:z.uuid(),strategy:z.enum(['single-pr','feature-branch-chain','stacked-to-main']),expectedRevision:z.number().int().positive()})
  },async x=>execute(async()=>{requireAdmin();return harness.setDeliveryStrategy(x.runId,x.strategy,x.expectedRevision)}));
  server.registerTool('panter_harness_github_check',{
    description:'Read-only Gentle Shell GitHub delivery gate: verify target allowlist, branch, exact frozen PR head SHA, approved linked issue, one type label, CI checks and review budget. Never pushes, merges, opens PRs or grants deployment permission.',
    inputSchema:z.object({runId:z.uuid(),prNumber:z.number().int().positive(),expectedBase:z.string().max(100).optional(),
      deliveryStrategy:z.enum(['single-pr','feature-branch-chain','stacked-to-main']).optional()}),
    annotations:{readOnlyHint:true}
  },async x=>execute(async()=>{requireLeader();const run=await harness.get(x.runId);
    if(!run)throw new Error('Harness not found');
    if(!run.candidateSha||!/^[a-f0-9]{40}$/.test(run.candidateSha))throw new Error('Exact Git commit SHA is required before remote verification');
    const gate=await githubGate.inspect({repository:run.githubRepository??run.project,prNumber:x.prNumber,expectedSha:run.candidateSha,
      expectedBase:x.expectedBase,deliveryStrategy:x.deliveryStrategy??run.deliveryStrategy,
      // A model cannot assert human consent for an oversize PR: choose the
      // strategy with the user; authorization is separately operator-configured.
      parentAuthorizedSinglePr:process.env.PANTER_GITHUB_SINGLE_PR_APPROVED==='1'});
    return {...gate,reviewStatus:run.reviewKind?'NATIVE_RDD_AUTHORITY_STILL_REQUIRED':'NO_NATIVE_RDD_ASSERTION',
      next:gate.state==='REVIEWABLE'?'Evidence is ready for human review, NOT permission to merge/deploy.':
        'Resolve blockers through separately authorized GitHub operations; do not infer delivery permission.'};
  }));
  server.registerTool('panter_rdd_status',{
    description:'GPT-A inspects and refreshes the self-hosted Panter-RDD review for a harness run. Reviewer output cannot grant GitHub delivery permission.',
    inputSchema:z.object({runId:z.uuid()}),annotations:{readOnlyHint:true}
  },async x=>execute(async()=>{requireLeader();const run=await harness.get(x.runId);
    if(!run)throw new Error('Harness not found');if(!run.reviewId)return {status:'REVIEW_NOT_STARTED'};
    const record=await panterRdd.getForReview(run.reviewId);
    return record?panterRdd.assess(record.id):{status:'REVIEW_NOT_YET_REGISTERED'};
  }));
  server.registerTool('panter_rdd_supersede',{
    description:'Retire a corrected, unacknowledged candidate when an independently registered fresh-SHA review exists. Does not authorize fixes, commits, merges or deployment.',
    inputSchema:z.object({reviewId:z.uuid(),newReviewId:z.uuid(),expectedRevision:z.number().int().positive()})
  },async x=>execute(async()=>{requireLeader();return panterRdd.supersede(x.reviewId,x.newReviewId,x.expectedRevision)}));
  server.registerTool('panter_harness_status',{
    description:'Recover exact automatic ODD route, risks, phase status and pending candidate/review gates after a session restart.',
    inputSchema:z.object({runId:z.uuid()}),annotations:{readOnlyHint:true}
  },async x=>execute(async()=>{requireLeader();return harness.get(x.runId)}));

  server.registerTool('panter_native_mode_set',{
    description:'GPT-A persists user choice AUTO or GPT_A_ONLY. Solo mode refuses remote delegation while requesting maximum native model, effort, speed and parallelism.',
    inputSchema:z.object({coordinationMode:z.enum(['AUTO','GPT_A_ONLY']),expectedRevision:z.number().int().nonnegative()})
  },async x=>execute(async()=>{requireLeader();return mesh.setCoordinationMode('gpt-a',x.coordinationMode,x.expectedRevision)}));

  server.registerTool('panter_native_plan',{ 
    description:'GPT-A requests maximum model/effort, fast native subagents and maximum safe parallelism even when working alone. GPT_A_ONLY forbids remote delegation regardless of peer availability. Reports capability gaps; does not launch models.',
    inputSchema:z.object({signals:z.object({requirementsClear:z.boolean(),resumableFromDiff:z.boolean(),risk:z.enum(['low','high']),unknownCodeArea:z.boolean(),independentWorkUnits:z.number().int().min(0).max(32),writesAuthorized:z.boolean()}), assignments:z.array(nativeAssignmentSchema).min(1).max(32),peerStates:z.partialRecord(z.enum(HOSTS),z.enum(['CONNECTED','UNAVAILABLE','UNKNOWN'])).optional(),coordinationMode:z.enum(['AUTO','GPT_A_ONLY']).optional(),capabilities:z.object({nativeSubagents:z.boolean(),maxParallelSubagents:z.number().int().min(0).max(32),toolsAvailable:z.boolean(),observedModel:z.string().max(120).optional(),observedReasoningEffort:z.string().max(32).optional(),observedWorkerProcessing:z.string().max(32).optional()})}),annotations:{readOnlyHint:true}
  },async x=>execute(async()=>{requireLeader();const owner=(await mesh.profiles()).find(p=>p.host==='gpt-a');const requested=owner?.maxRequestedNativeWorkers??32;const enabled=owner?.preferNativeSubagents!==false;return planHostNative({signals:x.signals,assignments:x.assignments,bindings:await mesh.specialistBindings(),peerStates:x.peerStates??{},coordinationMode:x.coordinationMode??owner?.coordinationMode??'AUTO',requestedNativeWorkers:enabled?requested:0,capabilities:{...x.capabilities,nativeSubagents:x.capabilities.nativeSubagents&&enabled,evidence:'HOST_REPORTED_UNVERIFIED'}})}));
  server.registerTool('panter_native_packet',{
    description:'GPT-A loads a pinned specialist + MCP-hosted skills for inline/direct or truly available native-subagent execution. Does not require a remote host.',inputSchema:nativeAssignmentSchema.extend({skillIds:z.array(z.enum(GENTLE_SKILLS.map(s=>s.id) as [string,...string[]])).max(8).optional(),modelRequest:z.string().max(120).optional(),effortRequest:z.string().max(32).optional()}),annotations:{readOnlyHint:true}
  },async input=>execute(async()=>{requireLeader();return nativePacket(input)}));
  server.registerTool('panter_native_odd_instructions',{
    description:'Lazily retrieve the full pinned Gentle Shell coordinator ODD instructions with a warning that Pi-specific mechanisms do not execute in ChatGPT.',inputSchema:z.object({}),annotations:{readOnlyHint:true}
  },async()=>execute(async()=>{requireLeader();return nativeOddInstructions()}));
  server.registerTool('panter_review_evidence',{
    description:'Check exact-SHA reviewer reports and terminal receipts for one 4R / Judgment Day session. Never grants native review approval.',inputSchema:z.object({reviewId:z.uuid()}),annotations:{readOnlyHint:true}
  },async ({reviewId})=>execute(async()=>{requireLeader();const state=await mesh.reviewStatus(hostPrincipal(),reviewId);return assessMeshReview({candidateSha:state.review.candidateSha,kind:state.review.kind,work:state.work})}));
  // GPT-A-owned subagent review. All four 4R lenses (or two blind JD judges)
  // are prepared as separate frozen packets. GPT-A asks its host to launch
  // native subagents in parallel; the MCP does not start model inference.
  server.registerTool('panter_native_review_create',{
    description:'GPT-A prepares four independent 4R slots or two blind Judgment Day slots, with versioned MCP skills and frozen candidate SHA. Works in GPT_A_ONLY without any remote workers.',
    inputSchema:z.object({missionId:bounded(120),kind:z.enum(['4r','judgment-day']),objective:bounded(6000),candidateSha:z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/),idempotencyKey:bounded(160)})
  },async x=>execute(async()=>{requireLeader();return nativeSubagentReview.create(x)}));
  server.registerTool('panter_native_review_packet',{
    description:'Retrieve exactly one frozen reviewer/skill packet. Blind Judge A/B never see each other outputs; no model is started by the MCP.',
    inputSchema:z.object({reviewId:z.uuid(),slotId:z.uuid()}),annotations:{readOnlyHint:true}
  },async x=>execute(async()=>{requireLeader();return nativeSubagentReview.packet(x.reviewId,x.slotId)}));
  server.registerTool('panter_native_review_batch',{
    description:'Automatically selects native subagent 4R/Judgment Day packets when supported. With zero native slots, returns exactly one sequential GPT-A SOLO 4R lens at a time; use panter_native_review_submit_solo. Solo reports are never independent or RDD-approved. Judgment Day requires real separate judges.',
    inputSchema:z.object({reviewId:z.uuid(),observedNativeParallelism:z.number().int().min(0).max(32)}),annotations:{readOnlyHint:true}
  },async x=>execute(async()=>{requireLeader();return nativeSubagentReview.batch(x.reviewId,x.observedNativeParallelism)}));
  server.registerTool('panter_native_review_submit',{
    description:'Record one host-reported native subagent run and structured SHA/packet-bound evidence. Immutable and idempotent; cannot grant RDD approval.',
    inputSchema:z.object({reviewId:z.uuid(),slotId:z.uuid(),report:z.object({agentId:bounded(100),candidateSha:z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/),packetDigest:z.string().regex(/^[0-9a-f]{64}$/),subagentRunId:bounded(160),evidence:z.array(bounded(1000)).min(1).max(40),findings:z.array(z.object({id:bounded(100),location:bounded(400),severity:z.enum(['BLOCKER','CRITICAL','WARNING','SUGGESTION']),claim:bounded(2000),proofRefs:z.array(bounded(600)).min(1).max(12)})).max(80),attestation:z.object({keyId:bounded(80),signature:bounded(160)}).optional()})})
  },async x=>execute(async()=>{requireLeader();return nativeSubagentReview.submit(x.reviewId,x.slotId,x.report)}));
  server.registerTool('panter_native_review_submit_solo',{
    description:'Record one GPT-A self-reviewed 4R lens when native subagents are unavailable. Explicitly UNVERIFIED: never independently attested or Panter-RDD-approved.',
    inputSchema:z.object({reviewId:z.uuid(),slotId:z.uuid(),report:z.object({
      agentId:bounded(100),candidateSha:z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/),
      packetDigest:z.string().regex(/^[a-f0-9]{64}$/),
      evidence:z.array(bounded(1000)).min(1).max(40),
      findings:z.array(z.object({id:bounded(100),location:bounded(400),
        severity:z.enum(['BLOCKER','CRITICAL','WARNING','SUGGESTION']),
        claim:bounded(2000),proofRefs:z.array(bounded(600)).min(1).max(12)})).max(80)})})
  },async x=>execute(async()=>{requireLeader();return nativeSubagentReview.submitSolo(x.reviewId,x.slotId,x.report)}));
  server.registerTool('panter_native_review_progress',{
    description:'Recover native 4R/JD and GPT-A solo four-lens progress, severe findings and explicit unverified/independent status. Never marks review officially approved.',
    inputSchema:z.object({reviewId:z.uuid()}),annotations:{readOnlyHint:true}
  },async x=>execute(async()=>{requireLeader();return nativeSubagentReview.status(x.reviewId)}));
  server.registerTool('panter_native_review_capabilities',{
    description:'Read-only capabilities query of the official Gentle AI RDD binary in an operator-configured local Git worktree. Not available by default.',inputSchema:z.object({}),annotations:{readOnlyHint:true}
  },async()=>execute(async()=>{requireLeader();return nativeReview.capabilities()}));
  server.registerTool('panter_native_review_assess',{
    description:'Read-only official Gentle AI risk preflight of the operator-pinned local worktree. Does not mutate review state or grant approval.',inputSchema:z.object({}),annotations:{readOnlyHint:true}
  },async()=>execute(async()=>{requireLeader();return nativeReview.assess()}));
  server.registerTool('panter_native_review_status',{
    description:'Read-only official Gentle AI v2 RDD status and provider-issued next transition. Never executes transitions without separate authorization.',inputSchema:z.object({}),annotations:{readOnlyHint:true}
  },async()=>execute(async()=>{requireLeader();return nativeReview.status()}));

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
    description: 'GPT-A configures five hosts plus all Gentle Shell specialist agents, requested models and centrally hosted skills. Only GPT-A saves settings.',
    inputSchema: z.object({}),
    _meta: { ui: { resourceUri: studioUri } },
  }, async () => execute(async () => { requireLeader(); return { profiles: await mesh.profiles(), specialists: await mesh.specialistBindings(), catalog: gentleCatalog(), hosts: HOSTS, modelPoliciesAreRequests: true }; }));
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
    res.end(JSON.stringify({ status: 'ok', name: 'panter-ai', version: '0.15.0' }));
    return;
  }
  if (oauth && req.method === 'GET' && (req.url === '/.well-known/oauth-protected-resource' || req.url === '/.well-known/oauth-protected-resource/mcp')) {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(oauth.protectedResourceMetadata())); return;
  }
  if (embedded && req.url !== '/mcp') {
    const host = hostname(req.headers.host);
    if (!host || !(allowedHosts.length ? allowedHosts.includes(host) : ['localhost','127.0.0.1','::1'].includes(host))) { res.writeHead(403); res.end(); return; }
    if (await embedded.handle(req, res)) return;
  }
  if (req.url !== '/mcp') { res.writeHead(404); res.end('Not found'); return; }
  const h = hostname(req.headers.host);
  const remoteAddr=req.socket.remoteAddress??'';
  const fromLoopback=['127.0.0.1','::1','::ffff:127.0.0.1'].includes(remoteAddr);
  const localOperator=!!operatorToken&&authMode!=='dev-static'&&fromLoopback&&['localhost','127.0.0.1','::1'].includes(h)&&
    !req.headers.origin&&!req.headers['x-forwarded-for']&&!req.headers['x-forwarded-host']&&
    staticBearerMatch(req.headers.authorization,operatorToken);
  if (!h || !(localOperator||(allowedHosts.length ? allowedHosts.includes(h) : ['localhost', '127.0.0.1', '::1'].includes(h)))) {
    res.writeHead(403); res.end('Host not allowed'); return;
  }
  if (req.headers.origin && !allowedOrigins.includes(req.headers.origin)) {
    res.writeHead(403); res.end('Origin not allowed'); return;
  }
  const peer=Object.entries(peerTokens).find(([,v])=>staticBearerMatch(req.headers.authorization,v))?.[0];
  let actor: string | undefined;
  if (localOperator) {
    actor='admin';
  } else if (embedded) {
    try { actor=await embedded.authenticate(req.headers.authorization); } catch { /* invalid credentials */ }
  } else if (oauth) {
    try { actor=oauth.verifyBearer(req.headers.authorization); } catch { /* invalid credentials are indistinguishable */ }
  } else {
    actor=staticBearerMatch(req.headers.authorization,token)?'admin':peer;
  }
  if (!actor) {
    res.writeHead(401, { 'www-authenticate': embedded?.challenge() ?? oauth?.challenge() ?? 'Bearer realm="panter-ai"', 'cache-control': 'no-store' });
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
