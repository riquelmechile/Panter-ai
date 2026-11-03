import { leaderHost, leaderLabel, isWorker } from './leadership.js';
import { SqliteLedger } from './sqlite-ledger.js';
import { summarizeWorkforce, validateRouteReport, type WorkerHost, type WorkerObservation, type WorkerRouteReport } from './workforce-readiness.js';
/** Original, provider-independent collaboration ledger for authenticated MCP hosts. */
import { createHash, randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { EventEmitter } from 'node:events';
import { agentDefinition, checkSkills, specialistPacket, REVIEW_4R, JUDGMENT_DAY, type GentleSkillId } from './gentle-catalog.js';

export const HOSTS = ['gpt-a', 'gpt-b', 'grok', 'gemini', 'claude'] as const;
export type Host = typeof HOSTS[number];
export type MeshRole = 'orchestrator' | 'explorer' | 'architect' | 'implementer' | 'verifier' | 'reviewer';
export type MeshWorkState = 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'WAITING_INPUT' | 'OUTCOME_UNKNOWN' | 'ABORTED_NO_EFFECTS';
export type ActorProfile = { host: Host; actorId: string; modelRequest: string; effortRequest: string; roles: MeshRole[]; revision: number; preferNativeSubagents?: boolean; maxRequestedNativeWorkers?: number; coordinationMode?: 'AUTO' | 'GPT_A_ONLY'; scheduledPickupEnabled?:boolean; scheduledPollIntervalSeconds?:number };
export type MeshMessage = { id: string; missionId: string; from: Host; to: Host; workId: string | null; kind: 'QUESTION' | 'ANSWER' | 'UPDATE' | 'RESULT'; text: string; createdAt: string; inboxRevision: number };
export type MeshWork = { id: string; missionId: string; from: Host; target: Host; role: MeshRole; instruction: string; idempotencyKey: string; specialist?: {agentId:string;skillIds:string[];packetDigest:string;assetDigests:Record<string,string>;modelRequest:string;effortRequest:string;bindingRevision:number;candidateSha?:string;allowedEditSurfaces:string[]}; state: MeshWorkState; attemptId: string | null; leaseGeneration: number; leaseUntil: string | null; result: string | null; receiptDigest: string | null; createdAt: string; completedAt: string | null; reconciliation?: {resolution:'CONFIRMED_COMPLETE'|'CONFIRMED_NO_EFFECTS';evidence:string;at:string} };
export type SpecialistBinding = {agentId:string;host:Host;modelRequest:string;effortRequest:string;skillIds:GentleSkillId[];revision:number};
export type ReviewSession = {id:string;missionId:string;kind:'4r'|'judgment-day';objective:string;candidateSha:string;idempotencyKey:string;workIds:string[];createdAt:string};
export type WorkforceTaskBridge = {taskId:string;host:WorkerHost;protocolEra:'2025-11-25'|'2026-07-28';status:'ARMED'|'DELIVERED'|'CANCELLED'|'EXPIRED';createdAt:string;expiresAt:string;workId:string|null};
export type WorkforceRearmIntent = {workId:string;host:WorkerHost;status:'PENDING'|'ACKED';createdAt:string;acknowledgedAt?:string};
export type GrokWakeAttempt = {workId:string;state:'RESERVED'|'SIGNAL_ACCEPTED'|'SIGNAL_FAILED';reservedAt:string;statusCode:number|null;claimedAt?:string};
export type ClaudeWakeAttempt = GrokWakeAttempt & {sessionId:string|null};
type MeshData = { version: 1; profiles: ActorProfile[]; specialistBindings?: SpecialistBinding[]; reviews?:ReviewSession[]; workforce?: Partial<Record<WorkerHost, WorkerObservation>>; taskBridges?: WorkforceTaskBridge[]; rearmIntents?: WorkforceRearmIntent[]; grokWakeAttempts?: GrokWakeAttempt[]; claudeWakeAttempts?: ClaudeWakeAttempt[]; works: MeshWork[]; messages: MeshMessage[]; inboxRevision: Record<Host, number> };
const hosts = new Set<string>(HOSTS);
const roles = new Set<MeshRole>(['orchestrator', 'explorer', 'architect', 'implementer', 'verifier', 'reviewer']);
export function isHost(x: string): x is Host { return hosts.has(x); }
function check(condition: unknown, reason: string): asserts condition { if (!condition) throw new Error(reason); }
function sha(value: string) { return createHash('sha256').update(value).digest('hex'); }
function iso() { return new Date().toISOString(); }
function activeBindings(d: MeshData) { return (d.specialistBindings ?? []).filter(b => b.host !== leaderHost()); }

export class MeshEngine {
  private readonly sqlite: SqliteLedger;
  private state: MeshData = { version: 1, profiles: [], specialistBindings: [], reviews:[], works: [], messages: [], inboxRevision: { 'gpt-a': 0, 'gpt-b': 0, 'grok': 0, 'gemini': 0, 'claude': 0 } };
  private chain: Promise<unknown> = Promise.resolve();
  /** Emitted only AFTER the updated ledger is atomically persisted. */
  readonly events = new EventEmitter();
  private writeGuard:((missionId:string,paths:string[])=>Promise<void>)|null=null;
  /** Ephemeral process-local proof: durable route reports alone cannot prove wake. */
  private standingListenerCheck:((host:WorkerHost)=>boolean)|null=null;
  setStandingListenerCheck(check:(host:WorkerHost)=>boolean){this.standingListenerCheck=check;}
  setWriteGuard(guard:(missionId:string,paths:string[])=>Promise<void>){this.writeGuard=guard;}
  private constructor(dir: string) { this.sqlite = SqliteLedger.open(dir); }
  static async open(dir: string) {
    const x = new MeshEngine(dir);
    const parsed = x.sqlite.read('mesh', x.state);
    check(parsed.version === 1 && Array.isArray(parsed.works) && Array.isArray(parsed.profiles) && Array.isArray(parsed.messages), 'Invalid mesh ledger');
    for (const host of HOSTS) check(Number.isSafeInteger(parsed.inboxRevision[host]) && parsed.inboxRevision[host] >= 0, 'Invalid inbox revision');
    const before = JSON.stringify(parsed);
    const normalize = (data: MeshData) => {
      const historical: Record<Host, number> = { 'gpt-a': 0, 'gpt-b': 0, 'grok': 0, 'gemini': 0, 'claude': 0 };
      for (const m of data.messages) {
        check(isHost(m.to) && isHost(m.from), 'Invalid message actor');
        historical[m.to]++;
        if (!Number.isSafeInteger(m.inboxRevision) || m.inboxRevision <= 0) m.inboxRevision = historical[m.to];
        historical[m.to] = Math.max(historical[m.to], m.inboxRevision);
      }
      for (const host of HOSTS) data.inboxRevision[host] = Math.max(data.inboxRevision[host], historical[host]);
      if (data.specialistBindings !== undefined) check(Array.isArray(data.specialistBindings), 'Invalid specialist binding ledger');
      data.specialistBindings ??= [];
      data.reviews ??= [];
      data.workforce ??= {};
      data.taskBridges ??= [];
      data.rearmIntents ??= [];
      data.grokWakeAttempts ??= [];
      data.claudeWakeAttempts ??= [];
      // Leader switch: the leader profile is orchestrator-only and no worker keeps the orchestrator role.
      for (const p of data.profiles) {
        if (p.host === leaderHost()) { if (p.roles.join() !== 'orchestrator') p.roles = ['orchestrator']; }
        else if (p.roles.includes('orchestrator')) p.roles = p.roles.filter(r => r !== 'orchestrator');
      }
    };
    normalize(parsed);
    // Persist upgrades inside a transaction; subsequent reads cannot lose historical cursors.
    x.state = JSON.stringify(parsed) === before ? parsed
      : x.sqlite.mutate('mesh', x.state, data => normalize(data)).after;
    return x;
  }

  private async write<T>(fn: (d: MeshData) => T): Promise<T> {
    const p = this.chain.then(() => {
      const { before, after, result } = this.sqlite.mutate('mesh', this.state, fn);
      const changed = HOSTS.filter(host => after.inboxRevision[host] !== before.inboxRevision[host]);
      this.state = after;
      if (changed.length > 0) this.events.emit('changed');
      for (const host of changed) this.events.emit(host, after.inboxRevision[host]);
      return result;
    });
    this.chain = p.then(() => {}, () => {});
    return p;
  }
  private async read<T>(fn: (d: MeshData) => T): Promise<T> {
    await this.chain;
    this.state = this.sqlite.read('mesh', this.state);
    return structuredClone(fn(this.state));
  }

  private notify(d: MeshData, host: Host) { d.inboxRevision[host] = (d.inboxRevision[host] ?? 0) + 1; return d.inboxRevision[host]; }

  async setProfile(caller: Host, profile: Omit<ActorProfile, 'revision'>, expectedRevision: number) {
    check(caller === leaderHost(), 'Only orchestrator configures agents');
    check(isHost(profile.host), 'Unrecognized host');
    check(profile.actorId.trim().length >= 3 && profile.actorId.length <= 160, 'Invalid actor');
    check(profile.modelRequest.length <= 120 && profile.effortRequest.length <= 32, 'Invalid model request');
    check(profile.roles.length > 0 && profile.roles.every(r => roles.has(r)), 'Invalid roles');
    if(profile.preferNativeSubagents !== undefined) check(typeof profile.preferNativeSubagents==='boolean' && profile.host===leaderHost(), 'Native worker preferences are leader-only');
    if(profile.coordinationMode !== undefined) check(profile.host===leaderHost() && ['AUTO','GPT_A_ONLY'].includes(profile.coordinationMode), `Coordination mode is ${leaderLabel()}-only`);
    if(profile.maxRequestedNativeWorkers !== undefined) check(profile.host===leaderHost() && Number.isInteger(profile.maxRequestedNativeWorkers) && profile.maxRequestedNativeWorkers>=0 && profile.maxRequestedNativeWorkers<=32, 'Invalid native worker ceiling');
    if(profile.scheduledPickupEnabled!==undefined)
      check(profile.host!==leaderHost()&&typeof profile.scheduledPickupEnabled==='boolean','Scheduled pickup is worker-only');
    if(profile.scheduledPollIntervalSeconds!==undefined)
      check(profile.host!==leaderHost()&&Number.isInteger(profile.scheduledPollIntervalSeconds)&&
        profile.scheduledPollIntervalSeconds>=3600&&profile.scheduledPollIntervalSeconds<=86400,
        'Scheduled pickup interval must be 3600..86400 seconds');
    if(profile.scheduledPickupEnabled)
      check(profile.scheduledPollIntervalSeconds!==undefined,'Scheduled pickup interval required');
    check(profile.host !== leaderHost() || profile.roles.every(r => r === 'orchestrator'), `${leaderLabel()} is the coordinator`);
    check(profile.host === leaderHost() || !profile.roles.includes('orchestrator'), `Only ${leaderLabel()} is the coordinator`);
    return this.write(d => {
      const i = d.profiles.findIndex(p => p.host === profile.host);
      const before = d.profiles[i];
      check((before?.revision ?? 0) === expectedRevision, 'Stale profile revision');
      const next = { ...profile, roles: [...new Set(profile.roles)], revision: expectedRevision + 1 };
      if (i < 0) d.profiles.push(next); else d.profiles[i] = next;
      this.notify(d, profile.host);
      this.notify(d, leaderHost());
      return next;
    });
  }
  /** Persist the user's single-host choice without reopening Agent Studio. */
  setCoordinationMode(caller:Host, coordinationMode:'AUTO'|'GPT_A_ONLY', expectedRevision:number){
    check(caller===leaderHost(),`${leaderLabel()} alone may change coordination mode`);
    check(coordinationMode==='AUTO'||coordinationMode==='GPT_A_ONLY','Invalid coordination mode');
    return this.write(d=>{
      const before=d.profiles.find(p=>p.host===leaderHost());
      check((before?.revision??0)===expectedRevision,`Stale ${leaderLabel()} coordination revision`);
      const next:ActorProfile={...(before??{
        host:leaderHost(),actorId:`actor-${leaderHost()}`,modelRequest:leaderHost()==='gpt-a'?'gpt-6-astra':'host-default',effortRequest:'max',roles:['orchestrator'],
        preferNativeSubagents:true,maxRequestedNativeWorkers:32,revision:0
      }),roles:['orchestrator'],coordinationMode,revision:expectedRevision+1};
      if(before)d.profiles[d.profiles.indexOf(before)]=next;else d.profiles.push(next);
      this.notify(d,leaderHost());return next;
    });
  }
  profiles() { return this.read(d => d.profiles); }
  /** Authenticated worker poll; exposes a QUEUED candidate only. Claim may still reject expired authorization. */
  async workforcePoll(caller: Host, report: WorkerRouteReport) {
    check(caller !== leaderHost(), 'Only workers may poll');
    validateRouteReport(report);
    return this.write(d => {
      const registry = d.workforce ??= {};
      const presence = registry[caller as WorkerHost] ??= {};
      presence.lastPollAt = iso();
      presence.reportedRoute = { ...report };
      if(report.deliveryMode==='SCHEDULED_POLL'){
        presence.lastScheduledPollAt=presence.lastPollAt;
        presence.scheduledPollCount=Math.min(1_000_000,(presence.scheduledPollCount??0)+1);
        // The next actual host-owned schedule invocation acknowledges rearm.
        // Completion itself never claims a scheduled host will run again.
        for(const intent of d.rearmIntents??[])if(intent.host===caller&&intent.status==='PENDING'){
          intent.status='ACKED';intent.acknowledgedAt=presence.lastPollAt;
        }
      }
      const next = d.works.filter(w => w.target === caller && w.state === 'QUEUED')
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))[0];
      return {
        status: next ? 'CANDIDATE' as const : 'EMPTY' as const,
        next: next ? { workId: next.id, missionId: next.missionId, role: next.role } : null,
        presenceEvidence: 'AUTHENTICATED_MCP_CALL' as const,
        routeEvidence: 'REPORTED_UNVERIFIED' as const,
        autonomousWakeVerified: false as const,
      };
    });
  }
  async workforceStatus(caller: Host) {
    check(caller === leaderHost(), `Only ${leaderLabel()} may inspect Workforce`);
    return this.read(d => summarizeWorkforce(d.profiles, d.workforce ?? {}, d.works).map(view=>{
      const active=(d.taskBridges??[]).filter(t=>t.host===view.host&&
        (t.status==='ARMED'||t.status==='DELIVERED')&&Date.parse(t.expiresAt)>Date.now());
      const profile=d.profiles.find(p=>p.host===view.host);
      const observed=d.workforce?.[view.host];
      const lastScheduled=observed?.lastScheduledPollAt??null;
      const interval=profile?.scheduledPollIntervalSeconds??null;
      const due=lastScheduled&&interval?new Date(Date.parse(lastScheduled)+interval*1000).toISOString():null;
      return {...view,liveListenerObserved:this.standingListenerCheck?.(view.host)===true,
        scheduledPickup:{configured:profile?.scheduledPickupEnabled===true,
          pollIntervalSeconds:interval,lastObservedPollAt:lastScheduled,
          observedCallCount:observed?.scheduledPollCount??0,nextDueAt:due,
          overdue:!!(due&&Date.now()>Date.parse(due)+120_000),
          autonomousWakeVerified:false as const},
        bridgeListeners:active.map(t=>({taskId:t.taskId,status:t.status,
        protocolEra:t.protocolEra,expiresAt:t.expiresAt})),
        pendingRearmIntents:(d.rearmIntents??[]).filter(i=>i.host===view.host&&i.status==='PENDING').length};
    }));
  }
  /** Task bridge is a compat TOOL (not native tasks/get wire). No second work queue:
   * listener rows are actor-bound transport pointers to QUEUED Mesh work.
   */
  async taskBridgeArm(caller:Host, protocolEra:'2025-11-25'|'2026-07-28', ttlSeconds=3600) {
    check(caller!==leaderHost(),'Only workers may arm task bridge');
    check(['2025-11-25','2026-07-28'].includes(protocolEra),'Unsupported protocol era');
    check(Number.isInteger(ttlSeconds)&&ttlSeconds>=60&&ttlSeconds<=86400,'Invalid task bridge TTL');
    return this.write(d=>{
      const host=caller as WorkerHost;
      const entries=d.taskBridges??=[];
      const now=Date.now();
      for(const item of entries) if(item.host===host&&item.status==='ARMED'&&Date.parse(item.expiresAt)<=now)
        item.status='EXPIRED';
      let task=entries.find(item=>item.host===host&&item.protocolEra===protocolEra&&item.status==='ARMED');
      if(!task){
        const offered=d.works.filter(w=>w.target===host&&w.state==='QUEUED')
          .sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id))[0];
        task={taskId:randomUUID(),host,protocolEra,status:offered?'DELIVERED':'ARMED',
          createdAt:iso(),expiresAt:new Date(now+ttlSeconds*1000).toISOString(),workId:offered?.id??null};
        (d.taskBridges??=[]).push(task);
      }
      // A terminal result already committed before this transaction is never replayed:
      // ack a rearm intent ONLY after the replacement listener has been stored.
      for(const intent of d.rearmIntents??[]) if(intent.host===host&&intent.status==='PENDING'){
        intent.status='ACKED'; intent.acknowledgedAt=iso();
      }
      return {taskId:task.taskId,status:task.status,protocolEra:task.protocolEra,
        expiresAt:task.expiresAt,workId:task.workId,delivery:'SCHEMA_BRIDGE_ONLY' as const,
        autonomousWakeVerified:false as const};
    });
  }
  async taskBridgeGet(caller:Host,taskId:string){
    check(caller!==leaderHost(),'Only workers may retrieve task bridge');
    return this.read(d=>{
      const t=(d.taskBridges??[]).find(x=>x.taskId===taskId&&x.host===caller);
      check(t,'Task not found');
      const expired=Date.parse(t.expiresAt)<=Date.now();
      const consumed=t.status==='DELIVERED'&&
        !d.works.some(w=>w.id===t.workId&&w.target===caller&&w.state==='QUEUED');
      return {taskId:t.taskId,status:expired?'EXPIRED':consumed?'CONSUMED':t.status,
        protocolEra:t.protocolEra,workId:(expired||consumed)?null:t.workId,
        delivery:'SCHEMA_BRIDGE_ONLY' as const,autonomousWakeVerified:false as const};
    });
  }
  /** Read-only actor-scoped Task wire projection over existing bridge records.
   * This never allows an event or task ID to claim executable work.
   */
  async wireTaskGet(caller:Host,taskId:string,era:'2025-11-25'|'2026-07-28'){
    check(caller!==leaderHost(),'Only workers may inspect listener tasks');
    return this.read(d=>{
      const item=(d.taskBridges??[]).find(t=>t.taskId===taskId&&t.host===caller&&t.protocolEra===era);
      check(item,'Task not found');
      const expired=Date.parse(item.expiresAt)<=Date.now();
      const isQueued=item.status==='DELIVERED'&&d.works.some(w=>w.id===item.workId&&w.target===caller&&w.state==='QUEUED');
      const status:'failed'|'cancelled'|'completed'|'working'=expired||item.status==='EXPIRED'?'failed':item.status==='CANCELLED'?'cancelled':
        item.status==='DELIVERED'?'completed':'working';
      const createdAt=item.createdAt;
      const ttlMs=Math.max(0,Date.parse(item.expiresAt)-Date.parse(createdAt));
      return {taskId:item.taskId,status,createdAt,lastUpdatedAt:createdAt,
        ttlMs,pollIntervalMs:1000,workId:isQueued?item.workId:null};
    });
  }
  async wireTaskList(caller:Host,era:'2025-11-25'|'2026-07-28',cursor?:string){
    check(caller!==leaderHost(),'Only workers may inspect listener tasks');
    return this.read(d=>{
      const rows=(d.taskBridges??[]).filter(t=>t.host===caller&&t.protocolEra===era)
        .sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.taskId.localeCompare(b.taskId));
      const pos=cursor===undefined?0:rows.findIndex(t=>t.taskId===cursor)+1;
      check(cursor===undefined||pos>0,'Invalid task cursor');
      const page=rows.slice(pos,pos+25);
      return {taskIds:page.map(t=>t.taskId),nextCursor:rows.length>pos+25?page.at(-1)?.taskId:undefined};
    });
  }
  async taskBridgeCancel(caller:Host,taskId:string){
    check(caller!==leaderHost(),'Only workers may cancel task bridge');
    return this.write(d=>{
      const t=(d.taskBridges??[]).find(x=>x.taskId===taskId&&x.host===caller);
      check(t,'Task not found');
      // Cancellation only invalidates this listener; never cancels authoritative Work.
      if(t.status==='ARMED'||t.status==='DELIVERED')t.status='CANCELLED';
      return {taskId:t.taskId,status:t.status,workCancelled:false as const};
    });
  }
  async rearmStatus(caller:Host){
    return this.read(d=>(d.rearmIntents??[]).filter(i=>caller===leaderHost()||i.host===caller)
      .map(i=>({workId:i.workId,host:i.host,status:i.status,createdAt:i.createdAt,acknowledgedAt:i.acknowledgedAt??null})));
  }
  /** Full result stays in the durable Mesh ledger; GPT-A explicitly retrieves it.
   * No worker can read another actor's result via this tool.
   */
  async resultGet(caller:Host,workId:string){
    check(caller===leaderHost(),`Only ${leaderLabel()} may read Workforce results`);
    return this.read(d=>{
      const w=d.works.find(w=>w.id===workId);
      check(w&&['COMPLETED','FAILED'].includes(w.state),'Work result not found');
      return {workId:w.id,missionId:w.missionId,host:w.target,state:w.state,
        result:w.result,receiptDigest:w.receiptDigest,completedAt:w.completedAt};
    });
  }
  /** Bindings to the current leader are inactive: after a leader switch they must not
   * route remote work back to the orchestrator; callers fall back to native phases. */
  specialistBindings() { return this.read(d => activeBindings(d)); }
  /** GPT-A configures many specialist definitions independently of the five hosts. */
  bindSpecialist(caller:Host, input:{agentId:string;host:Host;modelRequest:string;effortRequest:string;skillIds:string[]}, expectedRevision:number) {
    check(caller===leaderHost(), `Only ${leaderLabel()} configures specialist bindings`);
    const definition=agentDefinition(input.agentId);
    check(definition, 'Unknown catalog agent');
    check(isHost(input.host) && input.host!==leaderHost(), 'Specialists require a worker host');
    check(input.modelRequest.length<=120 && input.effortRequest.length<=32, 'Invalid model configuration');
    check(Number.isSafeInteger(expectedRevision) && expectedRevision>=0,'Invalid binding revision');
    const skills=checkSkills(input.skillIds);
    return this.write(d=>{
      const bindings=d.specialistBindings ??= [];
      const i=bindings.findIndex(b=>b.agentId===input.agentId);
      check((bindings[i]?.revision??0)===expectedRevision,'Stale specialist binding revision');
      const next:SpecialistBinding={agentId:definition.id,host:input.host,modelRequest:input.modelRequest,effortRequest:input.effortRequest,skillIds:skills,revision:expectedRevision+1};
      if(i===-1)bindings.push(next);else bindings[i]=next;
      this.notify(d,leaderHost());
      return next;
    });
  }
  /** Assemble immutable role+skill packet from MCP-hosted catalog. The ledger
   * retains the exact packet; later skill updates cannot change in-flight work.
   */
  async delegateBoundSpecialist(caller:Host,input:{missionId:string;agentId:string;objective:string;idempotencyKey:string;candidateSha?:string;allowedEditSurfaces?:string[]}) {
    check(caller===leaderHost(),`Only ${leaderLabel()} can delegate`);
    const binding=await this.read(d=>activeBindings(d).find(b=>b.agentId===input.agentId)??null);
    check(binding,'Specialist must be configured in Agent Studio');
    const packet=await specialistPacket({agentId:binding.agentId,skillIds:binding.skillIds,objective:input.objective,modelRequest:binding.modelRequest,effortRequest:binding.effortRequest,candidateSha:input.candidateSha,allowedEditSurfaces:input.allowedEditSurfaces});
    return this.delegate(caller,{missionId:input.missionId,target:binding.host,role:packet.role,instruction:packet.instruction,idempotencyKey:input.idempotencyKey,
      specialist:{agentId:packet.agentId,skillIds:packet.skillIds,packetDigest:packet.digest,assetDigests:packet.assetDigests,modelRequest:binding.modelRequest,effortRequest:binding.effortRequest,bindingRevision:binding.revision,candidateSha:input.candidateSha,allowedEditSurfaces:packet.allowedEditSurfaces}});
  }
  async delegate(caller: Host, input: { missionId: string; target: Host; role: MeshRole; instruction: string; idempotencyKey: string; specialist?:NonNullable<MeshWork['specialist']>; wakeOnly?:boolean; scheduleOnly?:boolean }) {
    check(caller === leaderHost(), `Only ${leaderLabel()} can delegate`);
    check(input.missionId.length > 0 && input.missionId.length <= 120, 'Invalid mission');
    check(isHost(input.target) && input.target !== leaderHost(), 'Invalid target');
    check(roles.has(input.role) && input.role !== 'orchestrator', 'Invalid role');
    check(input.instruction.trim().length > 0 && input.instruction.length <= 50000, 'Invalid instruction');
    check(input.idempotencyKey.length > 0 && input.idempotencyKey.length <= 160, 'Invalid idempotency');
    if(input.role==='implementer'&&this.writeGuard)
      await this.writeGuard(input.missionId,input.specialist?.allowedEditSurfaces??[]);
    return this.write(d => {
      check(!d.profiles.some(p=>p.host===leaderHost()&&p.coordinationMode==='GPT_A_ONLY'),
        `GPT_A_ONLY forbids remote delegation; use native ${leaderLabel()} phases`);
      if (input.specialist) {
        const binding=activeBindings(d).find(b=>b.agentId===input.specialist?.agentId);
        check(binding?.host===input.target && binding.revision===input.specialist.bindingRevision, 'Specialist binding changed during dispatch');
        check(input.specialist.packetDigest===sha(input.instruction), 'Specialist packet digest mismatch');
      }
      const profile = d.profiles.find(p => p.host === input.target);
      check(profile?.roles.includes(input.role), 'Target agent role is not configured');
      // Idempotent retransmission does not create a second writer and must not
      // conflict with its own still-active reservation. Keep this check atomic.
      const dup = d.works.find(w => w.missionId === input.missionId && w.idempotencyKey === input.idempotencyKey);
      if (dup) {
        check(dup.target === input.target && dup.role === input.role && dup.instruction === input.instruction && JSON.stringify(dup.specialist??null)===JSON.stringify(input.specialist??null), 'Idempotency conflict');
        return dup;
      }
      if(input.scheduleOnly){
        const observation=d.workforce?.[input.target as WorkerHost];
        const interval=profile?.scheduledPollIntervalSeconds;
        const age=Date.now()-Date.parse(observation?.lastScheduledPollAt??'');
        check(input.role!=='implementer'&&profile?.scheduledPickupEnabled===true&&
          interval!==undefined&&observation?.reportedRoute?.deliveryMode==='SCHEDULED_POLL'&&
          observation.reportedRoute.pollIntervalSeconds===interval&&
          Number.isFinite(age)&&age>=0&&age<=2*interval*1000+120_000,
          'Scheduled worker has no recent authenticated scheduled pickup');
        check(!d.works.some(w=>w.target===input.target&&
          ['QUEUED','RUNNING','OUTCOME_UNKNOWN'].includes(w.state)),
          'Scheduled worker busy');
      }
      if(input.wakeOnly){
        check(isWorker(input.target) && input.role!=='implementer','External wake cannot authorize remote writes');
        check(!d.works.some(w=>w.target===input.target &&
          ['QUEUED','RUNNING','OUTCOME_UNKNOWN'].includes(w.state)),
          input.target==='grok'?'Grok wake peer busy':input.target==='claude'?'Claude wake peer busy':'MCP event peer busy');
      }
      if(input.specialist?.allowedEditSurfaces?.length){
        const conflict=d.works.find(w=>w.missionId===input.missionId && w.role==='implementer' && ['QUEUED','RUNNING','OUTCOME_UNKNOWN'].includes(w.state) && (w.specialist?.allowedEditSurfaces??[]).some(a=>input.specialist!.allowedEditSurfaces.some(b=>a===b || a.startsWith(b+'/') || b.startsWith(a+'/'))));
        check(!conflict,'Overlapping active writer edit surfaces');
      }
      const w: MeshWork = { id: randomUUID(), missionId: input.missionId, from: leaderHost(), target: input.target, role: input.role, instruction: input.instruction, idempotencyKey: input.idempotencyKey, specialist: input.specialist, state: 'QUEUED', attemptId: null, leaseGeneration: 0, leaseUntil: null, result: null, receiptDigest: null, createdAt: iso(), completedAt: null };
      d.works.push(w);
      // Bind the oldest active transport listener to the authoritative queued work.
      const bridge=(d.taskBridges??[]).find(t=>t.host===w.target&&t.status==='ARMED'&&Date.parse(t.expiresAt)>Date.now());
      if(bridge){bridge.status='DELIVERED';bridge.workId=w.id;}
      this.notify(d, input.target);
      this.notify(d, leaderHost());
      return w;
    });
  }

  /** Reserve one outbound doorbell after the authoritative work is committed.
   * A lost response is never blindly resent: RESERVED is an uncertain outcome.
   */
  async reserveGrokWake(caller:Host,workId:string){
    check(caller===leaderHost(),`Only ${leaderLabel()} may signal delegated work`);
    return this.write(d=>{
      const w=d.works.find(w=>w.id===workId&&w.target==='grok');
      check(w,'Grok work not found');
      const existing=(d.grokWakeAttempts??[]).find(a=>a.workId===workId);
      if(existing)return {send:false,attempt:existing};
      check(w.state==='QUEUED','Only queued Grok work can receive wake');
      const attempt:GrokWakeAttempt={workId,state:'RESERVED',reservedAt:iso(),statusCode:null};
      (d.grokWakeAttempts??=[]).push(attempt);
      this.notify(d,leaderHost());
      return {send:true,attempt};
    });
  }
  async finishGrokWake(caller:Host,workId:string,accepted:boolean,statusCode:number|null){
    check(caller===leaderHost(),`Only ${leaderLabel()} may record wake delivery`);
    return this.write(d=>{
      const attempt=(d.grokWakeAttempts??[]).find(a=>a.workId===workId);
      check(attempt,'Wake attempt not found');
      if(attempt.state!=='RESERVED')return attempt;
      attempt.state=accepted?'SIGNAL_ACCEPTED':'SIGNAL_FAILED';
      attempt.statusCode=statusCode;
      this.notify(d,leaderHost());
      return attempt;
    });
  }
  async grokWakeStatus(caller:Host,workId:string){
    check(caller===leaderHost(),`Only ${leaderLabel()} may inspect Grok wake attempts`);
    return this.read(d=>{
      const w=d.works.find(w=>w.id===workId&&w.target==='grok');
      check(w,'Grok work not found');
      const a=(d.grokWakeAttempts??[]).find(x=>x.workId===workId);
      return {workId,state:a?.state??'DELIVERY_ONLY',statusCode:a?.statusCode??null,
        wakeObserved:a?.state==='SIGNAL_ACCEPTED'&&Boolean(a.claimedAt),
        claimedAt:a?.claimedAt??null};
    });
  }

  /** Queue work for host-native scheduled Tasks (Gemini, GPT-B, Claude) only
   * after an authenticated worker has actually called the scheduled pickup tool.
   * A schedule is NOT an active listener, webhook, or autonomous wake proof.
   * The host owns the schedule; this method never invokes a model.
   */
  async delegateScheduled(caller:Host,input:{missionId:string;role:MeshRole;instruction:string;idempotencyKey:string}){
    check(caller===leaderHost(),`Only ${leaderLabel()} can delegate`);
    check(input.missionId.trim().length>0&&input.missionId.length<=120,'Invalid mission');
    check(roles.has(input.role)&&input.role!=='orchestrator','Invalid role');
    check(input.instruction.trim().length>0&&input.instruction.length<=50000,'Invalid instruction');
    check(input.idempotencyKey.trim().length>0&&input.idempotencyKey.length<=160,'Invalid idempotency');
    const choice=await this.read(d=>{
      const replay=d.works.find(w=>w.missionId===input.missionId&&w.idempotencyKey===input.idempotencyKey);
      if(replay)return {replay};
      if(d.profiles.some(p=>p.host===leaderHost()&&p.coordinationMode==='GPT_A_ONLY'))
        return {reason:'GPT_A_ONLY' as const};
      if(input.role==='implementer')return {reason:'SCHEDULED_WRITES_NOT_ENABLED' as const};
      const now=Date.now();
      const ready=d.profiles.filter(p=>{
        if(p.host===leaderHost()||!p.roles.includes(input.role)||p.scheduledPickupEnabled!==true)
          return false;
        const interval=p.scheduledPollIntervalSeconds;
        const ob=d.workforce?.[p.host as WorkerHost];
        const age=now-Date.parse(ob?.lastScheduledPollAt??'');
        return interval!==undefined&&Number.isFinite(age)&&age>=0&&
          age<=interval*2000+120_000&&
          ob?.reportedRoute?.deliveryMode==='SCHEDULED_POLL'&&
          ob.reportedRoute.pollIntervalSeconds===interval&&
          !d.works.some(w=>w.target===p.host&&
            ['QUEUED','RUNNING','OUTCOME_UNKNOWN'].includes(w.state));
      }).sort((a,b)=>{
        const aAge=Date.parse(d.workforce?.[a.host as WorkerHost]?.lastScheduledPollAt??'');
        const bAge=Date.parse(d.workforce?.[b.host as WorkerHost]?.lastScheduledPollAt??'');
        return bAge-aAge||a.host.localeCompare(b.host);
      });
      return ready[0]?{target:ready[0].host}:{reason:'NO_OBSERVED_SCHEDULED_PEER' as const};
    });
    if('replay' in choice&&choice.replay){
      check(choice.replay.role===input.role&&choice.replay.instruction===input.instruction&&
        !choice.replay.specialist,'Idempotency conflict');
      return {status:'DELEGATED' as const,selectedHost:choice.replay.target,
        work:choice.replay,selectionEvidence:'IDEMPOTENT_REPLAY' as const,
        autonomousWakeVerified:false as const};
    }
    if(!('target' in choice)||!choice.target)
      return {status:'LOCAL_FALLBACK_REQUIRED' as const,
        reason:('reason' in choice?choice.reason:'NO_OBSERVED_SCHEDULED_PEER'),
        autonomousWakeVerified:false as const};
    try{
      const work=await this.delegate(caller,{...input,target:choice.target,scheduleOnly:true});
      return {status:'DELEGATED' as const,selectedHost:work.target,work,
        selectionEvidence:'OBSERVED_SCHEDULE_POLL_QUEUE_ONLY' as const,
        autonomousWakeVerified:false as const};
    }catch(error){
      if(error instanceof Error&&
        /Scheduled worker busy|Scheduled worker has no recent authenticated scheduled pickup/.test(error.message))
        return {status:'LOCAL_FALLBACK_REQUIRED' as const,reason:'SCHEDULE_NO_LONGER_ELIGIBLE' as const,
          autonomousWakeVerified:false as const};
      throw error;
    }
  }

  /** One-shot Claude Code Routines outbox. A lost POST acknowledgment is
   * uncertain: never automatically retry, since each fire starts a new session.
   */
  async reserveClaudeWake(caller:Host,workId:string){
    check(caller===leaderHost(),`Only ${leaderLabel()} may signal delegated work`);
    return this.write(d=>{
      const w=d.works.find(w=>w.id===workId&&w.target==='claude');
      check(w,'Claude work not found');
      const existing=(d.claudeWakeAttempts??[]).find(a=>a.workId===workId);
      if(existing)return {send:false,attempt:existing};
      check(w.state==='QUEUED','Only queued Claude work can receive wake');
      const attempt:ClaudeWakeAttempt={workId,state:'RESERVED',reservedAt:iso(),
        statusCode:null,sessionId:null};
      (d.claudeWakeAttempts??=[]).push(attempt);
      this.notify(d,leaderHost());
      return {send:true,attempt};
    });
  }
  async finishClaudeWake(caller:Host,workId:string,accepted:boolean,statusCode:number|null,sessionId:string|null){
    check(caller===leaderHost(),`Only ${leaderLabel()} may record wake delivery`);
    return this.write(d=>{
      const attempt=(d.claudeWakeAttempts??[]).find(a=>a.workId===workId);
      check(attempt,'Claude wake attempt not found');
      if(attempt.state!=='RESERVED')return attempt;
      attempt.state=accepted?'SIGNAL_ACCEPTED':'SIGNAL_FAILED';
      attempt.statusCode=statusCode;
      attempt.sessionId=accepted?sessionId:null;
      this.notify(d,leaderHost());
      return attempt;
    });
  }
  async claudeWakeStatus(caller:Host,workId:string){
    check(caller===leaderHost(),`Only ${leaderLabel()} may inspect Claude wake attempts`);
    return this.read(d=>{
      const w=d.works.find(w=>w.id===workId&&w.target==='claude');
      check(w,'Claude work not found');
      const a=(d.claudeWakeAttempts??[]).find(x=>x.workId===workId);
      return {workId,state:a?.state??'DELIVERY_ONLY',statusCode:a?.statusCode??null,
        sessionId:a?.sessionId??null,wakeObserved:a?.state==='SIGNAL_ACCEPTED'&&Boolean(a.claimedAt),
        claimedAt:a?.claimedAt??null};
    });
  }

  /** Select a recently authenticated standing worker without requiring GPT-A to
   * name a host. A reported route is NOT proof of cold-start wake. If there is
   * no suitable live peer, GPT-A must use its native local/subagent path.
   * Existing work is authoritative: an idempotent retry cannot reroute it.
   */
  async delegateAuto(caller:Host,input:{missionId:string;role:MeshRole;instruction:string;idempotencyKey:string}) {
    check(caller===leaderHost(),`Only ${leaderLabel()} can delegate`);
    check(input.missionId.length>0&&input.missionId.length<=120,'Invalid mission');
    check(roles.has(input.role)&&input.role!=='orchestrator','Invalid role');
    check(input.instruction.trim().length>0&&input.instruction.length<=50000,'Invalid instruction');
    check(input.idempotencyKey.length>0&&input.idempotencyKey.length<=160,'Invalid idempotency');
    const choice=await this.read(d=>{
      const replay=d.works.find(w=>w.missionId===input.missionId&&w.idempotencyKey===input.idempotencyKey);
      if(replay)return {replay};
      if(d.profiles.some(p=>p.host===leaderHost()&&p.coordinationMode==='GPT_A_ONLY'))
        return {reason:'GPT_A_ONLY' as const};
      const now=Date.now();
      const eligible=d.profiles.filter(p=>{
        if(p.host===leaderHost()||!p.roles.includes(input.role))return false;
        const observation=d.workforce?.[p.host as WorkerHost];
        const age=now-Date.parse(observation?.lastPollAt??'');
        // A worker can self-report LONG_POLL via panter_workforce_next.
        // Auto routing therefore requires an observed live MCP tool waiter
        // in this server process, *not* just fresh self-reported metadata.
        return Number.isFinite(age)&&age>=0&&age<=120000&&
          this.standingListenerCheck?.(p.host as WorkerHost)===true &&
          observation?.reportedRoute?.deliveryMode==='LONG_POLL';
      }).map(p=>({
        host:p.host,
        load:d.works.filter(w=>w.target===p.host&&
          ['QUEUED','RUNNING','OUTCOME_UNKNOWN'].includes(w.state)).length
      })).sort((a,b)=>a.load-b.load||a.host.localeCompare(b.host));
      return eligible.length?{target:eligible[0]!.host}:{reason:'NO_FRESH_STANDBY_PEER' as const};
    });
    if('replay' in choice&&choice.replay){
      check(choice.replay.role===input.role&&choice.replay.instruction===input.instruction&&
        !choice.replay.specialist,'Idempotency conflict');
      return {status:'DELEGATED' as const,selectedHost:choice.replay.target,
        work:choice.replay,selectionEvidence:'IDEMPOTENT_REPLAY' as const,
        autonomousWakeVerified:false as const};
    }
    if(!('target' in choice)||!choice.target){
      return {status:'LOCAL_FALLBACK_REQUIRED' as const,
        reason:('reason' in choice?choice.reason:null)??'NO_FRESH_STANDBY_PEER',
        autonomousWakeVerified:false as const};
    }
    // delegate() retains actor/role/grant checks, overlap fencing, and durable
    // SQLite idempotency. A disconnect after selection remains queued work.
    const work=await this.delegate(caller,{...input,target:choice.target});
    return {status:'DELEGATED' as const,selectedHost:work.target,work,
      selectionEvidence:'LIVE_MCP_LISTENER_AND_AUTHENTICATED_POLL' as const,
      autonomousWakeVerified:false as const};
  }

  /** Atomic 4R / blind-Judgment-Day fanout: exactly one frozen candidate and
   * one durable ledger commit for all review delegations. Native Pi's provider
   * judgment authority is NOT emulated; a controller must evaluate results.
   */
  async startReview(caller:Host,input:{missionId:string;kind:'4r'|'judgment-day';objective:string;candidateSha:string;idempotencyKey:string}) {
    check(caller===leaderHost(),`Only ${leaderLabel()} can initiate reviews`);
    check(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(input.candidateSha),'Invalid frozen candidate SHA');
    check(input.missionId.trim().length>0 && input.missionId.length<=120,'Invalid mission');
    check(input.objective.trim().length>0 && input.objective.length<=6000,'Invalid review objective');
    check(input.idempotencyKey.trim().length>0 && input.idempotencyKey.length<=160,'Invalid idempotency key');
    const ids=input.kind==='4r'?REVIEW_4R:JUDGMENT_DAY.slice(0,2);
    const bindings=await this.specialistBindings();
    const configured=ids.map(id=>bindings.find(b=>b.agentId===id));
    check(configured.every(Boolean),'All review specialists must be configured first');
    // One host may run both blind judges as separate, signed child executions.
    // Panter-RDD verifies runner evidence; the host label never proves independence.
    const packets=await Promise.all(ids.map((id,i)=>{
      const binding=configured[i]!;
      return specialistPacket({agentId:id,skillIds:binding.skillIds,objective:input.objective,modelRequest:binding.modelRequest,effortRequest:binding.effortRequest,candidateSha:input.candidateSha});
    }));
    return this.write(d=>{
      check(!d.profiles.some(p=>p.host===leaderHost()&&p.coordinationMode==='GPT_A_ONLY'),
        'GPT_A_ONLY forbids remote review fanout; use native review/evidence gates');
      const reviews=d.reviews??=[];
      const previous=reviews.find(r=>r.missionId===input.missionId && r.idempotencyKey===input.idempotencyKey);
      if(previous){check(previous.kind===input.kind && previous.candidateSha===input.candidateSha && previous.objective===input.objective,'Conflicting review idempotency');return previous;}
      const now=iso();const workIds:string[]=[];
      for(let i=0;i<ids.length;i++){
        const binding=activeBindings(d).find(b=>b.agentId===ids[i]);
        const original=configured[i]!,packet=packets[i]!;
        check(binding?.revision===original.revision && binding.host===original.host,'Review binding changed during dispatch');
        check(binding.host!==leaderHost(),'Specialists require a worker host');
        const profile=d.profiles.find(p=>p.host===binding.host);
        check(profile?.roles.includes('reviewer'),'Review host is not authorized for reviewer role');
        const work:MeshWork={id:randomUUID(),missionId:input.missionId,from:leaderHost(),target:binding.host,role:'reviewer',instruction:packet.instruction,
          idempotencyKey:`${input.idempotencyKey}:${ids[i]}`,specialist:{agentId:packet.agentId,skillIds:packet.skillIds,packetDigest:packet.digest,
            assetDigests:packet.assetDigests,modelRequest:binding.modelRequest,effortRequest:binding.effortRequest,bindingRevision:binding.revision,
            candidateSha:input.candidateSha,allowedEditSurfaces:[]},state:'QUEUED',attemptId:null,leaseGeneration:0,leaseUntil:null,result:null,receiptDigest:null,createdAt:now,completedAt:null};
        d.works.push(work);workIds.push(work.id);this.notify(d,binding.host);
      }
      const review:ReviewSession={id:randomUUID(),missionId:input.missionId,kind:input.kind,objective:input.objective,candidateSha:input.candidateSha,idempotencyKey:input.idempotencyKey,workIds,createdAt:now};
      reviews.push(review);this.notify(d,leaderHost());return review;
    });
  }
  reviewStatus(caller:Host,reviewId:string){
    check(caller===leaderHost(),`Only ${leaderLabel()} may inspect review aggregate`);
    return this.read(d=>{
      const review=(d.reviews??[]).find(r=>r.id===reviewId);
      check(review,'Review not found');
      const work=review.workIds.map(id=>d.works.find(w=>w.id===id));
      check(work.every(Boolean),'Review ledger inconsistent');
      const terminal=work.every(w=>w!.state==='COMPLETED'||w!.state==='FAILED');
      return {review,stage:terminal?'READY_FOR_CONTROLLER':'AWAITING_REPORTS',
        nativeReviewAuthority:false,
        work:work.map(w=>({workId:w!.id,agentId:w!.specialist?.agentId,packetDigest:w!.specialist?.packetDigest,host:w!.target,state:w!.state,receiptDigest:w!.receiptDigest,result:w!.result}))};
    });
  }

  pending(caller: Host) { return this.read(d => d.works.filter(w => w.target === caller && w.state === 'QUEUED').map(w => ({ workId: w.id, missionId: w.missionId, role: w.role, createdAt: w.createdAt }))); }
  async claim(caller: Host, workId: string, leaseSeconds = 300, requireQueued = false) {
    check(caller!==leaderHost(),'Only workers may claim delegated work');
    check(leaseSeconds >= 30 && leaseSeconds <= 3600, 'Invalid lease');
    const offered=await this.read(d=>d.works.find(w=>w.id===workId&&w.target===caller)??null);
    if(offered?.role==='implementer'&&this.writeGuard)
      await this.writeGuard(offered.missionId,offered.specialist?.allowedEditSurfaces??[]);
    return this.write(d => {
      const w = d.works.find(w => w.id === workId && w.target === caller);
      check(w, 'Work not found');
      if(requireQueued)check(w.state==='QUEUED','Work is not claimable');
      const expired = w.state === 'RUNNING' && Date.parse(w.leaseUntil ?? '') <= Date.now();
      check(w.state === 'QUEUED' || w.state === 'RUNNING', 'Work is not claimable');
      if (w.state === 'RUNNING' && !expired) return w;
      // A lost ACK after an uncertain write cannot authorize an automatic replay.
      if (expired && w.role === 'implementer') {
        w.state = 'OUTCOME_UNKNOWN';
        this.notify(d, leaderHost());
        return { ...w, instruction: '', result: null };
      }
      w.state = 'RUNNING'; w.leaseGeneration++; w.attemptId = randomUUID();
      if (caller !== leaderHost()) {
        const presence = (d.workforce ??= {})[caller as WorkerHost] ??= {};
        presence.lastClaimAt = iso();
        const grokWake=(d.grokWakeAttempts??[]).find(a=>a.workId===w.id);
        const claudeWake=(d.claudeWakeAttempts??[]).find(a=>a.workId===w.id);
        for(const wake of [grokWake,claudeWake])
          if(wake?.state==='SIGNAL_ACCEPTED')wake.claimedAt=presence.lastClaimAt;
      }
      w.leaseUntil = new Date(Date.now() + leaseSeconds * 1000).toISOString();
      this.notify(d, leaderHost());
      return w;
    });
  }
  /** A standing worker obtains a real fenced claim, without enumerating IDs.
   * No inference takes place here; the host executes the returned instructions.
   */
  async pickup(caller:Host,leaseSeconds=300,readOnlyOnly=false) {
    check(caller!==leaderHost(),'Only workers may pick up delegated work');
    check(Number.isInteger(leaseSeconds)&&leaseSeconds>=30&&leaseSeconds<=3600,'Invalid lease');
    // Snapshot candidates only; claim() still validates authority and CAS under SQLite.
    const candidates=(await this.pending(caller))
      .filter(w=>!readOnlyOnly||w.role!=='implementer')
      .sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.workId.localeCompare(b.workId));
    for(const candidate of candidates.slice(0,32)){
      try{
        const work=await this.claim(caller,candidate.workId,leaseSeconds,true);
        if(work.state!=='RUNNING')return {status:'OUTCOME_UNKNOWN' as const,workId:work.id};
        return {status:'CLAIMED' as const,work};
      }catch(error){
        // Concurrent worker already took this candidate; retry the next.
        if(error instanceof Error && /Work is not claimable|Work not found/.test(error.message))continue;
        // A permission failure must never be treated as an empty queue or bypassed.
        throw error;
      }
    }
    return {status:'EMPTY' as const};
  }
  /** Commit terminal receipt first, then separately arm a transport listener.
   * A rearm failure leaves a durable PENDING intent and never retries the work.
   */
  async completeAndRearm(caller:Host,id:string,attemptId:string,generation:number,result:string,
    success:boolean,protocolEra:'2025-11-25'|'2026-07-28'){
    check(caller!==leaderHost(),'Only workers may complete delegated work');
    const receipt=await this.complete(caller,id,attemptId,generation,result,success);
    try {
      const listener=await this.taskBridgeArm(caller,protocolEra);
      return {receipt,rearm:{status:'ACKED' as const,taskId:listener.taskId,
        delivery:'SCHEMA_BRIDGE_ONLY' as const}};
    }catch {
      // Preserve the successful terminal ACK; operator can inspect/retry rearm.
      return {receipt,rearm:{status:'PENDING_RETRY' as const}};
    }
  }
  async heartbeat(caller: Host, id: string, attemptId: string, generation: number, leaseSeconds = 300) {
    check(caller!==leaderHost(),'Only workers may renew delegated work');
    return this.write(d => {
      const w = d.works.find(w => w.id === id && w.target === caller);
      check(w && w.state === 'RUNNING' && w.attemptId === attemptId && w.leaseGeneration === generation, 'Stale work lease');
      check(Date.parse(w.leaseUntil!) > Date.now(), 'Lease expired');
      check(leaseSeconds >= 30 && leaseSeconds <= 3600, 'Invalid lease');
      w.leaseUntil = new Date(Date.now() + leaseSeconds * 1000).toISOString();
      return w;
    });
  }
  async complete(caller: Host, id: string, attemptId: string, generation: number, result: string, success = true) {
    check(caller!==leaderHost(),'Only workers may complete delegated work');
    check(result.length <= 50000, 'Result too long');
    return this.write(d => {
      const w = d.works.find(w => w.id === id && w.target === caller);
      check(w, 'Work not found');
      const digest = sha(JSON.stringify({ id, attemptId, generation, result, success }));
      if (w.state === 'COMPLETED' || w.state === 'FAILED') {
        check(w.attemptId === attemptId && w.leaseGeneration === generation && w.receiptDigest === digest, 'Conflicting terminal receipt');
        return {workId:w.id,state:w.state,receiptDigest:w.receiptDigest,completedAt:w.completedAt,
          resultAvailable:true,rearmPending:(d.rearmIntents??[]).some(i=>i.workId===id&&i.status==='PENDING')};
      }
      check(w.state === 'RUNNING' && w.attemptId === attemptId && w.leaseGeneration === generation, 'Stale work lease');
      check(Date.parse(w.leaseUntil!) > Date.now(), 'Lease expired');
      w.state = success ? 'COMPLETED' : 'FAILED'; w.result = result; w.receiptDigest = digest;
      w.completedAt = iso(); w.leaseUntil = null;
      if (caller !== leaderHost()) {
        const presence = (d.workforce ??= {})[caller as WorkerHost] ??= {};
        presence.lastReceiptAt = w.completedAt;
      }
      const revision = this.notify(d, leaderHost());
      // Only the receipt pointer enters the inbox, never worker result text.
      d.messages.push({ id: randomUUID(), missionId: w.missionId, from: caller, to: leaderHost(), workId: id, kind: 'RESULT', text: JSON.stringify({workId:id,state:w.state,receiptDigest:digest,resultAvailable:true}), createdAt: iso(), inboxRevision: revision });
      if(caller!==leaderHost()&&!(d.rearmIntents??[]).some(x=>x.workId===id))
        (d.rearmIntents??=[]).push({workId:id,host:caller as WorkerHost,status:'PENDING',createdAt:iso()});
      // Compact terminal receipt: result remains in SQLite for GPT-A.
      return {workId:w.id,state:w.state,receiptDigest:w.receiptDigest,completedAt:w.completedAt,
        resultAvailable:true,rearmPending:(d.rearmIntents??[]).some(i=>i.workId===id&&i.status==='PENDING')};
    });
  }
  /** Operator-only ledger view; does not expose credentials and cannot stop a worker. */
  uncertainWriters(){
    return this.read(d=>d.works.filter(w=>w.role==='implementer'&&
      (w.state==='OUTCOME_UNKNOWN'||(w.state==='RUNNING'&&Date.parse(w.leaseUntil??'')<=Date.now())))
      .map(w=>({workId:w.id,missionId:w.missionId,target:w.target,state:w.state,
        attemptId:w.attemptId,leaseGeneration:w.leaseGeneration,leaseUntil:w.leaseUntil,
        allowedEditSurfaces:w.specialist?.allowedEditSurfaces??[],createdAt:w.createdAt})));
  }
  /** A lost writer result is NEVER replayed automatically. Only a trusted operator,
   * after inspecting the actual workspace, can resolve its exact fenced attempt.
   * This is an audit record of a human decision, not cryptographic proof. */
  async reconcileWriter(input:{workId:string;attemptId:string;leaseGeneration:number;
    resolution:'CONFIRMED_COMPLETE'|'CONFIRMED_NO_EFFECTS';evidence:string;isolationEvidence?:string;
    result?:{summary:string;evidence:string[];candidateSha:string;runId:string}}){
    check(/^[0-9a-f-]{36}$/i.test(input.workId),'Invalid work ID');
    check(input.evidence.trim().length>=32&&input.evidence.length<=2000,'Detailed operator reconciliation evidence required');
    if(input.resolution==='CONFIRMED_COMPLETE'){
      const result=input.result;
      check(!!result&&result.summary.trim().length>0&&Array.isArray(result.evidence)&&
        result.evidence.length>0&&result.evidence.every(x=>typeof x==='string'&&x.trim().length>0)&&
        /^[a-f0-9]{40}$/.test(result.candidateSha)&&/^[A-Za-z0-9._:-]{8,160}$/.test(result.runId),
        'Confirmed writer completion requires observed SHA, run ID and evidence');
    }else {
      check(!input.result,'No-effects resolution cannot supply completed work');
      check(typeof input.isolationEvidence==='string'&&input.isolationEvidence.trim().length>=40&&
        input.isolationEvidence.length<=2000,
        'Confirm peer credentials revoked or worker terminated and worktree isolated before releasing scope');
    }
    return this.write(d=>{
      const w=d.works.find(w=>w.id===input.workId);
      check(w&&w.role==='implementer','Unknown implementer work');
      check(w.attemptId===input.attemptId&&w.leaseGeneration===input.leaseGeneration,
        'Stale writer attempt: reconciliation must match original fence');
      check((w.state==='OUTCOME_UNKNOWN'||(w.state==='RUNNING'&&
        Date.parse(w.leaseUntil??'')<=Date.now())), 'Writer is not in an expired uncertain state');
      w.reconciliation={resolution:input.resolution,evidence:input.evidence+(input.isolationEvidence?'\nIsolation: '+input.isolationEvidence:''),at:iso()};
      w.completedAt=iso();w.leaseUntil=null;
      if(input.resolution==='CONFIRMED_COMPLETE'){
        const result=JSON.stringify(input.result);
        w.state='COMPLETED';w.result=result;
        w.receiptDigest=sha(JSON.stringify({reconciledWorkId:w.id,attemptId:w.attemptId,
          generation:w.leaseGeneration,result,operatorEvidence:input.evidence}));
        const revision=this.notify(d,leaderHost());
        d.messages.push({id:randomUUID(),missionId:w.missionId,from:w.target,to:leaderHost(),
          workId:w.id,kind:'RESULT',text:JSON.stringify({workId:w.id,state:w.state,receiptDigest:w.receiptDigest,resultAvailable:true}),createdAt:iso(),inboxRevision:revision});
      }else{
        w.state='ABORTED_NO_EFFECTS';w.result=null;w.receiptDigest=null;
        this.notify(d,leaderHost());
      }
      return {workId:w.id,state:w.state,reconciliation:w.reconciliation,leaseGeneration:w.leaseGeneration};
    });
  }
  async message(caller: Host, input: { missionId: string; to: Host; workId?: string; text: string; kind: 'QUESTION' | 'ANSWER' | 'UPDATE' }) {
    check(isHost(input.to) && caller !== input.to, 'Invalid recipient');
    check(input.text.trim().length > 0 && input.text.length <= 10000, 'Invalid message');
    return this.write(d => {
      const w = input.workId ? d.works.find(x => x.id === input.workId) : null;
      check(w && w.missionId === input.missionId, 'Known work is required for peer messages');
      check((caller === leaderHost() && w.target === input.to) || (input.to === leaderHost() && w.target === caller), 'Not a member of this delegation');
      const revision = this.notify(d, input.to);
      const msg: MeshMessage = { id: randomUUID(), missionId: input.missionId, from: caller, to: input.to, workId: w.id, kind: input.kind, text: input.text, createdAt: iso(), inboxRevision: revision };
      d.messages.push(msg);
      return msg;
    });
  }
  inbox(caller: Host, sinceRevision = 0) {
    check(Number.isSafeInteger(sinceRevision) && sinceRevision >= 0, 'Invalid revision cursor');
    return this.read(d => ({
      revision: d.inboxRevision[caller],
      messages: d.messages.filter(m => m.to === caller && m.inboxRevision > sinceRevision),
      works: d.works.filter(w => w.target === caller || caller === leaderHost()).map(w => ({ id: w.id, missionId: w.missionId, target: w.target, role: w.role, state: w.state, receiptDigest: w.receiptDigest, completedAt: w.completedAt })),
    }));
  }
  /** Safe to publish across the host mesh: never include actor-specific counts or secrets. */
  changeResource() { return { uri: 'panter://mesh/changed', message: 'An event may be available. Read your authenticated inbox.', durable: false }; }
  resource(caller: Host) { return this.read(d => ({ uri: `panter://inbox/${caller}`, revision: d.inboxRevision[caller], messageCount: d.messages.filter(m => m.to === caller).length, pendingCount: d.works.filter(w => w.target === caller && w.state === 'QUEUED').length })); }
}
