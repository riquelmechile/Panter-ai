import { leaderHost, leaderLabel, appEventHosts, freezeLeaderHost, leaderPolicyProfile, adoptPendingLeaderPhases } from './core/leadership.js';
import { ExternalOAuthVerifier, staticBearerMatch } from './core/oauth.js';
import { isAdminPrincipal, parseOwnerTrustedHosts } from './core/owner-trust.js';
import { createToolSurface, type SurfaceRole } from './core/tool-surface.js';
import { EmbeddedOAuth } from './core/embedded-oauth.js';
import { openEngramBridge } from './core/engram-runtime.js';
import { readFile, chmod, mkdir, lstat, unlink } from 'node:fs/promises';
import { connect as connectUnix } from 'node:net';
import { createHash } from 'node:crypto';
import type { EngramMemory } from './core/engram-memory.js';
import { resolve, dirname, join } from 'node:path';
import { ClientAddressPolicy, rateLimitIdentity } from './core/trusted-proxy.js';
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { AsyncLocalStorage } from 'node:async_hooks';
import { MeshEngine, HOSTS, isHost } from './core/mesh.js';
import { GitHubWorkforce, GITHUB_WRITE_OPS } from './core/github-workforce.js';
import { registerTaskWire } from './core/workforce-task-wire.js';
import { WorkforceLongPoll, withListenHint } from './core/workforce-long-poll.js';
import { GrokRoutineWake } from './core/grok-routine-wake.js';
import { ringGrokForWork, pickupClockStart } from './core/harness-wake.js';
import { GeminiMailWake, MailError } from './core/gemini-mail-wake.js';
import { WorkforceEvents, reconcileWorkforceEventOutbox } from './core/workforce-events.js';
import { registerWorkforceEventWire } from './core/workforce-event-wire.js';
import { appWorkforceTurn } from './core/workforce-app-turn.js';
import { ClaudeRoutineWake } from './core/claude-routine-wake.js';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
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
import { buildConnectionContract } from './core/connection-contract.js';
import { MODEL_REQUEST_PATTERN, EFFORT_REQUEST_PATTERN } from './core/mesh.js';

// Fail closed before any store opens on an invalid PANTER_LEAD_HOST; the leader is frozen
// for this process and never comes from tool input.
const configuredLeader = freezeLeaderHost();
console.error(`Panter leader host: ${configuredLeader}`);
const port = Number(process.env.PANTER_PORT ?? '8080');
const bind = process.env.PANTER_BIND_HOST ?? '127.0.0.1';
const authMode = process.env.PANTER_AUTH_MODE ?? 'dev-static';
if (!['dev-static', 'external-jwt', 'embedded'].includes(authMode)) throw new Error('Unsupported PANTER_AUTH_MODE');
const token = process.env.PANTER_TOKEN ?? '';
// OAuth-mode operator control is separate from AI clients and accepted on loopback only.
const operatorToken=process.env.PANTER_OPERATOR_TOKEN??'';
if(operatorToken&&(operatorToken.length<32||operatorToken===token))throw new Error('Invalid PANTER_OPERATOR_TOKEN');
const dataDir = process.env.PANTER_DATA_DIR ?? '.panter-data';
const clientAddresses=new ClientAddressPolicy(process.env.PANTER_TRUSTED_PROXY_CIDRS??'');
// A private filesystem socket, not TCP loopback or request headers, is the
// administrative trust boundary in OAuth mode.
const adminSocketPath=operatorToken&&authMode!=='dev-static'?
  resolve(process.env.PANTER_ADMIN_SOCKET??join(dataDir,'operator.sock')):null;
const allowedHosts = (process.env.PANTER_ALLOWED_HOSTS ?? '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
const allowedOrigins = (process.env.PANTER_ALLOWED_ORIGINS ?? '').split(',').map(x => x.trim()).filter(Boolean);
const loopback = ['127.0.0.1', 'localhost', '::1'].includes(bind);
if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error('Invalid PANTER_PORT');
if (authMode === 'dev-static') {
  if(token.length<24)throw new Error('PANTER_TOKEN must be at least 24 characters in dev-static mode');
  if(!loopback)throw new Error('dev-static must bind directly to loopback; use embedded OAuth for containers and proxies');
  if(process.env.PANTER_PUBLIC_MCP_URL)throw new Error('dev-static cannot advertise a public MCP URL');
  if(allowedHosts.some(h=>!['127.0.0.1','localhost','::1'].includes(h)))
    throw new Error('dev-static accepts loopback Host names only');
}
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
  clientIdentity:req=>clientAddresses.identify(req),
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
if (mesh.leaderSwitch) console.error(`Panter leader switch ${mesh.leaderSwitch.from} -> ${mesh.leaderSwitch.to}`);
for (const line of await adoptPendingLeaderPhases(mesh, agents)) console.error(line);
const workforceLongPoll = new WorkforceLongPoll(mesh);
// GitHub for workers: the operator token stays server-side (PANTER_GITHUB_WORKFORCE_TOKEN), never in repo or packets.
const githubWorkforce = new GitHubWorkforce(dataDir, mesh, leaderHost);
const grokRoutineWake = new GrokRoutineWake();
const claudeRoutineWake = new ClaudeRoutineWake();
const workforceEvents = new WorkforceEvents(dataDir);
mesh.setStandingListenerCheck(host=>workforceLongPoll.isListening(host));
// Gemini's only event trigger is a Gmail monitor: wake it by e-mail through the operator's relay.
const geminiMailWake = new GeminiMailWake(dataDir, mesh, ()=>workforceLongPoll.isListening('gemini'),
  leaderHost()==='gemini' ? {} : process.env);
const nativeSubagentReview = await NativeSubagentReview.open(dataDir);
const githubGate = new GitHubDeliveryGate({
  allowedRepositories:(process.env.PANTER_GITHUB_ALLOWED_REPOS??'').split(',').map(x=>x.trim()).filter(Boolean),
  requiredChecks:(process.env.PANTER_GITHUB_REQUIRED_CHECKS??'').split(',').map(x=>x.trim()).filter(Boolean),
  token:process.env.PANTER_GITHUB_TOKEN||undefined,
  independentReviewer:process.env.PANTER_GITHUB_INDEPENDENT_REVIEWER||undefined,
});
const nativeReview = await NativeReviewBridge.open({enabled:process.env.PANTER_NATIVE_REVIEW_ENABLED==='1',binary:process.env.PANTER_GENTLE_AI_BIN??'gentle-ai',repositoryRoot:process.env.PANTER_NATIVE_REVIEW_WORKTREE??''});
const rddKeysFile=process.env.PANTER_RDD_RUNNER_KEYS_FILE;
const rddRunnerKeys:Record<string,string>=rddKeysFile?JSON.parse(await readFile(rddKeysFile,'utf8')):{};
// Local checks run code (possibly worker-written) under Panter's own UID: such a child could read the parent's
// environment or env file, so they never share a process with the workforce GitHub token.
if(process.env.PANTER_RDD_LOCAL_WORKTREES_FILE&&process.env.PANTER_GITHUB_WORKFORCE_TOKEN)
  throw new Error('PANTER_RDD_LOCAL_WORKTREES_FILE cannot be combined with PANTER_GITHUB_WORKFORCE_TOKEN in the same process: run local checks in an isolated runner');
const localGit=process.env.PANTER_RDD_LOCAL_WORKTREES_FILE?await LocalGitVerifier.open(process.env.PANTER_RDD_LOCAL_WORKTREES_FILE):null;
// Operator opt-in: remote 4R / Judgment Day lens receipts delivered to Panter over each host's authenticated channel
// count as attested (which host delivered which report), in place of runner signatures the hosts cannot produce.
const rddTransportAttestation = process.env.PANTER_RDD_TRANSPORT_ATTESTATION === '1';
const panterRdd = await PanterRdd.open(dataDir,nativeSubagentReview,mesh,githubGate,rddRunnerKeys,localGit,rddTransportAttestation,
  ()=>githubWorkforce.writerHosts());
const harness = await AutomaticHarness.open(dataDir,mesh,nativeSubagentReview,githubGate,nativeReview,panterRdd,true);
// Bound hosts run the harness phases. Hosts reached only by e-mail (no repository access) get the candidate diff
// as packet material; every other host gets a work-scoped GitHub grant for its phase; a host that does not start
// a dispatched phase in time loses it to native execution.
// Work-scoped GitHub grants are issued automatically only when the operator opted in (a standing, separate
// authorization for GitHub writes); otherwise hosts keep the manual, leader-issued grant flow.
const autoGithubGrants = process.env.PANTER_HARNESS_AUTO_GITHUB_GRANTS === '1';
const materialHosts = new Set((process.env.PANTER_MATERIAL_HOSTS ?? 'gemini').split(',').map(x => x.trim()).filter(Boolean));
const pickupSeconds = Number(process.env.PANTER_REMOTE_PICKUP_TIMEOUT_SECONDS ?? '180');
const pickupMailSeconds = Number(process.env.PANTER_REMOTE_PICKUP_TIMEOUT_SECONDS_MAIL ?? '1200');
// Optional per-host override, e.g. PANTER_REMOTE_PICKUP_TIMEOUT_SECONDS_GROK for a host whose routine runs one work at a time.
const pickupPerHost = new Map(HOSTS.map(h => [h, process.env[`PANTER_REMOTE_PICKUP_TIMEOUT_SECONDS_${h.toUpperCase().replace(/-/g, '_')}`]] as const)
  .filter((e): e is readonly [typeof HOSTS[number], string] => e[1] !== undefined && e[1] !== '').map(([h, v]) => [h, Number(v)]));
if (![pickupSeconds, pickupMailSeconds, ...pickupPerHost.values()].every(n => Number.isInteger(n) && n >= 30 && n <= 86_400)) throw new Error('Invalid remote pickup timeout (30-86400 seconds)');
harness.setHostHooks({
  materialFor: async (run, host) => {
    if (!materialHosts.has(host) || !githubWorkforce.configured || !run.githubRepository || !/^[a-f0-9]{40}$/.test(run.candidateSha ?? '')) return undefined;
    try { return await githubWorkforce.candidateMaterial(run.githubRepository, run.githubExpectedBase ?? null, run.candidateSha!); } catch { return undefined; }
  },
  afterDispatch: async ({ run, workId, phase, host }) => {
    const grantFor = async () => {
      if (!autoGithubGrants || !githubWorkforce.configured || !run.githubRepository || materialHosts.has(host)) return;
      // Commits/PRs also need the run's own operator write approval (IMPLEMENT is never dispatched without it).
      if (phase === 'IMPLEMENT' && run.permission !== 'WRITE_APPROVED') return;
      const comment = (phase === 'VERIFY' || phase === 'REVIEW' || phase === 'JUDGMENT') && run.githubPrNumber ? ['comment' as const] : [];
      await githubWorkforce.grant(leaderHost(), { workId, repository: run.githubRepository, auto: true,
        ops: phase === 'IMPLEMENT' ? ['commit', 'pr'] : comment, numbers: comment.length ? [run.githubPrNumber!] : [],
        // The implementer commits only inside the run's approved edit surfaces.
        ...(phase === 'IMPLEMENT' ? { paths: run.paths } : {}),
        // The worker branches from, and opens its PR against, the run's target base.
        ...(phase === 'IMPLEMENT' && run.githubExpectedBase ? { base: run.githubExpectedBase } : {}) });
    };
    // The grant exists before any doorbell rings, so a fast worker never finds itself without access.
    try { await grantFor(); } finally {
      // Grok is woken only by its routine webhook: ring it for harness work too (even if the grant failed).
      if (host === 'grok') await ringGrokForWork(mesh, grokRoutineWake, workId).catch(() => undefined);
    }
  },
  accessFor: (run, host, phase) => {
    if (!run.githubRepository) return undefined;
    const target = `Repository: ${run.githubRepository} (base branch ${run.githubExpectedBase ?? 'the repository default'}).`;
    if (materialHosts.has(host)) return `${target} This transport has no repository access: work only from what this packet provides, including any read-only material.`;
    if (!githubWorkforce.configured) return `${target} Panter's GitHub tools are not configured: use only what this packet provides.`;
    const claim = 'There is no local checkout. Use the Panter GitHub tools, passing workId, attemptId and leaseGeneration from your claim. Read with panter_github_read (e.g. "contents/<path>?ref=<branch or sha>", "compare/<base>...<sha>", or "grant" to see what this work may do).';
    const automatic = autoGithubGrants && (phase !== 'IMPLEMENT' || run.permission === 'WRITE_APPROVED');
    // Without an automatic grant the leader may still grant this work by hand: the worker checks its real grant.
    if (!automatic) return `${target} ${claim} Panter did not grant GitHub access automatically for this work: first read "grant"; use the tools only as that grant allows, and if there is none, use only what this packet provides.`;
    if (phase === 'IMPLEMENT') return `${target} ${claim} Write with panter_github_commit: it commits to this work's own new branch, only inside the allowed edit surfaces. Then open the pull request against the base with panter_github_open_pr; if repository policy prevents it, leave the branch and say so. Report the exact commit SHA as candidateSha.`;
    const comment = (phase === 'VERIFY' || phase === 'REVIEW' || phase === 'JUDGMENT') && run.githubPrNumber ? ` You may comment on PR #${run.githubPrNumber} with panter_github_comment.` : '';
    return `${target} ${claim} This phase is read-only on GitHub.${comment}`;
  },
  writerHosts: () => githubWorkforce.writerHosts(),
  remoteAttestation: () => rddTransportAttestation,
  pickupClockStart: (work, limitMs) => pickupClockStart(mesh, grokRoutineWake, work, limitMs),
  pickupTimeoutMs: host => (pickupPerHost.get(host) ?? (materialHosts.has(host) ? pickupMailSeconds : pickupSeconds)) * 1000,
  abandoned: async ({ workId }) => { if (githubWorkforce.configured) await githubWorkforce.revoke(leaderHost(), workId); },
});
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
  try{await (await memoryFor(run.project)).save(leaderHost(),{title:`ODD ${run.id}`,type:'architecture',topicKey:`odd/${run.id}/tasks`,content:body});
    return 'ENGRAM_SAVED';}catch{return 'ENGRAM_UNAVAILABLE';}
}

