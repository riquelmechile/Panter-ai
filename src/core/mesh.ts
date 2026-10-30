/** Original, provider-independent collaboration ledger for authenticated MCP hosts. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { EventEmitter } from 'node:events';
import { agentDefinition, checkSkills, specialistPacket, type GentleSkillId } from './gentle-catalog.js';

export const HOSTS = ['gpt-a', 'gpt-b', 'grok', 'gemini', 'claude'] as const;
export type Host = typeof HOSTS[number];
export type MeshRole = 'orchestrator' | 'explorer' | 'architect' | 'implementer' | 'verifier' | 'reviewer';
export type MeshWorkState = 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'WAITING_INPUT' | 'OUTCOME_UNKNOWN';
export type ActorProfile = { host: Host; actorId: string; modelRequest: string; effortRequest: string; roles: MeshRole[]; revision: number };
export type MeshMessage = { id: string; missionId: string; from: Host; to: Host; workId: string | null; kind: 'QUESTION' | 'ANSWER' | 'UPDATE' | 'RESULT'; text: string; createdAt: string; inboxRevision: number };
export type MeshWork = { id: string; missionId: string; from: Host; target: Host; role: MeshRole; instruction: string; idempotencyKey: string; specialist?: {agentId:string;skillIds:string[];packetDigest:string;assetDigests:Record<string,string>;modelRequest:string;effortRequest:string;bindingRevision:number;candidateSha?:string;allowedEditSurfaces:string[]}; state: MeshWorkState; attemptId: string | null; leaseGeneration: number; leaseUntil: string | null; result: string | null; receiptDigest: string | null; createdAt: string; completedAt: string | null };
export type SpecialistBinding = {agentId:string;host:Host;modelRequest:string;effortRequest:string;skillIds:GentleSkillId[];revision:number};
type MeshData = { version: 1; profiles: ActorProfile[]; specialistBindings?: SpecialistBinding[]; works: MeshWork[]; messages: MeshMessage[]; inboxRevision: Record<Host, number> };
const hosts = new Set<string>(HOSTS);
const roles = new Set<MeshRole>(['orchestrator', 'explorer', 'architect', 'implementer', 'verifier', 'reviewer']);
export function isHost(x: string): x is Host { return hosts.has(x); }
function check(condition: unknown, reason: string): asserts condition { if (!condition) throw new Error(reason); }
function sha(value: string) { return createHash('sha256').update(value).digest('hex'); }
function iso() { return new Date().toISOString(); }

export class MeshEngine {
  private file: string;
  private state: MeshData = { version: 1, profiles: [], specialistBindings: [], works: [], messages: [], inboxRevision: { 'gpt-a': 0, 'gpt-b': 0, 'grok': 0, 'gemini': 0, 'claude': 0 } };
  private chain: Promise<unknown> = Promise.resolve();
  /** Emitted only AFTER the updated ledger is atomically persisted. */
  readonly events = new EventEmitter();
  private constructor(dir: string) { this.file = join(resolve(dir), 'mesh.json'); }

  static async open(dir: string) {
    const x = new MeshEngine(dir);
    await mkdir(resolve(dir), { recursive: true, mode: 0o700 });
    try {
      const parsed = JSON.parse(await readFile(x.file, 'utf8')) as MeshData;
      check(parsed.version === 1 && Array.isArray(parsed.works) && Array.isArray(parsed.profiles) && Array.isArray(parsed.messages), 'Invalid mesh ledger');
      for (const host of HOSTS) check(Number.isSafeInteger(parsed.inboxRevision[host]) && parsed.inboxRevision[host] >= 0, 'Invalid inbox revision');
      // v0.3 messages had no per-recipient cursor. Assign monotonic historical
      // positions without losing messages or advancing already published revisions.
      const historical: Record<Host, number> = { 'gpt-a': 0, 'gpt-b': 0, 'grok': 0, 'gemini': 0, 'claude': 0 };
      for (const m of parsed.messages) {
        check(isHost(m.to) && isHost(m.from), 'Invalid message actor');
        historical[m.to]++;
        if (!Number.isSafeInteger(m.inboxRevision) || m.inboxRevision <= 0) m.inboxRevision = historical[m.to];
        historical[m.to] = Math.max(historical[m.to], m.inboxRevision);
      }
      for (const host of HOSTS) parsed.inboxRevision[host] = Math.max(parsed.inboxRevision[host], historical[host]);
      if (parsed.specialistBindings !== undefined) check(Array.isArray(parsed.specialistBindings), 'Invalid specialist binding ledger');
      parsed.specialistBindings ??= [];
      x.state = parsed;
    } catch (e) {
      if (!(e instanceof Error) || !('code' in e) || e.code !== 'ENOENT') throw e;
    }
    return x;
  }
  private async write<T>(fn: (d: MeshData) => T): Promise<T> {
    const p = this.chain.then(async () => {
      const copy = structuredClone(this.state);
      const result = fn(copy);
      const changed = HOSTS.filter(host => copy.inboxRevision[host] !== this.state.inboxRevision[host]);
      // Publishing and state update must not get out of order: the event is
      // emitted only after rename, never before persistence.
      const tmp = `${this.file}.${randomUUID()}.tmp`;
      await writeFile(tmp, JSON.stringify(copy, null, 2), { flag: 'wx', mode: 0o600 });
      await rename(tmp, this.file);
      this.state = copy;
      if (changed.length > 0) this.events.emit('changed');
      for (const host of changed) this.events.emit(host, copy.inboxRevision[host]);
      return structuredClone(result);
    });
    this.chain = p.then(() => {}, () => {});
    return p;
  }
  private async read<T>(fn: (d: MeshData) => T): Promise<T> { await this.chain; return structuredClone(fn(this.state)); }
  private notify(d: MeshData, host: Host) { d.inboxRevision[host] = (d.inboxRevision[host] ?? 0) + 1; return d.inboxRevision[host]; }

  async setProfile(caller: Host, profile: Omit<ActorProfile, 'revision'>, expectedRevision: number) {
    check(caller === 'gpt-a', 'Only orchestrator configures agents');
    check(isHost(profile.host), 'Unrecognized host');
    check(profile.actorId.trim().length >= 3 && profile.actorId.length <= 160, 'Invalid actor');
    check(profile.modelRequest.length <= 120 && profile.effortRequest.length <= 32, 'Invalid model request');
    check(profile.roles.length > 0 && profile.roles.every(r => roles.has(r)), 'Invalid roles');
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
    return this.write(d => {
      if (input.specialist) {
        const binding=(d.specialistBindings??[]).find(b=>b.agentId===input.specialist?.agentId);
        check(binding?.host===input.target && binding.revision===input.specialist.bindingRevision, 'Specialist binding changed during dispatch');
        check(input.specialist.packetDigest===sha(input.instruction), 'Specialist packet digest mismatch');
      }
      if(input.specialist?.allowedEditSurfaces?.length){
        const conflict=d.works.find(w=>w.missionId===input.missionId && w.role==='implementer' && ['QUEUED','RUNNING','OUTCOME_UNKNOWN'].includes(w.state) && (w.specialist?.allowedEditSurfaces??[]).some(a=>input.specialist!.allowedEditSurfaces.some(b=>a===b || a.startsWith(b+'/') || b.startsWith(a+'/'))));
        check(!conflict,'Overlapping active writer edit surfaces');
      }
      const profile = d.profiles.find(p => p.host === input.target);
      check(profile?.roles.includes(input.role), 'Target agent role is not configured');
      const dup = d.works.find(w => w.missionId === input.missionId && w.idempotencyKey === input.idempotencyKey);
      if (dup) {
        check(dup.target === input.target && dup.role === input.role && dup.instruction === input.instruction && JSON.stringify(dup.specialist??null)===JSON.stringify(input.specialist??null), 'Idempotency conflict');
        return dup;
      }
      const w: MeshWork = { id: randomUUID(), missionId: input.missionId, from: 'gpt-a', target: input.target, role: input.role, instruction: input.instruction, idempotencyKey: input.idempotencyKey, specialist: input.specialist, state: 'QUEUED', attemptId: null, leaseGeneration: 0, leaseUntil: null, result: null, receiptDigest: null, createdAt: iso(), completedAt: null };
      d.works.push(w);
      this.notify(d, input.target);
      this.notify(d, 'gpt-a');
      return w;
    });
  }
  pending(caller: Host) { return this.read(d => d.works.filter(w => w.target === caller && w.state === 'QUEUED').map(w => ({ workId: w.id, missionId: w.missionId, role: w.role, createdAt: w.createdAt }))); }
  async claim(caller: Host, workId: string, leaseSeconds = 300) {
    check(leaseSeconds >= 30 && leaseSeconds <= 3600, 'Invalid lease');
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
