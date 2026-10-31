import { SqliteLedger } from './sqlite-ledger.js';
/** Original, provider-independent collaboration ledger for authenticated MCP hosts. */
import { createHash, randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { EventEmitter } from 'node:events';
import { agentDefinition, checkSkills, specialistPacket, REVIEW_4R, JUDGMENT_DAY, type GentleSkillId } from './gentle-catalog.js';

export const HOSTS = ['gpt-a', 'gpt-b', 'grok', 'gemini', 'claude'] as const;
export type Host = typeof HOSTS[number];
export type MeshRole = 'orchestrator' | 'explorer' | 'architect' | 'implementer' | 'verifier' | 'reviewer';
export type MeshWorkState = 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'WAITING_INPUT' | 'OUTCOME_UNKNOWN' | 'ABORTED_NO_EFFECTS';
export type ActorProfile = { host: Host; actorId: string; modelRequest: string; effortRequest: string; roles: MeshRole[]; revision: number; preferNativeSubagents?: boolean; maxRequestedNativeWorkers?: number; coordinationMode?: 'AUTO' | 'GPT_A_ONLY' };
export type MeshMessage = { id: string; missionId: string; from: Host; to: Host; workId: string | null; kind: 'QUESTION' | 'ANSWER' | 'UPDATE' | 'RESULT'; text: string; createdAt: string; inboxRevision: number };
export type MeshWork = { id: string; missionId: string; from: Host; target: Host; role: MeshRole; instruction: string; idempotencyKey: string; specialist?: {agentId:string;skillIds:string[];packetDigest:string;assetDigests:Record<string,string>;modelRequest:string;effortRequest:string;bindingRevision:number;candidateSha?:string;allowedEditSurfaces:string[]}; state: MeshWorkState; attemptId: string | null; leaseGeneration: number; leaseUntil: string | null; result: string | null; receiptDigest: string | null; createdAt: string; completedAt: string | null; reconciliation?: {resolution:'CONFIRMED_COMPLETE'|'CONFIRMED_NO_EFFECTS';evidence:string;at:string} };
export type SpecialistBinding = {agentId:string;host:Host;modelRequest:string;effortRequest:string;skillIds:GentleSkillId[];revision:number};
export type ReviewSession = {id:string;missionId:string;kind:'4r'|'judgment-day';objective:string;candidateSha:string;idempotencyKey:string;workIds:string[];createdAt:string};
type MeshData = { version: 1; profiles: ActorProfile[]; specialistBindings?: SpecialistBinding[]; reviews?:ReviewSession[]; works: MeshWork[]; messages: MeshMessage[]; inboxRevision: Record<Host, number> };
const hosts = new Set<string>(HOSTS);
const roles = new Set<MeshRole>(['orchestrator', 'explorer', 'architect', 'implementer', 'verifier', 'reviewer']);
export function isHost(x: string): x is Host { return hosts.has(x); }
function check(condition: unknown, reason: string): asserts condition { if (!condition) throw new Error(reason); }
function sha(value: string) { return createHash('sha256').update(value).digest('hex'); }
function iso() { return new Date().toISOString(); }

export class MeshEngine {
  private readonly sqlite: SqliteLedger;
  private state: MeshData = { version: 1, profiles: [], specialistBindings: [], reviews:[], works: [], messages: [], inboxRevision: { 'gpt-a': 0, 'gpt-b': 0, 'grok': 0, 'gemini': 0, 'claude': 0 } };
  private chain: Promise<unknown> = Promise.resolve();
  /** Emitted only AFTER the updated ledger is atomically persisted. */
  readonly events = new EventEmitter();
  private writeGuard:((missionId:string,paths:string[])=>Promise<void>)|null=null;
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
    check(caller === 'gpt-a', 'Only orchestrator configures agents');
    check(isHost(profile.host), 'Unrecognized host');
    check(profile.actorId.trim().length >= 3 && profile.actorId.length <= 160, 'Invalid actor');
    check(profile.modelRequest.length <= 120 && profile.effortRequest.length <= 32, 'Invalid model request');
    check(profile.roles.length > 0 && profile.roles.every(r => roles.has(r)), 'Invalid roles');
    if(profile.preferNativeSubagents !== undefined) check(typeof profile.preferNativeSubagents==='boolean' && profile.host==='gpt-a', 'Native worker preferences are leader-only');
    if(profile.coordinationMode !== undefined) check(profile.host==='gpt-a' && ['AUTO','GPT_A_ONLY'].includes(profile.coordinationMode), 'Coordination mode is GPT-A-only');
    if(profile.maxRequestedNativeWorkers !== undefined) check(profile.host==='gpt-a' && Number.isInteger(profile.maxRequestedNativeWorkers) && profile.maxRequestedNativeWorkers>=0 && profile.maxRequestedNativeWorkers<=32, 'Invalid native worker ceiling');
    check(profile.host !== 'gpt-a' || profile.roles.every(r => r === 'orchestrator'), 'GPT-A is the coordinator');
    check(profile.host === 'gpt-a' || !profile.roles.includes('orchestrator'), 'Only GPT-A is the coordinator');
    return this.write(d => {
      const i = d.profiles.findIndex(p => p.host === profile.host);
      const before = d.profiles[i];
      check((before?.revision ?? 0) === expectedRevision, 'Stale profile revision');
      const next = { ...profile, roles: [...new Set(profile.roles)], revision: expectedRevision + 1 };
      if (i < 0) d.profiles.push(next); else d.profiles[i] = next;
      this.notify(d, profile.host);
      this.notify(d, 'gpt-a');
      return next;
    });
  }
  /** Persist the user's single-host choice without reopening Agent Studio. */
  setCoordinationMode(caller:Host, coordinationMode:'AUTO'|'GPT_A_ONLY', expectedRevision:number){
    check(caller==='gpt-a','GPT-A alone may change coordination mode');
    check(coordinationMode==='AUTO'||coordinationMode==='GPT_A_ONLY','Invalid coordination mode');
    return this.write(d=>{
      const before=d.profiles.find(p=>p.host==='gpt-a');
      check((before?.revision??0)===expectedRevision,'Stale GPT-A coordination revision');
      const next:ActorProfile={...(before??{
        host:'gpt-a',actorId:'actor-gpt-a',modelRequest:'gpt-6-astra',effortRequest:'max',roles:['orchestrator'],
        preferNativeSubagents:true,maxRequestedNativeWorkers:32,revision:0
      }),coordinationMode,revision:expectedRevision+1};
      if(before)d.profiles[d.profiles.indexOf(before)]=next;else d.profiles.push(next);
      this.notify(d,'gpt-a');return next;
    });
  }
  profiles() { return this.read(d => d.profiles); }
  specialistBindings() { return this.read(d => d.specialistBindings ?? []); }
  /** GPT-A configures many specialist definitions independently of the five hosts. */
  bindSpecialist(caller:Host, input:{agentId:string;host:Host;modelRequest:string;effortRequest:string;skillIds:string[]}, expectedRevision:number) {
    check(caller==='gpt-a', 'Only GPT-A configures specialist bindings');
    const definition=agentDefinition(input.agentId);
    check(definition, 'Unknown catalog agent');
    check(isHost(input.host) && input.host!=='gpt-a', 'Specialists require a worker host');
    check(input.modelRequest.length<=120 && input.effortRequest.length<=32, 'Invalid model configuration');
    check(Number.isSafeInteger(expectedRevision) && expectedRevision>=0,'Invalid binding revision');
    const skills=checkSkills(input.skillIds);
    return this.write(d=>{
      const bindings=d.specialistBindings ??= [];
      const i=bindings.findIndex(b=>b.agentId===input.agentId);
      check((bindings[i]?.revision??0)===expectedRevision,'Stale specialist binding revision');
      const next:SpecialistBinding={agentId:definition.id,host:input.host,modelRequest:input.modelRequest,effortRequest:input.effortRequest,skillIds:skills,revision:expectedRevision+1};
      if(i===-1)bindings.push(next);else bindings[i]=next;
      this.notify(d,'gpt-a');
      return next;
    });
  }
  /** Assemble immutable role+skill packet from MCP-hosted catalog. The ledger
   * retains the exact packet; later skill updates cannot change in-flight work.
   */
  async delegateBoundSpecialist(caller:Host,input:{missionId:string;agentId:string;objective:string;idempotencyKey:string;candidateSha?:string;allowedEditSurfaces?:string[]}) {
    check(caller==='gpt-a','Only GPT-A can delegate');
    const binding=await this.read(d=>(d.specialistBindings??[]).find(b=>b.agentId===input.agentId)??null);
    check(binding,'Specialist must be configured in Agent Studio');
    const packet=await specialistPacket({agentId:binding.agentId,skillIds:binding.skillIds,objective:input.objective,modelRequest:binding.modelRequest,effortRequest:binding.effortRequest,candidateSha:input.candidateSha,allowedEditSurfaces:input.allowedEditSurfaces});
    return this.delegate(caller,{missionId:input.missionId,target:binding.host,role:packet.role,instruction:packet.instruction,idempotencyKey:input.idempotencyKey,
      specialist:{agentId:packet.agentId,skillIds:packet.skillIds,packetDigest:packet.digest,assetDigests:packet.assetDigests,modelRequest:binding.modelRequest,effortRequest:binding.effortRequest,bindingRevision:binding.revision,candidateSha:input.candidateSha,allowedEditSurfaces:packet.allowedEditSurfaces}});
  }
  async delegate(caller: Host, input: { missionId: string; target: Host; role: MeshRole; instruction: string; idempotencyKey: string; specialist?:NonNullable<MeshWork['specialist']> }) {
    check(caller === 'gpt-a', 'Only GPT-A can delegate');
    check(input.missionId.length > 0 && input.missionId.length <= 120, 'Invalid mission');
    check(isHost(input.target) && input.target !== 'gpt-a', 'Invalid target');
    check(roles.has(input.role) && input.role !== 'orchestrator', 'Invalid role');
    check(input.instruction.trim().length > 0 && input.instruction.length <= 50000, 'Invalid instruction');
    check(input.idempotencyKey.length > 0 && input.idempotencyKey.length <= 160, 'Invalid idempotency');
    if(input.role==='implementer'&&this.writeGuard)
      await this.writeGuard(input.missionId,input.specialist?.allowedEditSurfaces??[]);
    return this.write(d => {
      check(!d.profiles.some(p=>p.host==='gpt-a'&&p.coordinationMode==='GPT_A_ONLY'),
        'GPT_A_ONLY forbids remote delegation; use native GPT-A phases');
      if (input.specialist) {
        const binding=(d.specialistBindings??[]).find(b=>b.agentId===input.specialist?.agentId);
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
      if(input.specialist?.allowedEditSurfaces?.length){
        const conflict=d.works.find(w=>w.missionId===input.missionId && w.role==='implementer' && ['QUEUED','RUNNING','OUTCOME_UNKNOWN'].includes(w.state) && (w.specialist?.allowedEditSurfaces??[]).some(a=>input.specialist!.allowedEditSurfaces.some(b=>a===b || a.startsWith(b+'/') || b.startsWith(a+'/'))));
        check(!conflict,'Overlapping active writer edit surfaces');
      }
      const w: MeshWork = { id: randomUUID(), missionId: input.missionId, from: 'gpt-a', target: input.target, role: input.role, instruction: input.instruction, idempotencyKey: input.idempotencyKey, specialist: input.specialist, state: 'QUEUED', attemptId: null, leaseGeneration: 0, leaseUntil: null, result: null, receiptDigest: null, createdAt: iso(), completedAt: null };
      d.works.push(w);
      this.notify(d, input.target);
      this.notify(d, 'gpt-a');
      return w;
    });
  }

  /** Atomic 4R / blind-Judgment-Day fanout: exactly one frozen candidate and
   * one durable ledger commit for all review delegations. Native Pi's provider
   * judgment authority is NOT emulated; a controller must evaluate results.
   */
  async startReview(caller:Host,input:{missionId:string;kind:'4r'|'judgment-day';objective:string;candidateSha:string;idempotencyKey:string}) {
    check(caller==='gpt-a','Only GPT-A can initiate reviews');
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
      check(!d.profiles.some(p=>p.host==='gpt-a'&&p.coordinationMode==='GPT_A_ONLY'),
        'GPT_A_ONLY forbids remote review fanout; use native review/evidence gates');
      const reviews=d.reviews??=[];
      const previous=reviews.find(r=>r.missionId===input.missionId && r.idempotencyKey===input.idempotencyKey);
      if(previous){check(previous.kind===input.kind && previous.candidateSha===input.candidateSha && previous.objective===input.objective,'Conflicting review idempotency');return previous;}
      const now=iso();const workIds:string[]=[];
      for(let i=0;i<ids.length;i++){
        const binding=(d.specialistBindings??[]).find(b=>b.agentId===ids[i]);
        const original=configured[i]!,packet=packets[i]!;
        check(binding?.revision===original.revision && binding.host===original.host,'Review binding changed during dispatch');
        const profile=d.profiles.find(p=>p.host===binding.host);
        check(profile?.roles.includes('reviewer'),'Review host is not authorized for reviewer role');
        const work:MeshWork={id:randomUUID(),missionId:input.missionId,from:'gpt-a',target:binding.host,role:'reviewer',instruction:packet.instruction,
          idempotencyKey:`${input.idempotencyKey}:${ids[i]}`,specialist:{agentId:packet.agentId,skillIds:packet.skillIds,packetDigest:packet.digest,
            assetDigests:packet.assetDigests,modelRequest:binding.modelRequest,effortRequest:binding.effortRequest,bindingRevision:binding.revision,
            candidateSha:input.candidateSha,allowedEditSurfaces:[]},state:'QUEUED',attemptId:null,leaseGeneration:0,leaseUntil:null,result:null,receiptDigest:null,createdAt:now,completedAt:null};
        d.works.push(work);workIds.push(work.id);this.notify(d,binding.host);
      }
      const review:ReviewSession={id:randomUUID(),missionId:input.missionId,kind:input.kind,objective:input.objective,candidateSha:input.candidateSha,idempotencyKey:input.idempotencyKey,workIds,createdAt:now};
      reviews.push(review);this.notify(d,'gpt-a');return review;
    });
  }
  reviewStatus(caller:Host,reviewId:string){
    check(caller==='gpt-a','Only GPT-A may inspect review aggregate');
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
  async claim(caller: Host, workId: string, leaseSeconds = 300) {
    check(leaseSeconds >= 30 && leaseSeconds <= 3600, 'Invalid lease');
    const offered=await this.read(d=>d.works.find(w=>w.id===workId&&w.target===caller)??null);
    if(offered?.role==='implementer'&&this.writeGuard)
      await this.writeGuard(offered.missionId,offered.specialist?.allowedEditSurfaces??[]);
    return this.write(d => {
      const w = d.works.find(w => w.id === workId && w.target === caller);
      check(w, 'Work not found');
      const expired = w.state === 'RUNNING' && Date.parse(w.leaseUntil ?? '') <= Date.now();
      check(w.state === 'QUEUED' || w.state === 'RUNNING', 'Work is not claimable');
      if (w.state === 'RUNNING' && !expired) return w;
      // A lost ACK after an uncertain write cannot authorize an automatic replay.
      if (expired && w.role === 'implementer') {
        w.state = 'OUTCOME_UNKNOWN';
        this.notify(d, 'gpt-a');
        return { ...w, instruction: '', result: null };
      }
      w.state = 'RUNNING'; w.leaseGeneration++; w.attemptId = randomUUID();
      w.leaseUntil = new Date(Date.now() + leaseSeconds * 1000).toISOString();
      this.notify(d, 'gpt-a');
      return w;
    });
  }
  async heartbeat(caller: Host, id: string, attemptId: string, generation: number, leaseSeconds = 300) {
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
    check(result.length <= 50000, 'Result too long');
    return this.write(d => {
      const w = d.works.find(w => w.id === id && w.target === caller);
      check(w, 'Work not found');
      const digest = sha(JSON.stringify({ id, attemptId, generation, result, success }));
      if (w.state === 'COMPLETED' || w.state === 'FAILED') {
        check(w.attemptId === attemptId && w.leaseGeneration === generation && w.receiptDigest === digest, 'Conflicting terminal receipt');
        return w;
      }
      check(w.state === 'RUNNING' && w.attemptId === attemptId && w.leaseGeneration === generation, 'Stale work lease');
      check(Date.parse(w.leaseUntil!) > Date.now(), 'Lease expired');
      w.state = success ? 'COMPLETED' : 'FAILED'; w.result = result; w.receiptDigest = digest;
      w.completedAt = iso(); w.leaseUntil = null;
      const revision = this.notify(d, 'gpt-a');
      d.messages.push({ id: randomUUID(), missionId: w.missionId, from: caller, to: 'gpt-a', workId: id, kind: 'RESULT', text: result, createdAt: iso(), inboxRevision: revision });
      return w;
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
        const revision=this.notify(d,'gpt-a');
        d.messages.push({id:randomUUID(),missionId:w.missionId,from:w.target,to:'gpt-a',
          workId:w.id,kind:'RESULT',text:result,createdAt:iso(),inboxRevision:revision});
      }else{
        w.state='ABORTED_NO_EFFECTS';w.result=null;w.receiptDigest=null;
        this.notify(d,'gpt-a');
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
      check((caller === 'gpt-a' && w.target === input.to) || (input.to === 'gpt-a' && w.target === caller), 'Not a member of this delegation');
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
      works: d.works.filter(w => w.target === caller || (caller === 'gpt-a' && w.from === 'gpt-a')).map(w => ({ id: w.id, missionId: w.missionId, target: w.target, role: w.role, state: w.state, receiptDigest: w.receiptDigest, completedAt: w.completedAt })),
    }));
  }
  /** Safe to publish across the host mesh: never include actor-specific counts or secrets. */
  changeResource() { return { uri: 'panter://mesh/changed', message: 'An event may be available. Read your authenticated inbox.', durable: false }; }
  resource(caller: Host) { return this.read(d => ({ uri: `panter://inbox/${caller}`, revision: d.inboxRevision[caller], messageCount: d.messages.filter(m => m.to === caller).length, pendingCount: d.works.filter(w => w.target === caller && w.state === 'QUEUED').length })); }
}