const principalContext = new AsyncLocalStorage<string>();
/** Re-validates the current request's bearer later in the same request (revocation while in flight). */
const credentialRecheck = new AsyncLocalStorage<() => Promise<boolean>>();
const peerTokens: Record<string,string> = authMode === 'dev-static' ? JSON.parse(process.env.PANTER_PEER_TOKENS ?? '{}') : {};
for(const [host,secret] of Object.entries(peerTokens)){if(!isHost(host)||typeof secret!=='string'||secret.length<24||secret===token)throw new Error('Invalid PANTER_PEER_TOKENS');}
if(new Set(Object.values(peerTokens)).size!==Object.keys(peerTokens).length)throw new Error('Peer tokens must be unique');
function principal(){return principalContext.getStore()??'unknown'}
function hostPrincipal(){const p=principal();if(!isHost(p))throw new Error('Peer identity required');return p}
function requireLeader(){if(principal()!==leaderHost())throw new Error(`${leaderLabel()} required`)}
const ownerTrustedHosts = parseOwnerTrustedHosts(process.env.PANTER_OWNER_TRUSTED_HOSTS);
function requireAdmin(){if(!isAdminPrincipal(principal(),ownerTrustedHosts))throw new Error('Admin token required')}
const missionStatus = z.enum(['DRAFT', 'READY', 'RUNNING', 'VERIFYING', 'DONE', 'BLOCKED']);
const bounded = (max = 2048) => z.string().trim().min(1).max(max);

function connectionContract(actor:string):string{
  if(!isHost(actor))return '';
  const leader=actor===leaderHost();
  return buildConnectionContract(actor,leader,mesh.profileSnapshot(actor),leader?hostRequest(leaderPolicyProfile()):undefined);
}
// Per-role tools/list (routers plus each role's workflow tools); PANTER_TOOL_SURFACE=all lists every tool again.
const toolSurfaceAll = process.env.PANTER_TOOL_SURFACE === 'all';
if (!['all', 'role', undefined, ''].includes(process.env.PANTER_TOOL_SURFACE)) throw new Error('Invalid PANTER_TOOL_SURFACE (role or all)');
function surfaceRole(): SurfaceRole { const p = principal(); return !isHost(p) ? 'operator' : p === leaderHost() ? 'leader' : 'worker'; }
// Version from package.json and the exact release commit (REVISION, written by deploy/deploy.sh) for /health.
const packageVersion: string = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
const releaseRevision: string | null = await readFile(new URL('../REVISION', import.meta.url), 'utf8')
  .then(x => /^[0-9a-f]{7,64}$/.test(x.trim()) ? x.trim() : null).catch(() => null);
const handler = createMcpHandler(reqCtx => {
  const server = new McpServer({ name: 'panter-ai', version: packageVersion }, {
    capabilities: { resources: { subscribe: true }, events: {} } as any,
    instructions: `Panter-ai is a host-operated development harness with NO provider inference. ${leaderLabel()} is the coordinator. For a new user development request start with panter_harness_start (goal + permitted work and observed facts, NEVER ask the user to pick agents, roles, skills or review lenses). Then call panter_harness_tick and execute the returned phase automatically with host tools or native subagents; call panter_harness_report after observing actual results, and repeat until blocked by actual authorization/evidence or completed. The server automatically selects ODD discovery, planning, scoped implementation, independent verification and 4R by risk; Judgment Day only when explicitly requested. An initial Agent Studio preference may bind model/host but never requires per-task specialist selection. GPT_A_ONLY forbids remote delegation while preserving maximum requested model/effort, fast native worker processing, and maximum safe host-observed parallelism. If no remote peer is connected continue with ${leaderLabel()} native/inline. The host owns model selection and subagent execution; claims of model, effort, speed or children are REQUESTED, not verified. Do not misstate packet preparation as subagent execution. Panter-RDD is an independently implemented SHA-bound review gate, not the official Gentle AI Go controller; human delivery authorization remains separate. Do not merge or deploy without separately authorized tools and exact-candidate proof. Every Panter tool is also reachable through its domain router (panter_harness, panter_review, panter_mesh, panter_workforce, panter_github, panter_memory, panter_catalog, panter_admin): call it with operation "index" to see its operations. Tools not listed for your role are still callable, by name or through their router, with their usual authorization.`
      + connectionContract(principal()),

  });
  const surface = createToolSurface(server, { role: surfaceRole, listAll: toolSurfaceAll });

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
    description:`${leaderLabel()} loads compact, project-scoped Engram recovery context. Historical observations are not current instructions.`,
    inputSchema:z.object({project:bounded(100).optional(),maxBytes:z.number().int().min(512).max(16384).default(8192)}),annotations:{readOnlyHint:true},
  }, async ({project,maxBytes}) => execute(async () => {
    requireLeader();return (await memoryFor(project)).context(hostPrincipal(), maxBytes);
  }));
  server.registerTool('panter_memory_search', {
    description:`${leaderLabel()} searches curated Engram project memory; no all-project or private/personal memory access.`,
    inputSchema:z.object({project:bounded(100).optional(),query:bounded(500),limit:z.number().int().min(1).max(20).default(8)}),annotations:{readOnlyHint:true},
  }, async ({project,query,limit}) => execute(async () => {
    requireLeader();return (await memoryFor(project)).search(hostPrincipal(),query,limit);
  }));
  server.registerTool('panter_memory_save', {
    description:`${leaderLabel()} saves one verified, durable engineering decision/discovery to upstream Engram with a canonical topic key. Do not save secrets or unverified worker reports.`,
    inputSchema:z.object({project:bounded(100).optional(),title:bounded(160),type:memoryTypes,topicKey:bounded(160),content:bounded(16000)}),
  }, async item => execute(async () => {
    requireLeader();const {project,...save}=item;
    return (await memoryFor(project)).save(hostPrincipal(),save);
  }));
  // Native, actor-scoped MCP Events wire; requires a client supporting events.
  registerWorkforceEventWire(server,workforceEvents,hostPrincipal,mesh,
    ()=>(credentialRecheck.getStore()??(async()=>true))());

  // Worker learning/proposals stay in panter_mesh_message until GPT-A
  // independently verifies them and chooses to save them in Engram.

  const hostEnum = z.enum(HOSTS);
  const roleEnum = z.enum(['orchestrator','explorer','architect','implementer','verifier','reviewer']);
  server.registerTool('panter_mesh_profile_set',{description:`${leaderLabel()} configures a host agent profile. Model, effort and executionRequest (service tier, stream, parallel tool calls, native subagents) are frozen into each delegated work as REQUESTED_UNVERIFIED requirements the worker must apply and report; Panter cannot enforce them.`,inputSchema:z.object({host:hostEnum,actorId:bounded(160),modelRequest:z.string().regex(MODEL_REQUEST_PATTERN),effortRequest:z.string().regex(EFFORT_REQUEST_PATTERN),roles:z.array(roleEnum).min(1),coordinationMode:z.enum(['AUTO','GPT_A_ONLY']).optional(),preferNativeSubagents:z.boolean().optional(),maxRequestedNativeWorkers:z.number().int().min(0).max(32).optional(),scheduledPickupEnabled:z.boolean().optional(),scheduledPollIntervalSeconds:z.number().int().min(3600).max(86400).optional(),executionRequest:z.object({serviceTier:z.string().regex(/^[a-z][a-z0-9_-]{1,31}$/).optional(),stream:z.boolean().optional(),parallelToolCalls:z.boolean().optional(),maxNativeSubagents:z.number().int().min(0).max(32).optional()}).strict().optional(),expectedRevision:z.number().int().nonnegative()})},async x=>execute(()=>mesh.setProfile(hostPrincipal(),x,x.expectedRevision)));
  server.registerTool('panter_mesh_profiles',{description:'List configured host profiles.',inputSchema:z.object({}),annotations:{readOnlyHint:true}},async()=>execute(()=>mesh.profiles()));
  const githubOps = z.array(z.enum(GITHUB_WRITE_OPS)).max(4);
  const githubGrantInput = z.object({repository:bounded(201),ops:githubOps.default([]),branch:bounded(200).optional(),base:bounded(200).optional(),
    numbers:z.array(z.number().int().positive()).max(20).optional(),paths:z.array(bounded(400)).min(1).max(100).optional()}).strict();
  server.registerTool('panter_mesh_delegate',{description:`${leaderLabel()} creates actor-bound A2A work for one configured host. Optional github attaches a work-scoped GitHub grant (see panter_github_grant).`,inputSchema:z.object({missionId:bounded(120),target:hostEnum,role:roleEnum,instruction:bounded(20000),idempotencyKey:bounded(160),github:githubGrantInput.optional()})},async x=>execute(async()=>{
    const {github,...input}=x;
    if(github)githubWorkforce.validateGrant(github); // fail before creating the work
    const work=await mesh.delegate(hostPrincipal(),input);
    if(!github)return work;
    return {...work,github:await githubWorkforce.grant(hostPrincipal(),{workId:work.id,...github})};
  }));
  // ---- GitHub for the workforce (operator token held by Panter; narrow, work-scoped, audited) ----
  server.registerTool('panter_github_grant',{description:`${leaderLabel()} lets the worker of one delegated work use GitHub in ONE repository: always read; plus the listed write operations. commit = commits to a NEW branch Panter creates for this work (under panter/, default panter/<host>-<work8>; never an existing, default or protected branch; never CI, CODEOWNERS or git config files; never forced); pr = open a pull request from that branch; comment = comment on the listed numbers and on issues/PRs this work opens (no bot/slash commands); issue = open issues. There is NO merge, approve, delete, label, release or settings operation. Note: pushing a branch runs the repository's existing CI on the worker's code. The grant dies with the work's lease.`,
    inputSchema:z.object({workId:z.uuid()}).extend(githubGrantInput.shape).strict()},async x=>execute(()=>githubWorkforce.grant(hostPrincipal(),x)));
  server.registerTool('panter_github_revoke',{description:`${leaderLabel()} revokes a work's GitHub grant.`,inputSchema:z.object({workId:z.uuid()}).strict()},
    async x=>execute(()=>githubWorkforce.revoke(hostPrincipal(),x.workId)));
  server.registerTool('panter_github_audit',{description:`${leaderLabel()} reads GitHub workforce configuration, grants and the audit of every worker GitHub action.`,inputSchema:z.object({workId:z.uuid().optional()}).strict(),annotations:{readOnlyHint:true}},
    async x=>execute(async()=>({...githubWorkforce.describe(),...githubWorkforce.audit(hostPrincipal(),x.workId)})));
  const githubClaim = {workId:z.uuid(),attemptId:z.uuid(),leaseGeneration:z.number().int().positive()};
  server.registerTool('panter_github_read',{description:'Worker: read GitHub for your claimed work, in the repository the leader granted. path is relative to repos/{owner}/{repo}/ (e.g. "contents/src/app.ts?ref=main", "pulls/12", "pulls/12/files", "issues?state=open", "commits?sha=main", "compare/main...my-branch"). path "grant" shows your grant. File contents come back decoded as text. Secrets, keys, hooks and admin paths are not readable.',
    inputSchema:z.object({...githubClaim,path:bounded(500)}).strict(),annotations:{readOnlyHint:true}},
    async x=>execute(()=>githubWorkforce.read(hostPrincipal(),x,x.path)));
  server.registerTool('panter_github_commit',{description:'Worker (grant op "commit"): commit up to 50 text files (create/update with content, or delete:true) to YOUR work branch in one commit. The branch is created from the base on first use. Never the default branch, never .github/workflows, never forced.',
    inputSchema:z.object({...githubClaim,message:bounded(5000),files:z.array(z.object({path:bounded(400),content:z.string().max(1_000_000).optional(),delete:z.literal(true).optional()}).strict()).min(1).max(50)}).strict()},
    async x=>execute(()=>githubWorkforce.commit(hostPrincipal(),x,x.message,x.files)));
  server.registerTool('panter_github_open_pr',{description:'Worker (grant op "pr"): open a pull request from YOUR work branch to the granted base (default branch if none). Returns the existing PR if one is open. Merging and approving stay with the leader and the reviewer account.',
    inputSchema:z.object({...githubClaim,title:bounded(250),body:z.string().max(60000).default(''),draft:z.boolean().default(false)}).strict()},
    async x=>execute(()=>githubWorkforce.openPr(hostPrincipal(),x,x.title,x.body,x.draft)));
  server.registerTool('panter_github_comment',{description:'Worker (grant op "comment"): comment on an issue or pull request of the granted repository.',
    inputSchema:z.object({...githubClaim,number:z.number().int().positive(),body:bounded(20000)}).strict()},
    async x=>execute(()=>githubWorkforce.comment(hostPrincipal(),x,x.number,x.body)));
  server.registerTool('panter_github_create_issue',{description:'Worker (grant op "issue"): open an issue in the granted repository.',
    inputSchema:z.object({...githubClaim,title:bounded(250),body:z.string().max(60000).default('')}).strict()},
    async x=>execute(()=>githubWorkforce.issue(hostPrincipal(),x,x.title,x.body)));
  server.registerTool('panter_mesh_delegate_auto',{
    description:`${leaderLabel()} routes to the least-loaded recently authenticated standing peer with the requested role; returns LOCAL_FALLBACK_REQUIRED when no live peer is evidenced. Does not prove cold-start wake.`,
    inputSchema:z.object({missionId:bounded(120),role:roleEnum,instruction:bounded(20000),idempotencyKey:bounded(160)}).strict(),
  },async x=>execute(async()=>{
    const caller=hostPrincipal();
    const direct=await mesh.delegateAuto(caller,x);
    if(direct.status!=='LOCAL_FALLBACK_REQUIRED'||
       direct.reason!=='NO_FRESH_STANDBY_PEER'||x.role==='implementer')return direct;
    // A real connected live waiter takes priority. Without one, use only
    // native host Routines that have been explicitly configured by operator.
    // All remote wake is fail-closed, pointer-only, read-only.
    const profiles=await mesh.profiles();
    // The live MCP waiter already took precedence. Compatible subscribers
    // can receive webhook pointers but do not prove an idle chat woke.
    for(const host of appEventHosts()){
      if(!workforceEvents.hasActive(host)||!profiles.some(p=>p.host===host&&p.roles.includes(x.role)))continue;
      try {
        const work=await mesh.delegate(caller,{...x,target:host,wakeOnly:true});
        return {status:'DELEGATED' as const,selectedHost:host,work,
          selectionEvidence:'ACTIVE_MCP_EVENT_SUBSCRIPTION' as const,
          autonomousWakeVerified:false as const};
      } catch(error) {
        if(!(error instanceof Error&&error.message==='MCP event peer busy'))throw error;
      }
    }
    for(const host of (['grok','claude'] as const).filter(h=>h!==leaderHost())){
      const available=host==='grok'?grokRoutineWake.configured:claudeRoutineWake.configured;
      if(!available||!profiles.some(p=>p.host===host&&p.roles.includes(x.role)))continue;
      let work:Awaited<ReturnType<typeof mesh.delegate>>;
      try{work=await mesh.delegate(caller,{...x,target:host,wakeOnly:true});}
      catch(error){
        if(error instanceof Error&&error.message===
           (host==='grok'?'Grok wake peer busy':'Claude wake peer busy'))continue;
        throw error;
      }
      if(host==='grok'){
        const reserved=await mesh.reserveGrokWake(caller,work.id);
        if(reserved.send){
          const response=await grokRoutineWake.dispatch(work.id);
          await mesh.finishGrokWake(caller,work.id,response.accepted,response.statusCode);
        }
        return {status:'DELEGATED' as const,selectedHost:'grok' as const,
          work,selectionEvidence:'CONFIGURED_GROK_ROUTINE_WEBHOOK' as const,
          wake:await mesh.grokWakeStatus(caller,work.id),
          autonomousWakeVerified:false as const};
      }
      const reserved=await mesh.reserveClaudeWake(caller,work.id);
      if(reserved.send){
        const response=await claudeRoutineWake.dispatch(work.id);
        await mesh.finishClaudeWake(caller,work.id,response.accepted,
          response.statusCode,response.sessionId);
      }
      return {status:'DELEGATED' as const,selectedHost:'claude' as const,
        work,selectionEvidence:'CONFIGURED_CLAUDE_ROUTINE_API' as const,
        wake:await mesh.claudeWakeStatus(caller,work.id),
        autonomousWakeVerified:false as const};
    }
    return mesh.delegateScheduled(caller,x);
  }));
  server.registerTool('panter_workforce_event_status',{
    description:`${leaderLabel()} reads redacted event subscription and delivery counts; HTTP acceptance does not prove worker execution.`,
    inputSchema:z.object({}).strict(),annotations:{readOnlyHint:true}
  },async()=>execute(async()=>workforceEvents.status(hostPrincipal())));
  server.registerTool('panter_workforce_grok_wake_status',{
    description:`${leaderLabel()} reads redacted durable Grok webhook attempt for an own work ID. Accepted HTTP is not evidence the worker ran.`,
    inputSchema:z.object({workId:z.uuid()}).strict(),annotations:{readOnlyHint:true}
  },async x=>execute(()=>mesh.grokWakeStatus(hostPrincipal(),x.workId)));
  server.registerTool('panter_workforce_claude_wake_status',{
    description:`${leaderLabel()} reads durable Claude Code Routine fire state and redacted session ID. HTTP accepted does not prove task execution.`,
    inputSchema:z.object({workId:z.uuid()}).strict(),annotations:{readOnlyHint:true}
  },async x=>execute(()=>mesh.claudeWakeStatus(hostPrincipal(),x.workId)));
  server.registerTool('panter_mesh_pending',{description:'Return pointers to work assigned to authenticated host.',inputSchema:z.object({}),annotations:{readOnlyHint:true}},async()=>execute(()=>mesh.pending(hostPrincipal())));
  // An authenticated worker may check ONLY its own oldest queued pointer.
  // Self-reported wake routes are never promoted to verified autonomous delivery.
  server.registerTool('panter_workforce_app_turn',{
    description:'Native ChatGPT or Gemini app, not Codex CLI, Gemini CLI or ChatGPT Work: authenticate using existing per-account MCP OAuth connection; receive one actor-owned task with fenced execution identity. No provider APIs or server-side model inference. Cannot initiate a model turn in an inactive chat.',
    inputSchema:z.object({leaseSeconds:z.number().int().min(30).max(3600).default(900)}).strict()
  },async x=>execute(()=>appWorkforceTurn(mesh,hostPrincipal(),
    reqCtx.era==='modern'?'2026-07-28':'2025-11-25',x.leaseSeconds)));
  server.registerTool('panter_workforce_schedule_pickup',{
    description:`For a host-owned recurring Task or Skill: authenticate the scheduled MCP poll and claim at most one actor-owned non-writer task. Requires ${leaderLabel()} scheduled-worker opt-in. The server never starts the host, and self-reported mode does not prove autonomous wake.`,
    inputSchema:z.object({
      intervalSeconds:z.number().int().min(3600).max(86400).default(3600),
      leaseSeconds:z.number().int().min(30).max(3600).default(300),
    }).strict(),
  },async x=>execute(async()=>{
    const actor=hostPrincipal();
    if(actor===leaderHost())throw Error('Only workers may run host schedules');
    const profile=(await mesh.profiles()).find(p=>p.host===actor);
    if(profile?.scheduledPickupEnabled!==true||
       profile.scheduledPollIntervalSeconds!==x.intervalSeconds)
      throw Error('Scheduled pickup is not configured for this authenticated actor');
    const poll=await mesh.workforcePoll(actor,{
      protocolEra:reqCtx.era==='modern'?'2026-07-28':'2025-11-25',
      deliveryMode:'SCHEDULED_POLL',pollIntervalSeconds:x.intervalSeconds
    });
    if(!poll.next)return {status:'EMPTY' as const,
      delivery:'AUTHENTICATED_SCHEDULE_POLL' as const,autonomousWakeVerified:false as const};
    const claim=await mesh.pickup(actor,x.leaseSeconds,true);
    return {...claim,delivery:'AUTHENTICATED_SCHEDULE_POLL' as const,
      autonomousWakeVerified:false as const};
  }));
  server.registerTool('panter_workforce_next',{
    description:'Actor-bound next QUEUED candidate pointer; claim revalidates authorization. Updates observed MCP presence but never wakes or grants execution.',
    inputSchema:z.object({
      protocolEra:z.enum(['2026-07-28','2025-11-25','UNKNOWN']),
      deliveryMode:z.enum(['DELIVERY_ONLY','TASKS_2026','TASKS_2025','TASK_BRIDGE_2025','LONG_POLL','EXTERNAL_WAKE','SCHEDULED_POLL']),
      pollIntervalSeconds:z.number().int().min(60).max(86400).optional(),
    }).strict(),
  },async x=>execute(()=>mesh.workforcePoll(hostPrincipal(),x)));
  // Negotiated 2025/2026 era comes from SDK connection, not a worker claim.
  // Native tasks/get/cancel and legacy list/result operate over existing
  // durable listener handles; native Tasks *creation* remains unsupported.
  registerTaskWire(server,mesh,hostPrincipal,reqCtx.era);
  server.registerTool('panter_workforce_listen',{
    description:'Authenticated live MCP listen request (0–3600s) with server-observed protocol era. Resumes a connected host when a work pointer arrives; not cold-start.',
    inputSchema:z.object({waitSeconds:z.number().int().min(0).max(3600).default(300)}).strict()
  },async (x,ctx)=>execute(async()=>withListenHint(await workforceLongPoll.wait(hostPrincipal(),
    reqCtx.era==='modern'?'2026-07-28':'2025-11-25',
    x.waitSeconds*1000,ctx.mcpReq.signal),null,'panter_workforce_listen')));
  // Actor-bound, single-process long-poll fallback: one bounded waiter per worker.
  // Not a provider wake and not the MCP Tasks 2026 extension.
  server.registerTool('panter_workforce_wait',{
    description:'Authenticated worker holds a live MCP wait up to 3600s for its own QUEUED candidate. No claim/wake authority; requires a live host session.',
    inputSchema:z.object({
      protocolEra:z.enum(['2026-07-28','2025-11-25','UNKNOWN']),
      waitSeconds:z.number().int().min(0).max(3600).default(300),
    }).strict(),
  },async (x,ctx)=>execute(async()=>withListenHint(await workforceLongPoll.wait(hostPrincipal(), x.protocolEra, x.waitSeconds * 1000,ctx.mcpReq.signal),x.protocolEra)));
  server.registerTool('panter_workforce_status',{
    description:`${leaderLabel()} read-only four-worker presence, claims, receipts and unverified wake-route reports. No invented READY or wake proof.`,
    inputSchema:z.object({}),annotations:{readOnlyHint:true},
  },async()=>execute(()=>mesh.workforceStatus(hostPrincipal())));
  // Task schema bridge (NOT extension-native tasks/get): transport pointers only.
  // Client must re-arm after a terminal receipt; no server-side model execution.
  server.registerTool('panter_workforce_pickup',{
    description:'Standing worker claims its next QUEUED authorized work with a fenced attempt. No arbitrary work ID required.',
    inputSchema:z.object({leaseSeconds:z.number().int().min(30).max(3600).default(300)}).strict()
  },async x=>execute(()=>mesh.pickup(hostPrincipal(),x.leaseSeconds)));
  server.registerTool('panter_workforce_complete_and_rearm',{
    description:'Persist terminal result and receipt first, then arm the next schema bridge listener; failure is a durable rearm retry, never a work replay.',
    inputSchema:z.object({workId:z.uuid(),attemptId:z.uuid(),leaseGeneration:z.number().int().positive(),
      result:z.string().max(50000),success:z.boolean().default(true),
      protocolEra:z.enum(['2025-11-25','2026-07-28'])}).strict()
  },async x=>execute(()=>mesh.completeAndRearm(hostPrincipal(),x.workId,x.attemptId,
    x.leaseGeneration,x.result,x.success,x.protocolEra)));
  server.registerTool('panter_workforce_task_bridge',{
    description:'Compatibility task listener arm/get/cancel for authenticated host, backed by Mesh SQLite. This tool is not native MCP Tasks wire.',
    inputSchema:z.object({
      action:z.enum(['arm','get','cancel']),
      protocolEra:z.enum(['2025-11-25','2026-07-28']).optional(),
      taskId:z.string().uuid().optional(),
      ttlSeconds:z.number().int().min(60).max(86400).optional(),
    }).strict()
  },async x=>execute(async()=>{
    const actor=hostPrincipal();
    if(x.action==='arm'){
      if(!x.protocolEra||x.taskId)throw Error('Arm requires protocol era and no taskId');
      return mesh.taskBridgeArm(actor,x.protocolEra,x.ttlSeconds);
    }
    if(!x.taskId||x.protocolEra||x.ttlSeconds!==undefined)throw Error('Get/cancel require taskId only');
    return x.action==='get'?mesh.taskBridgeGet(actor,x.taskId):mesh.taskBridgeCancel(actor,x.taskId);
  }));
  server.registerTool('panter_workforce_rearm_status',{
    description:'Actor-visible pending and acknowledged terminal rearm intents. No credentials or result payloads.',
    inputSchema:z.object({}),annotations:{readOnlyHint:true}
  },async()=>execute(()=>mesh.rearmStatus(hostPrincipal())));
  server.registerTool('panter_workforce_result_get',{
    description:`${leaderLabel()} retrieves complete terminal result from authoritative backend, not worker chat output.`,
    inputSchema:z.object({workId:z.uuid()}).strict(),annotations:{readOnlyHint:true}
  },async x=>execute(()=>mesh.resultGet(hostPrincipal(),x.workId)));
  server.registerTool('panter_mesh_claim',{description:'Claim actor-owned work with a fenced attempt and obtain instructions.',inputSchema:z.object({workId:z.uuid(),leaseSeconds:z.number().int().min(30).max(3600).default(300)})},async x=>execute(()=>mesh.claim(hostPrincipal(),x.workId,x.leaseSeconds)));
  server.registerTool('panter_mesh_heartbeat',{description:'Renew exact worker lease.',inputSchema:z.object({workId:z.uuid(),attemptId:z.uuid(),leaseGeneration:z.number().int().positive(),leaseSeconds:z.number().int().min(30).max(3600).default(300)})},async x=>execute(()=>mesh.heartbeat(hostPrincipal(),x.workId,x.attemptId,x.leaseGeneration,x.leaseSeconds)));
  server.registerTool('panter_mesh_complete',{description:`Persist terminal result in backend, enqueue compact ${leaderLabel()} receipt, create durable rearm intent; return only compact ack.`,inputSchema:z.object({workId:z.uuid(),attemptId:z.uuid(),leaseGeneration:z.number().int().positive(),result:z.string().max(50000),success:z.boolean().default(true)})},async x=>execute(()=>mesh.complete(hostPrincipal(),x.workId,x.attemptId,x.leaseGeneration,x.result,x.success)));
  server.registerTool('panter_mesh_message',{description:`Send actor-bound A2A question, answer or progress update to collaborator or ${leaderLabel()}.`,inputSchema:z.object({missionId:bounded(120),to:hostEnum,workId:z.uuid(),kind:z.enum(['QUESTION','ANSWER','UPDATE']),text:bounded(10000)})},async x=>execute(()=>mesh.message(hostPrincipal(),x)));
  // Compact receipts for routine GPT-A orchestration: full result is fetched explicitly.
  server.registerTool('panter_workforce_receipts',{
    description:`Authenticated inbox with compact terminal receipt pointers. ${leaderLabel()} retrieves full result only when necessary.`,
    inputSchema:z.object({since:z.number().int().nonnegative().default(0)}),annotations:{readOnlyHint:true}
  },async x=>execute(()=>mesh.inbox(hostPrincipal(),x.since)));
  // Compatibility for preexisting connected clients that expect terminal RESULT text.
  // Workers still receive compact ACK on complete; only GPT-A can dereference results.
  server.registerTool('panter_mesh_inbox',{
    description:`Legacy actor inbox. ${leaderLabel()} RESULT messages include text for existing clients; use panter_workforce_receipts for compact operation.`,
    inputSchema:z.object({since:z.number().int().nonnegative().default(0)}),annotations:{readOnlyHint:true}
  },async x=>execute(async()=>{
    const actor=hostPrincipal(),inbox=await mesh.inbox(actor,x.since);
    if(actor!==leaderHost())return inbox;
    const messages=await Promise.all(inbox.messages.map(async m=>{
      if(m.kind!=='RESULT'||!m.workId)return m;
      const full=await mesh.resultGet(leaderHost(),m.workId);
      return {...m,text:full.result??m.text};
    }));
    return {...inbox,messages};
  }));

  // The catalog is centrally stored in MCP: hosts receive only a frozen,
  // relevant packet after assignment. Skills do not grant execution rights.
  server.registerTool('panter_gentle_catalog',{
    description:`List all ten Gentle Shell specialist definitions, thirteen MCP-hosted skills, 4R lenses and Judgment Day agents; only ${leaderLabel()} configures them.`,
    inputSchema:z.object({}),annotations:{readOnlyHint:true}
  },async()=>execute(async()=>{requireLeader();return {...gentleCatalog(),leaderHost:leaderHost()}}));

  server.registerTool('panter_gentle_orchestrator_read',{
    description:`${leaderLabel()} lazily reads one pinned ODD orchestration section from the upstream Gentle Shell assets; Pi-specific mechanisms are reference only.`,
    inputSchema:z.object({section:z.enum(GENTLE_ORCHESTRATOR_SECTIONS)}),annotations:{readOnlyHint:true}
  },async ({section})=>execute(async()=>{requireLeader();return readOrchestratorSection(section)}));
  server.registerTool('panter_gentle_agent_read',{
    description:`${leaderLabel()} reads one allowlisted, version-pinned upstream agent definition.`,
    inputSchema:z.object({id:z.enum(GENTLE_AGENTS.map(a=>a.id) as [string,...string[]])}),annotations:{readOnlyHint:true}
  },async ({id})=>execute(async()=>{requireLeader();return readAgent(id)}));
  server.registerTool('panter_gentle_skill_read',{
    description:`${leaderLabel()} reads one MCP-hosted skill; worker packets contain only assigned skills.`,
    inputSchema:z.object({id:z.enum(GENTLE_SKILLS.map(s=>s.id) as [string,...string[]])}),annotations:{readOnlyHint:true}
  },async ({id})=>execute(async()=>{requireLeader();return readSkill(id)}));
  server.registerTool('panter_specialist_bind',{
    description:`${leaderLabel()} assigns an individual specialist to one authenticated host, requested model/effort and selected MCP skills. Separate from host credentials.`,
    inputSchema:z.object({agentId:z.enum(GENTLE_AGENTS.map(a=>a.id) as [string,...string[]]),host:hostEnum,
      modelRequest:z.string().regex(MODEL_REQUEST_PATTERN),effortRequest:z.string().regex(EFFORT_REQUEST_PATTERN),skillIds:z.array(z.enum(GENTLE_SKILLS.map(s=>s.id) as [string,...string[]])).max(8),expectedRevision:z.number().int().nonnegative()})
  },async ({expectedRevision,...input})=>execute(()=>mesh.bindSpecialist(hostPrincipal(),input,expectedRevision)));
  server.registerTool('panter_specialist_assignments',{
    description:'Read individual specialist assignments (distinct from five host connection profiles).',
    inputSchema:z.object({}),annotations:{readOnlyHint:true}
  },async()=>execute(async()=>{requireLeader();return mesh.specialistBindings()}));
  server.registerTool('panter_specialist_delegate',{
    description:`${leaderLabel()} dispatches a centrally versioned agent + assigned skills as a frozen A2A task to its configured host; result returns to ${leaderLabel()} inbox.`,
    inputSchema:z.object({missionId:bounded(120),agentId:z.enum(GENTLE_AGENTS.map(a=>a.id) as [string,...string[]]),objective:bounded(6000),idempotencyKey:bounded(160),candidateSha:z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/).optional(),allowedEditSurfaces:z.array(z.string().min(1).max(256)).max(16).optional()})
  },async input=>execute(()=>mesh.delegateBoundSpecialist(hostPrincipal(),input)));

  server.registerTool('panter_mesh_uncertain_writers',{
    description:'OPERATOR ONLY: list uncertain and lease-expired implementer attempts with their exact fencing IDs and edit surfaces; does not kill or reconcile external workers.',
    inputSchema:z.object({}),annotations:{readOnlyHint:true}
  },async()=>execute(async()=>{requireAdmin();return mesh.uncertainWriters()}));
  server.registerTool('panter_mesh_reconcile_writer',{
    description:'OPERATOR ONLY: reconcile an expired A2A implementer after inspecting its actual workspace. No automatic retry of uncertain writes. The original attempt ID and lease generation must match.',
    inputSchema:z.object({workId:z.uuid(),attemptId:z.uuid(),leaseGeneration:z.number().int().positive(),
      resolution:z.enum(['CONFIRMED_COMPLETE','CONFIRMED_NO_EFFECTS']),
      evidence:z.string().trim().min(32).max(2000),
      isolationEvidence:z.string().trim().min(40).max(2000).optional(),
      result:z.object({summary:bounded(10000),evidence:z.array(bounded(1000)).min(1).max(40),
        candidateSha:z.string().regex(/^[a-f0-9]{40}$/),runId:bounded(160)}).optional()})
  },async x=>execute(async()=>{requireAdmin();return mesh.reconcileWriter(x)}));
  server.registerTool('panter_odd_route',{
    description:`${leaderLabel()} applies the Gentle Shell ODD small/inline vs exploratory/coordinated and risk-based verification rules; planning-only.`,
    inputSchema:z.object({requirementsClear:z.boolean(),resumableFromDiff:z.boolean(),risk:z.enum(['low','high']),unknownCodeArea:z.boolean(),independentWorkUnits:z.number().int().min(0).max(32),writesAuthorized:z.boolean()}),
    annotations:{readOnlyHint:true}
  },async input=>execute(async()=>{requireLeader();return routeFlow(input)}));
  server.registerTool('panter_review_start',{
    description:`${leaderLabel()} atomically delegates 4R four independent lenses or exactly two blind Judgment Day judges to their configured hosts using one frozen candidate SHA. No automatic approval or fix.`,
    inputSchema:z.object({missionId:bounded(120),kind:z.enum(['4r','judgment-day']),objective:bounded(6000),candidateSha:z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/),idempotencyKey:bounded(160)})
  },async input=>execute(()=>mesh.startReview(hostPrincipal(),input)));
  server.registerTool('panter_review_status',{
    description:`Read durable 4R / Judgment Day receipts for a review session. When complete, ${leaderLabel()} must independently assess outputs; this is not native provider approval.`,
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
    description:`${leaderLabel()} creates a durable engineering mission for ODD fallback. Does not authorize filesystem writes.`,
    inputSchema:z.object({project:bounded(100),goal:bounded(4000)})
  },async x=>execute(async()=>{requireLeader();return store.createMission(x.project,x.goal)}));
  server.registerTool('panter_native_flow_start',{
    description:`${leaderLabel()} records the verbatim request, risk, authorizations and review requirement to recover ODD across sessions.`,
    inputSchema:z.object({missionId:z.uuid(),spec:bounded(30000),signals:flowSignals,reviewRequired:z.boolean().default(false)})
  },async x=>execute(async()=>{requireLeader();return agents.createFlow(x.missionId,x.spec,x.signals,x.reviewRequired)}));
  server.registerTool('panter_native_phase_enqueue',{
    description:`${leaderLabel()} records a durable scout/designer/builder phase for inline or genuine native-subagent execution; never self-registers as an independent reviewer.`,
    inputSchema:z.object({flowId:z.uuid(),role:z.enum(['scout','designer','builder']),objective:bounded(10000),
      scopes:z.array(bounded(256)).max(32).default([]),workspace:bounded(100).default('default'),dependsOn:z.array(z.uuid()).max(32).default([]),idempotencyKey:bounded(160)})
  },async x=>execute(async()=>{requireLeader();if(x.role==='builder')throw new Error('Legacy native builders require the operator-granted automatic harness');return agents.addTask({...x,target:leaderHost()})}));
  server.registerTool('panter_native_phase_claim',{
    description:`${leaderLabel()} claims the next dependency-ready native phase. This is a durable lease, NOT proof of model invocation.`,
    inputSchema:z.object({leaseSeconds:z.number().int().min(30).max(3600).default(300)})
  },async ({leaseSeconds})=>execute(async()=>{requireLeader();return agents.claim(leaderHost(),leaderHost(),leaseSeconds)}));
  server.registerTool('panter_native_phase_packet',{
    description:`${leaderLabel()} reads the exact ODD requirement and handoff of a recorded phase. Use panter_native_packet for agent+skill instructions.`,
    inputSchema:z.object({taskId:z.uuid()}),annotations:{readOnlyHint:true}
  },async ({taskId})=>execute(async()=>{requireLeader();const task=await agents.getTask(taskId);if(task?.target!==leaderHost())throw new Error(`Not ${leaderLabel()} native phase`);return agents.packet(taskId)}));
  server.registerTool('panter_native_phase_complete',{
    description:`${leaderLabel()} records a claimed inline/native-subagent phase result and its host-reported evidence. Independent verification is never inferred.`,
    inputSchema:z.object({taskId:z.uuid(),leaseGeneration:z.number().int().positive(),result:z.object({summary:bounded(10000),evidence:z.array(bounded(1000)).max(40)}),success:z.boolean().default(true)})
  },async x=>execute(async()=>{requireLeader();const task=await agents.getTask(x.taskId);if(task?.target!==leaderHost()||!['scout','designer','builder'].includes(task.role))throw new Error(`Not a permitted ${leaderLabel()} native phase`);return agents.report(x.taskId,leaderHost(),x.leaseGeneration,x.result,x.success)}));
  server.registerTool('panter_native_flow_status',{
    description:`Recover a durable ${leaderLabel()} ODD flow and its native-phase evidence after context loss or disconnection.`,
    inputSchema:z.object({flowId:z.uuid()}),annotations:{readOnlyHint:true}
  },async ({flowId})=>execute(async()=>{requireLeader();return agents.summary(flowId)}));
  server.registerTool('panter_native_candidate_freeze',{
    description:`${leaderLabel()} records the candidate commit SHA for subsequent independent verification; a SHA string is not independently verified.`,
    inputSchema:z.object({flowId:z.uuid(),candidateSha:z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/),expectedRevision:z.number().int().positive()})
  },async x=>execute(async()=>{requireLeader();return agents.freezeCandidate(x.flowId,x.candidateSha,x.expectedRevision)}));
  server.registerTool('panter_native_flow_close',{
    description:`Close a completed ${leaderLabel()} ODD flow only if the stored verification/review gates allow it. High-risk flows cannot self-approve.`,
    inputSchema:z.object({flowId:z.uuid(),expectedRevision:z.number().int().positive()})
  },async x=>execute(async()=>{requireLeader();return agents.closeFlow(x.flowId,x.expectedRevision)}));

  // Organic harness: one user objective, automatic role/skill/risk routing, durable phase recovery.
  // There is no agent picker in this surface; GPT-A supplies observations, not selections.
  const harnessRuntimeSchema=z.object({nativeSubagents:z.boolean(),maxParallelSubagents:z.number().int().min(0).max(32),
    toolsAvailable:z.boolean(),peerStates:z.partialRecord(z.enum(HOSTS),z.enum(['CONNECTED','UNAVAILABLE','UNKNOWN'])).optional()});
  if(embedded){
    server.registerTool('panter_oauth_clients',{
      description:'Admin-only: list OAuth embedded client registrations and approved hosts without exposing any credentials.',
      inputSchema:z.object({}),annotations:{readOnlyHint:true}
    },async()=>execute(async()=>{requireAdmin();return embedded.listClients()}));
    server.registerTool('panter_oauth_client_revoke',{
      description:'Admin-only: permanently revoke all active OAuth embedded grants, tokens, codes and pending consent requests for one client ID.',
      inputSchema:z.object({clientId:z.string().regex(/^pc_[A-Za-z0-9_-]{24,64}$/)})
    },async x=>execute(async()=>{requireAdmin();
      const hosts=await embedded.clientHosts(x.clientId);
      // A revoked connection must stop receiving work events immediately, not at subscription expiry.
      // Drop before revoking (a crash in between leaves a still-valid client, which can resubscribe) and
      // again after, so a subscribe verified across the revoke is refused by the epoch check.
      let dropped=workforceEvents.dropOwners(hosts);
      const revokedGrants=await embedded.revokeClient(x.clientId);
      dropped+=workforceEvents.dropOwners(hosts);
      return {revokedGrants,droppedEventSubscriptions:dropped,
        hostsToResubscribe:hosts,
        note:hosts.length?'Event subscriptions are per host: any other live connection of these hosts must subscribe again.':undefined};}));
  }
  server.registerTool('panter_harness_write_grant',{
    description:`Admin-only explicit bounded write authorization for a particular project/objective; ${leaderLabel()} cannot issue its own permission.`,
    inputSchema:z.object({project:bounded(100),objective:bounded(6000),allowedPaths:z.array(bounded(256)).min(1).max(16),ttlSeconds:z.number().int().min(60).max(86400)})
  },async x=>execute(async()=>{requireAdmin();return harness.grantWrite(x)}));
  server.registerTool('panter_harness_start',{ 
    description:`Automatically classify an engineering objective and persist ODD phases. ${leaderLabel()} does NOT select agents/skills; no inference or edits run on the MCP.`,
    inputSchema:z.object({project:bounded(100),githubRepository:z.string().max(120).optional(),githubPrNumber:z.number().int().positive().optional(),githubExpectedBase:z.string().max(100).optional(),objective:bounded(6000),idempotencyKey:bounded(160),writesAuthorized:z.boolean(),writeGrantId:z.uuid().optional(),
      changeSurfaces:z.array(z.string().min(1).max(256)).max(16).optional(),
      judgmentDayRequested:z.boolean().optional(),
      observations:z.object({requirementsClear:z.boolean().optional(),resumableFromDiff:z.boolean().optional(),
        unknownCodeArea:z.boolean().optional(),independentWorkUnits:z.number().int().min(0).max(32).optional()}).optional(),
      capabilities:harnessRuntimeSchema.optional()})
  },async x=>execute(async()=>{requireLeader();const profile=(await mesh.profiles()).find(p=>p.host===leaderHost());
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
    description:`${leaderLabel()} attaches a verified, previously authorized existing/created PR to an automatic ODD run. Metadata only: no GitHub writes, no agent selection, no approval.`,
    inputSchema:z.object({runId:z.uuid(),repository:bounded(120),prNumber:z.number().int().positive(),
      expectedBase:z.string().max(100).optional(),expectedRevision:z.number().int().positive()})
  },async x=>execute(async()=>{requireLeader();return harness.bindGithub(x.runId,{repository:x.repository,
    prNumber:x.prNumber,expectedBase:x.expectedBase},x.expectedRevision)}));
  server.registerTool('panter_harness_correction_report',{
    description:`${leaderLabel()} registers an authorized bounded correction with a fresh real Git SHA. Automatically resets verifier, 4R and Judgment Day, and invalidates old review evidence.`,
    inputSchema:z.object({runId:z.uuid(),expectedRevision:z.number().int().positive(),report:z.object({candidateSha:z.string().regex(/^[a-f0-9]{40}$/),runId:bounded(160),evidence:z.array(bounded(1000)).min(1).max(30)})})
  },async x=>execute(async()=>{requireLeader();return harness.recordCorrection(x.runId,x.report,x.expectedRevision)}));
  server.registerTool('panter_harness_units_set',{
    description:`${leaderLabel()} automatically decomposes completed design into disjoint, scoped implementation units. Requires actual separate host worktrees for parallel writers.`,
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
    description:`${leaderLabel()} inspects and refreshes the self-hosted Panter-RDD review for a harness run. Reviewer output cannot grant GitHub delivery permission.`,
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
    description:`${leaderLabel()} persists user choice AUTO or GPT_A_ONLY. Solo mode refuses remote delegation while requesting maximum native model, effort, speed and parallelism.`,
    inputSchema:z.object({coordinationMode:z.enum(['AUTO','GPT_A_ONLY']),expectedRevision:z.number().int().nonnegative()})
  },async x=>execute(async()=>{requireLeader();return mesh.setCoordinationMode(leaderHost(),x.coordinationMode,x.expectedRevision)}));

  server.registerTool('panter_native_plan',{ 
    description:`${leaderLabel()} requests maximum model/effort, fast native subagents and maximum safe parallelism even when working alone. GPT_A_ONLY forbids remote delegation regardless of peer availability. Reports capability gaps; does not launch models.`,
    inputSchema:z.object({signals:z.object({requirementsClear:z.boolean(),resumableFromDiff:z.boolean(),risk:z.enum(['low','high']),unknownCodeArea:z.boolean(),independentWorkUnits:z.number().int().min(0).max(32),writesAuthorized:z.boolean()}), assignments:z.array(nativeAssignmentSchema).min(1).max(32),peerStates:z.partialRecord(z.enum(HOSTS),z.enum(['CONNECTED','UNAVAILABLE','UNKNOWN'])).optional(),coordinationMode:z.enum(['AUTO','GPT_A_ONLY']).optional(),capabilities:z.object({nativeSubagents:z.boolean(),maxParallelSubagents:z.number().int().min(0).max(32),toolsAvailable:z.boolean(),observedModel:z.string().max(120).optional(),observedReasoningEffort:z.string().max(32).optional(),observedWorkerProcessing:z.string().max(32).optional()})}),annotations:{readOnlyHint:true}
  },async x=>execute(async()=>{requireLeader();const owner=(await mesh.profiles()).find(p=>p.host===leaderHost());const requested=owner?.maxRequestedNativeWorkers??32;const enabled=owner?.preferNativeSubagents!==false;return planHostNative({signals:x.signals,assignments:x.assignments,bindings:await mesh.specialistBindings(),peerStates:x.peerStates??{},coordinationMode:x.coordinationMode??owner?.coordinationMode??'AUTO',requestedNativeWorkers:enabled?requested:0,capabilities:{...x.capabilities,nativeSubagents:x.capabilities.nativeSubagents&&enabled,evidence:'HOST_REPORTED_UNVERIFIED'}})}));
  server.registerTool('panter_native_packet',{
    description:`${leaderLabel()} loads a pinned specialist + MCP-hosted skills for inline/direct or truly available native-subagent execution. Does not require a remote host.`,inputSchema:nativeAssignmentSchema.extend({skillIds:z.array(z.enum(GENTLE_SKILLS.map(s=>s.id) as [string,...string[]])).max(8).optional(),modelRequest:z.string().max(120).optional(),effortRequest:z.string().max(32).optional()}),annotations:{readOnlyHint:true}
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
    description:`${leaderLabel()} prepares four independent 4R slots or two blind Judgment Day slots, with versioned MCP skills and frozen candidate SHA. Works in GPT_A_ONLY without any remote workers.`,
    inputSchema:z.object({missionId:bounded(120),kind:z.enum(['4r','judgment-day']),objective:bounded(6000),candidateSha:z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/),idempotencyKey:bounded(160)})
  },async x=>execute(async()=>{requireLeader();return nativeSubagentReview.create(x)}));
  server.registerTool('panter_native_review_packet',{
    description:'Retrieve exactly one frozen reviewer/skill packet. Blind Judge A/B never see each other outputs; no model is started by the MCP.',
    inputSchema:z.object({reviewId:z.uuid(),slotId:z.uuid()}),annotations:{readOnlyHint:true}
  },async x=>execute(async()=>{requireLeader();return nativeSubagentReview.packet(x.reviewId,x.slotId)}));
  server.registerTool('panter_native_review_batch',{
    description:`Automatically selects native subagent 4R/Judgment Day packets when supported. With zero native slots, returns exactly one sequential ${leaderLabel()} SOLO 4R lens at a time; use panter_native_review_submit_solo. Solo reports are never independent or RDD-approved. Judgment Day requires real separate judges.`,
    inputSchema:z.object({reviewId:z.uuid(),observedNativeParallelism:z.number().int().min(0).max(32)}),annotations:{readOnlyHint:true}
  },async x=>execute(async()=>{requireLeader();return nativeSubagentReview.batch(x.reviewId,x.observedNativeParallelism)}));
  server.registerTool('panter_native_review_submit',{
    description:'Record one host-reported native subagent run and structured SHA/packet-bound evidence. Immutable and idempotent; cannot grant RDD approval.',
    inputSchema:z.object({reviewId:z.uuid(),slotId:z.uuid(),report:z.object({agentId:bounded(100),candidateSha:z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/),packetDigest:z.string().regex(/^[0-9a-f]{64}$/),subagentRunId:bounded(160),evidence:z.array(bounded(1000)).min(1).max(40),findings:z.array(z.object({id:bounded(100),location:bounded(400),severity:z.enum(['BLOCKER','CRITICAL','WARNING','SUGGESTION']),claim:bounded(2000),proofRefs:z.array(bounded(600)).min(1).max(12)})).max(80),attestation:z.object({keyId:bounded(80),signature:bounded(160)}).optional()})})
  },async x=>execute(async()=>{requireLeader();return nativeSubagentReview.submit(x.reviewId,x.slotId,x.report)}));
  server.registerTool('panter_native_review_submit_solo',{
    description:`Record one ${leaderLabel()} self-reviewed 4R lens when native subagents are unavailable. Explicitly UNVERIFIED: never independently attested or Panter-RDD-approved.`,
    inputSchema:z.object({reviewId:z.uuid(),slotId:z.uuid(),report:z.object({
      agentId:bounded(100),candidateSha:z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/),
      packetDigest:z.string().regex(/^[a-f0-9]{64}$/),
      evidence:z.array(bounded(1000)).min(1).max(40),
      findings:z.array(z.object({id:bounded(100),location:bounded(400),
        severity:z.enum(['BLOCKER','CRITICAL','WARNING','SUGGESTION']),
        claim:bounded(2000),proofRefs:z.array(bounded(600)).min(1).max(12)})).max(80)})})
  },async x=>execute(async()=>{requireLeader();return nativeSubagentReview.submitSolo(x.reviewId,x.slotId,x.report)}));
  server.registerTool('panter_native_review_progress',{
    description:`Recover native 4R/JD and ${leaderLabel()} solo four-lens progress, severe findings and explicit unverified/independent status. Never marks review officially approved.`,
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
    description: `${leaderLabel()} configures five hosts plus all Gentle Shell specialist agents, requested models and centrally hosted skills. Only ${leaderLabel()} saves settings.`,
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
  surface.finalize();
  return server;
});

// Reconcile only real queued work pointers with subscribed event receivers.
// The event payload cannot authorize writes or expose instructions.
const reconcileEvents=()=>{
  void reconcileWorkforceEventOutbox(appEventHosts(),
    host=>mesh.pending(host),workforceEvents)
    .then(({enqueueFailures})=>{
      if(enqueueFailures)console.error('MCP event outbox enqueue deferred');
    }).catch(()=>console.error('MCP event outbox reconciliation failed'));
};
for(const host of appEventHosts())mesh.events.on(host,reconcileEvents);
const eventRetry=setInterval(reconcileEvents,30_000);
if(geminiMailWake.configured){
  const mailGemini=()=>void geminiMailWake.dispatchDue().then(({sent,failed})=>{
    if(sent.length)console.error(`Gemini mail wake sent for ${sent.length} work item(s)`);
    if(failed.length)console.error(`Gemini mail wake deferred for ${failed.length} work item(s)`);
  }).catch(()=>console.error('Gemini mail wake dispatch failed'));
  // Give an open Gemini chat a moment to take new work before waking an idle one by e-mail.
  mesh.events.on('gemini',()=>{const t=setTimeout(mailGemini,25_000);t.unref();});
  setInterval(mailGemini,30_000).unref();
}
eventRetry.unref();
reconcileEvents();

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
// Unauthenticated relay endpoints: a small per-client budget (the real relay sends a few per task).
const mailRelayHits = new Map<string, number[]>();
function mailRelayRate(client: string): boolean {
  const now = Date.now();
  const recent = (mailRelayHits.get(client) ?? []).filter(t => now - t < 60_000);
  if (recent.length >= 30) { mailRelayHits.set(client, recent); return false; }
  recent.push(now); mailRelayHits.delete(client); mailRelayHits.set(client, recent);
  // Evict the least recently seen clients (Map keeps insertion order) instead of resetting everyone.
  for (const key of mailRelayHits.keys()) { if (mailRelayHits.size <= 10_000) break; mailRelayHits.delete(key); }
  return true;
}
let mailRelayKeyWarnAt = 0;
async function handleMailRelay(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let bodyRead = false;
  const reply = (status: number, body: unknown) => {
    if (res.headersSent) return;
    // Refused before reading the body: close, so Node does not keep draining an unwanted upload.
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...(bodyRead ? {} : { connection: 'close' }) });
    res.end(JSON.stringify(body));
  };
  const host = hostname(req.headers.host);
  if (!host || !(allowedHosts.length ? allowedHosts.includes(host) : ['localhost','127.0.0.1','::1'].includes(host))) { reply(403, { ok: false }); return; }
  if (!geminiMailWake.configured) { reply(404, { ok: false, error: 'disabled' }); return; }
  // Only the relay holding the shared key gets through; junk traffic is bounded per client and never read.
  if (!geminiMailWake.relayAuthorized(req.headers['x-panter-relay-key'])) {
    let client: string;
    try { client = rateLimitIdentity(clientAddresses.identify(req)); } catch { reply(400, { ok: false, error: 'invalid_client' }); return; }
    if (!mailRelayRate(client)) { reply(429, { ok: false, error: 'rate_limited' }); return; }
    if (Date.now() - mailRelayKeyWarnAt > 60_000) {
      mailRelayKeyWarnAt = Date.now();
      console.warn('Gemini mail relay: refused a request without a valid x-panter-relay-key (check RELAY_SECRET on the Worker)');
    }
    reply(401, { ok: false, error: 'relay_key_required' }); return;
  }
  const chunks: Buffer[] = []; let size = 0;
  try {
    for await (const chunk of req) { size += (chunk as Buffer).length; if (size > 450_000) { reply(413, { ok: false }); return; } chunks.push(chunk as Buffer); }
  } catch { reply(400, { ok: false, error: 'aborted' }); return; } // client hung up mid-body
  bodyRead = true;
  let payload: unknown;
  try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { reply(400, { ok: false, error: 'invalid_json' }); return; }
  try {
    reply(200, req.url === '/a2a/gemini/email-validate'
      ? geminiMailWake.validateEnvelope((payload as { envelope?: unknown })?.envelope)
      : await geminiMailWake.acceptResult(payload));
  } catch (error) {
    reply(error instanceof MailError ? error.status : 500, { ok: false, error: error instanceof Error ? error.message : 'error' });
  }
}
const http = createServer(async (req, res) => {
  if (req.url === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ status: 'ok', name: 'panter-ai', version: packageVersion, revision: releaseRevision }));
    return;
  }
  if (oauth && req.method === 'GET' && (req.url === '/.well-known/oauth-protected-resource' || req.url === '/.well-known/oauth-protected-resource/mcp')) {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(oauth.protectedResourceMetadata())); return;
  }
  if (req.method === 'POST' && (req.url === '/a2a/gemini/email-validate' || req.url === '/a2a/gemini/email-result')) {
    // Never let a relay request reject unhandled: Node would terminate the whole MCP server.
    await handleMailRelay(req, res).catch(() => { if (!res.headersSent) { res.writeHead(500); res.end(); } else res.destroy(); });
    return;
  }
  if (embedded && req.url !== '/mcp') {
    const host = hostname(req.headers.host);
    if (!host || !(allowedHosts.length ? allowedHosts.includes(host) : ['localhost','127.0.0.1','::1'].includes(host))) { res.writeHead(403); res.end(); return; }
    if (await embedded.handle(req, res)) return;
  }
  if (req.url !== '/mcp') { res.writeHead(404); res.end('Not found'); return; }
  const h = hostname(req.headers.host);
  // No HTTP proxy can turn this public TCP listener into an administrator.
  if (!h || !(allowedHosts.length ? allowedHosts.includes(h) : ['localhost', '127.0.0.1', '::1'].includes(h))) {
    res.writeHead(403); res.end('Host not allowed'); return;
  }
  if (req.headers.origin && !allowedOrigins.includes(req.headers.origin)) {
    res.writeHead(403); res.end('Origin not allowed'); return;
  }
  const peer=Object.entries(peerTokens).find(([,v])=>staticBearerMatch(req.headers.authorization,v))?.[0];
  let actor: string | undefined;
  if (embedded) {
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
  const authorization=req.headers.authorization;
  const recheck=async()=>{
    try{
      if(embedded)return (await embedded.authenticate(authorization))===actor;
      if(oauth)return oauth.verifyBearer(authorization)===actor;
      return true;
    }catch{return false;}
  };
  try { await credentialRecheck.run(recheck,()=>principalContext.run(actor!,()=>nodeHandler(req, res))); }
  catch (error) {
    console.error('MCP request failed:', error instanceof Error ? error.message : 'error');
    if (!res.headersSent) res.writeHead(500);
    if (!res.writableEnded) res.end('Internal error');
  }
});
// Separate Unix-domain listener. Never share it through nginx, cloudflared,
// Docker port publishing, or a public reverse proxy. The operator must control
// BOTH the filesystem ACL and its distinct bearer credential.
if(adminSocketPath){
  await mkdir(dirname(adminSocketPath),{recursive:true,mode:0o700});
  const parent=await lstat(dirname(adminSocketPath));
  if(!parent.isDirectory()||(process.getuid&&parent.uid!==process.getuid())||
     (parent.mode&0o077)!==0)
    throw new Error('Operator socket parent directory must be owner-controlled mode 0700');

  // Crash recovery: remove only a same-owner STALE socket after a kernel-level
  // connection attempt confirms ECONNREFUSED. Never unlink a live listener.
  try{
    const previous=await lstat(adminSocketPath);
    if(!previous.isSocket()||(process.getuid&&previous.uid!==process.getuid()))
      throw new Error('Operator socket path is not a socket owned by this service');
    await new Promise<void>((ok,fail)=>{
      const candidate=connectUnix({path:adminSocketPath});
      candidate.setTimeout(1500,()=>{candidate.destroy();fail(new Error('Operator socket ownership probe timed out'));});
      candidate.once('connect',()=>{candidate.destroy();fail(new Error('An operator listener is already active'));});
      candidate.once('error',(e:NodeJS.ErrnoException)=>{
        if(e.code==='ECONNREFUSED')ok();else fail(e);
      });
    });
    const unchanged=await lstat(adminSocketPath);
    if(!unchanged.isSocket()||unchanged.ino!==previous.ino||unchanged.dev!==previous.dev)
      throw new Error('Operator socket changed during stale-file probe');
    await unlink(adminSocketPath);
  }catch(e){if(!(e instanceof Error&&'code' in e&&e.code==='ENOENT'))throw e;}
  const adminServer=createServer(async(req,res)=>{
    if(req.url!=='/mcp'||!['POST','GET','DELETE'].includes(req.method??'')){
      res.writeHead(404);res.end();return;
    }
    if(req.headers.origin||req.headers['x-forwarded-for']||req.headers['x-forwarded-host']||
       !staticBearerMatch(req.headers.authorization,operatorToken)){
      res.writeHead(401,{'cache-control':'no-store'});res.end('Unauthorized');return;
    }
    res.setHeader('Cache-Control','no-store');
    try{await principalContext.run('admin',()=>nodeHandler(req,res));}
    catch(error){console.error('Operator MCP error:',error instanceof Error?error.message:'error');
      if(!res.headersSent)res.writeHead(500);
      if(!res.writableEnded)res.end('Internal error');}
  });
  // Keep the socket owner-only from the instant it becomes visible.
  const mask=process.umask(0o077);
  try{
    await new Promise<void>((ok,fail)=>{
      adminServer.once('error',fail);
      adminServer.listen(adminSocketPath,()=>{adminServer.removeListener('error',fail);ok();});
    });
  }finally{process.umask(mask);}
  await chmod(adminSocketPath,0o600);
  console.error('Panter operator Unix socket ready (private filesystem channel)');
}
http.listen(port, bind, () => console.error(`Panter-ai MCP ready on ${bind}:${port}/mcp`));
