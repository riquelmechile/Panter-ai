import { SqliteLedger } from './sqlite-ledger.js';
/** Original, host-operated agent workflow. No inference, shell or remote-agent process lives here. */
import { createHash, randomUUID } from 'node:crypto';
import { PanterStore } from './store.js';

export type AgentRole = 'scout' | 'designer' | 'builder' | 'verifier' | 'reviewer';
export type RiskTier = 'low' | 'high';
export type FlowMode = 'READ_ONLY' | 'INLINE' | 'COORDINATED';
export type TaskStatus = 'QUEUED' | 'CLAIMED' | 'WAITING_INPUT' | 'DONE' | 'FAILED' | 'CANCELLED';
export interface FlowSignals {
  requirementsClear: boolean;
  resumableFromDiff: boolean;
  risk: RiskTier;
  unknownCodeArea: boolean;
  independentWorkUnits: number;
  writesAuthorized: boolean;
}
export interface RouteDecision {
  mode: FlowMode;
  requireTracking: boolean;
  requireIndependentVerifier: boolean;
  recommendedRoles: AgentRole[];
  rationale: string[];
}
export interface AgentDefinition {
  role: AgentRole;
  objective: string;
  permissions: 'read-only' | 'scoped-write';
  handoff: string;
}
export const AGENT_ROLES: AgentDefinition[] = [
  { role: 'scout', objective: 'Map existing behavior and affected paths; do not modify code.', permissions: 'read-only', handoff: 'Relevant path:line references, current invariants, risks and next investigative action.' },
  { role: 'designer', objective: 'Propose bounded design and acceptance checks without changing source.', permissions: 'read-only', handoff: 'Constraints, smallest viable implementation approach and acceptance criteria.' },
  { role: 'builder', objective: 'Implement one authorized, isolated unit of behavior with its tests and documentation.', permissions: 'scoped-write', handoff: 'Changed paths, commit/diff reference, focused test evidence and residual risk.' },
  { role: 'verifier', objective: 'Independently test a frozen candidate against the original request.', permissions: 'read-only', handoff: 'Candidate hash, executed checks, observed outcomes and reproducible failures.' },
  { role: 'reviewer', objective: 'Review a frozen candidate for correctness, readability, safety and maintainability.', permissions: 'read-only', handoff: 'Candidate hash, actionable findings, severity and approval/rejection.' },
];

export function routeFlow(input: FlowSignals): RouteDecision {
  if (!Number.isInteger(input.independentWorkUnits) || input.independentWorkUnits < 0 || input.independentWorkUnits > 32)
    throw new Error('independentWorkUnits must be an integer from 0 to 32');
  const rationale: string[] = [];
  const small = input.requirementsClear && input.resumableFromDiff && input.risk === 'low' &&
    !input.unknownCodeArea && input.independentWorkUnits <= 1;
  const mode: FlowMode = !input.writesAuthorized ? 'READ_ONLY' : small ? 'INLINE' : 'COORDINATED';
  if (!input.writesAuthorized) rationale.push('No implementation authorization: exploration only.');
  if (!input.requirementsClear || input.unknownCodeArea) rationale.push('Discovery needs focused read-only exploration.');
  if (!input.resumableFromDiff) rationale.push('Progress needs an exact durable specification and handoffs.');
  if (input.risk === 'high') rationale.push('High-risk changes require an independent verifier.');
  if (input.independentWorkUnits >= 2) rationale.push('Independent units can use distinct scoped builders.');
  if (small && input.writesAuthorized) rationale.push('Contained change: execute inline with focused checks.');
  const recommendedRoles: AgentRole[] = [];
  if (input.unknownCodeArea || !input.requirementsClear) recommendedRoles.push('scout');
  if (!input.requirementsClear) recommendedRoles.push('designer');
  if (input.writesAuthorized && mode === 'COORDINATED' && input.independentWorkUnits >= 2) recommendedRoles.push('builder');
  if (input.writesAuthorized && input.risk === 'high') recommendedRoles.push('verifier');
  return { mode, requireTracking: !input.resumableFromDiff,
    requireIndependentVerifier: input.writesAuthorized && input.risk === 'high',
    recommendedRoles, rationale };
}

export interface AgentFlow {
  id: string; missionId: string; spec: string; signals: FlowSignals; route: RouteDecision;
  reviewRequired: boolean; candidateSha: string | null;
  revision: number; state: 'OPEN' | 'CLOSED'; createdAt: string; updatedAt: string;
}
export interface AgentResult {
  summary: string;
  evidence: string[];
  candidateSha?: string;
  approved?: boolean;
}
export interface AgentTask {
  id: string; flowId: string; role: AgentRole; target: string;
  objective: string; scopes: string[]; workspace: string; dependsOn: string[];
  state: TaskStatus; leaseGeneration: number; leaseUntil: string | null; claimedBy: string | null;
  question: string | null; answer: string | null;
  result: AgentResult | null; completedBy: string | null;
  idempotencyKey: string; createdAt: string; updatedAt: string;
}
interface AgentState { version: 1; flows: AgentFlow[]; tasks: AgentTask[] }
function requireThat(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function normalizedPath(path: string): string {
  requireThat(path.length <= 256 && path.length > 0 && !path.startsWith('/') && !path.includes('\\') && !path.includes('\0'), 'Unsafe edit scope');
  const parts = path.normalize('NFC').replace(/\/$/, '').split('/');
  requireThat(parts.every(p => p && p !== '.' && p !== '..' && !/[\*?\[\]{}]/.test(p)), 'Unsafe or wildcard edit scope');
  return parts.join('/');
}
function overlaps(a: string, b: string) { return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`); }
function contentHash(text: string) { return createHash('sha256').update(text).digest('hex'); }
function nowIso() { return new Date().toISOString(); }

/** Single-process atomic JSON state. Deploy one replica until a transactional DB adapter is available. */
export class AgentEngine {
  private state: AgentState = { version: 1, flows: [], tasks: [] };
  private chain: Promise<unknown> = Promise.resolve();
  private readonly sqlite: SqliteLedger;
  private constructor(dataDir: string, private readonly missions: PanterStore) {
    this.sqlite = SqliteLedger.open(dataDir);
  }
  static async open(dataDir: string, missions: PanterStore): Promise<AgentEngine> {
    const engine = new AgentEngine(dataDir, missions);
    const data: unknown = engine.sqlite.read('agents', engine.state);
    requireThat(!!data && typeof data === 'object' && 'version' in data && data.version === 1 &&
      'flows' in data && Array.isArray(data.flows) && 'tasks' in data && Array.isArray(data.tasks), 'Invalid agent state');
    engine.state = data as AgentState;
    return engine;
  }

  private write<T>(fn: (state: AgentState) => T): Promise<T> {
    const pending = this.chain.then(() => {
      const { after, result } = this.sqlite.mutate('agents', this.state, fn);
      this.state = after;
      return result;
    });
    this.chain = pending.then(() => undefined, () => undefined);
    return pending;
  }
  private async read<T>(fn: (state: AgentState) => T): Promise<T> {
    await this.chain;
    this.state = this.sqlite.read('agents', this.state);
    return structuredClone(fn(this.state));
  }

  async createFlow(missionId: string, spec: string, signals: FlowSignals, reviewRequired = false): Promise<AgentFlow> {
    requireThat(!!(await this.missions.getMission(missionId)), 'Mission not found');
    requireThat(spec.trim().length > 0 && spec.length <= 30000, 'Spec length must be 1..30000');
    const route = routeFlow(signals);
    return this.write(state => {
      const date = nowIso();
      const flow: AgentFlow = { id: randomUUID(), missionId, spec, signals, route,
        reviewRequired, candidateSha: null, revision: 1, state: 'OPEN', createdAt: date, updatedAt: date };
      state.flows.push(flow);
      return flow;
    });
  }
  getFlow(flowId: string) { return this.read(state => state.flows.find(f => f.id === flowId) ?? null); }
  listFlows(missionId?: string) { return this.read(state => state.flows.filter(f => !missionId || f.missionId === missionId)); }
  listTasks(flowId: string) { return this.read(state => state.tasks.filter(t => t.flowId === flowId)); }
  getTask(taskId: string) { return this.read(state => state.tasks.find(t => t.id === taskId) ?? null); }
  async addTask(input: {
    flowId: string; role: AgentRole; target: string; objective: string; dependsOn?: string[];
    scopes?: string[]; workspace?: string; idempotencyKey: string;
  }): Promise<AgentTask> {
    const scopes = [...new Set((input.scopes ?? []).map(normalizedPath))];
    const dependsOn = [...new Set(input.dependsOn ?? [])];
    const workspace = input.workspace || 'default';
    requireThat(!!input.target.trim() && input.target.length <= 100 && !!input.objective.trim() && input.objective.length <= 10000, 'Invalid agent instruction');
    requireThat(!!input.idempotencyKey.trim() && input.idempotencyKey.length <= 160, 'Invalid idempotency key');
    requireThat(workspace.length <= 100 && /^[\w.-]+$/.test(workspace), 'Invalid workspace');
    requireThat(scopes.length <= 32, 'Too many edit scopes');
    if (input.role === 'builder') requireThat(scopes.length > 0, 'Builder must name its allowed edit scopes');
    else requireThat(scopes.length === 0, 'Read-only agent cannot reserve edit scopes');
    return this.write(state => {
      const flow = state.flows.find(f => f.id === input.flowId);
      requireThat(flow && flow.state === 'OPEN', 'Flow is not open');
      requireThat(input.role !== 'builder' || flow.signals.writesAuthorized, 'Implementation has not been authorized');
      requireThat(input.role !== 'builder' || !flow.candidateSha, 'Candidate frozen: a new builder requires a fresh boundary');
      const duplicate = state.tasks.find(t => t.flowId === input.flowId && t.idempotencyKey === input.idempotencyKey);
      if (duplicate) {
        const original = [duplicate.role, duplicate.target, duplicate.objective, duplicate.workspace,
          JSON.stringify(duplicate.scopes), JSON.stringify(duplicate.dependsOn)].join('\n');
        const proposed = [input.role, input.target, input.objective, workspace,
          JSON.stringify(scopes), JSON.stringify(dependsOn)].join('\n');
        requireThat(contentHash(original) === contentHash(proposed), 'Agent task idempotency conflict');
        return duplicate;
      }
      for (const parentId of dependsOn) requireThat(state.tasks.some(t => t.flowId === input.flowId && t.id === parentId), 'Unknown or cross-flow task dependency');
      if (input.role === 'builder') {
        const conflicts = state.tasks.filter(t => t.flowId === input.flowId && t.role === 'builder' &&
          t.workspace === workspace && t.state !== 'CANCELLED' && t.state !== 'FAILED');
        requireThat(!conflicts.some(t => t.scopes.some(a => scopes.some(b => overlaps(a, b)))), 'Overlapping writer scope in same workspace');
      }
      const date = nowIso();
      const task: AgentTask = { id: randomUUID(), flowId: input.flowId, role: input.role, target: input.target,
        objective: input.objective, scopes, workspace, dependsOn,
        state: 'QUEUED', leaseGeneration: 0, leaseUntil: null, claimedBy: null,
        question: null, answer: null, result: null, completedBy: null,
        idempotencyKey: input.idempotencyKey, createdAt: date, updatedAt: date };
      state.tasks.push(task);
      return task;
    });
  }
  /** Claims only dependency-ready tasks. No wake or model execution is implied. */
  claim(target: string, workerId: string, leaseSeconds = 300): Promise<AgentTask | null> {
    requireThat(!!target && !!workerId && workerId.length <= 100, 'Target and worker identity required');
    requireThat(Number.isInteger(leaseSeconds) && leaseSeconds >= 30 && leaseSeconds <= 3600, 'Invalid lease duration');
    return this.write(state => {
      const date = Date.now();
      const task = state.tasks.find(t => {
        if (t.target !== target || !['QUEUED', 'CLAIMED'].includes(t.state)) return false;
        if (t.state === 'CLAIMED' && (!t.leaseUntil || Date.parse(t.leaseUntil) > date)) return false;
        const flow = state.flows.find(f => f.id === t.flowId);
        if (!flow || flow.state !== 'OPEN') return false;
        if (['verifier', 'reviewer'].includes(t.role) && !flow.candidateSha) return false;
        return t.dependsOn.every(id => state.tasks.find(parent => parent.id === id)?.state === 'DONE');
      });
      if (!task) return null;
      task.state = 'CLAIMED'; task.claimedBy = workerId; task.leaseGeneration += 1;
      task.leaseUntil = new Date(date + leaseSeconds * 1000).toISOString(); task.updatedAt = nowIso();
      return task;
    });
  }
  private active(state: AgentState, taskId: string, workerId: string, generation: number): AgentTask {
    const task = state.tasks.find(t => t.id === taskId);
    requireThat(task, 'Agent task not found');
    requireThat(task.state === 'CLAIMED' && task.claimedBy === workerId, 'Task not claimed by worker');
    requireThat(task.leaseGeneration === generation, 'Stale agent lease');
    requireThat(!!task.leaseUntil && Date.parse(task.leaseUntil) > Date.now(), 'Agent lease expired');
    return task;
  }
  heartbeat(taskId: string, workerId: string, generation: number, leaseSeconds = 300) {
    requireThat(Number.isInteger(leaseSeconds) && leaseSeconds >= 30 && leaseSeconds <= 3600, 'Invalid lease duration');
    return this.write(state => {
      const task = this.active(state, taskId, workerId, generation);
      task.leaseUntil = new Date(Date.now() + leaseSeconds * 1000).toISOString(); task.updatedAt = nowIso();
      return task;
    });
  }
  ask(taskId: string, workerId: string, generation: number, question: string) {
    requireThat(!!question.trim() && question.length <= 3000, 'Invalid question');
    return this.write(state => {
      const task = this.active(state, taskId, workerId, generation);
      task.state = 'WAITING_INPUT'; task.question = question; task.leaseUntil = null;
      task.updatedAt = nowIso(); return task;
    });
  }
  answer(taskId: string, answer: string) {
    requireThat(!!answer.trim() && answer.length <= 5000, 'Invalid answer');
    return this.write(state => {
      const task = state.tasks.find(t => t.id === taskId);
      requireThat(task?.state === 'WAITING_INPUT', 'Agent task is not waiting for input');
      task.answer = answer; task.state = 'QUEUED'; task.claimedBy = null;
      task.updatedAt = nowIso(); return task;
    });
  }
  report(taskId: string, workerId: string, generation: number, result: AgentResult, success = true) {
    requireThat(!!result.summary.trim() && result.summary.length <= 10000, 'Invalid result summary');
    requireThat(Array.isArray(result.evidence) && result.evidence.length <= 40 && result.evidence.every(x => !!x.trim() && x.length <= 1000), 'Invalid evidence list');
    return this.write(state => {
      const task = this.active(state, taskId, workerId, generation);
      const flow = state.flows.find(f => f.id === task.flowId);
      requireThat(flow && flow.state === 'OPEN', 'Flow is not open');
      if (task.role === 'verifier' || task.role === 'reviewer') {
        requireThat(!!flow.candidateSha && result.candidateSha === flow.candidateSha, 'Result must reference the frozen candidate');
        requireThat(result.evidence.length > 0, 'Verification and reviews must include evidence references');
        const builders = state.tasks.filter(t => t.flowId === task.flowId && t.role === 'builder' && t.state === 'DONE');
        requireThat(builders.every(t => t.completedBy !== workerId), 'The implementer cannot independently verify or review own changes');
        if (task.role === 'reviewer') requireThat(typeof result.approved === 'boolean', 'Review must report approval decision');
      }
      task.result = result; task.state = success ? 'DONE' : 'FAILED';
      task.leaseUntil = null; task.completedBy = workerId; task.updatedAt = nowIso();
      return task;
    });
  }
  freezeCandidate(flowId: string, candidateSha: string, expectedRevision: number) {
    requireThat(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(candidateSha), 'Invalid candidate SHA');
    return this.write(state => {
      const flow = state.flows.find(f => f.id === flowId);
      requireThat(flow?.state === 'OPEN', 'Flow is not open');
      requireThat(flow.revision === expectedRevision, 'Stale flow revision');
      requireThat(!state.tasks.some(t => t.flowId === flowId && t.role === 'builder' && t.state !== 'DONE' && t.state !== 'CANCELLED'), 'Builders must finish before candidate freeze');
      requireThat(!state.tasks.some(t => t.flowId === flowId && ['verifier', 'reviewer'].includes(t.role) && t.state === 'CLAIMED'), 'Cannot change candidate during an active review');
      if (flow.candidateSha === candidateSha) return flow;
      flow.candidateSha = candidateSha; flow.revision += 1; flow.updatedAt = nowIso();
      for (const task of state.tasks.filter(t => t.flowId === flowId && ['verifier', 'reviewer'].includes(t.role))) {
        if (task.state === 'DONE' || task.state === 'FAILED') {
          task.state = 'QUEUED'; task.result = null; task.completedBy = null;
          task.leaseGeneration += 1; task.updatedAt = nowIso();
        }
      }
      return flow;
    });
  }
  closeFlow(flowId: string, expectedRevision: number) {
    return this.write(state => {
      const flow = state.flows.find(f => f.id === flowId);
      requireThat(flow?.state === 'OPEN', 'Flow is not open');
      requireThat(flow.revision === expectedRevision, 'Stale flow revision');
      const tasks = state.tasks.filter(t => t.flowId === flowId);
      requireThat(tasks.every(t => t.state === 'DONE' || t.state === 'CANCELLED'), 'Some tasks are unfinished or failed');
      const builders = tasks.filter(t => t.role === 'builder' && t.state === 'DONE');
      if (builders.length) requireThat(!!flow.candidateSha, 'Missing frozen candidate SHA');
      const verifiers = tasks.filter(t => t.role === 'verifier' && t.state === 'DONE');
      const reviewers = tasks.filter(t => t.role === 'reviewer' && t.state === 'DONE' && t.result?.approved === true);
      if (flow.route.requireIndependentVerifier) requireThat(verifiers.length > 0, 'High-risk flow requires independent verification');
      if (flow.reviewRequired) requireThat(reviewers.length > 0, 'Flow requires independent approval');
      requireThat(!tasks.some(t => t.role === 'reviewer' && t.state === 'DONE' && t.result?.approved === false), 'Blocking review rejection');
      flow.state = 'CLOSED'; flow.revision += 1; flow.updatedAt = nowIso();
      return flow;
    });
  }
  async packet(taskId: string) {
    const task = await this.getTask(taskId);
    if (!task) return null;
    const flow = await this.getFlow(task.flowId);
    requireThat(flow, 'Flow not found');
    const tasks = await this.listTasks(task.flowId);
    const role = AGENT_ROLES.find(r => r.role === task.role);
    return {
      assignmentId: task.id, role, target: task.target, objective: task.objective,
      specificationVerbatim: flow.spec,
      risk: flow.signals.risk,
      writeAuthorized: task.role === 'builder' && flow.signals.writesAuthorized,
      allowedEditScopes: task.scopes, workspace: task.workspace,
      frozenCandidateSha: flow.candidateSha,
      prerequisites: task.dependsOn.map(id => {
        const dep = tasks.find(t => t.id === id);
        return { id, role: dep?.role, state: dep?.state, handoff: dep?.result };
      }),
      question: task.question, answer: task.answer,
      instructions: 'Follow only this assignment. Do not broaden authority. Never claim a test or review without evidence. Return the result through panter_agent_complete; if blocked, use panter_agent_ask. A queued assignment is not an automatically running model.',
    };
  }
  async summary(flowId: string) {
    const flow = await this.getFlow(flowId);
    if (!flow) return null;
    const tasks = await this.listTasks(flowId);
    const counts = Object.fromEntries(['QUEUED','CLAIMED','WAITING_INPUT','DONE','FAILED','CANCELLED'].map(k => [k, tasks.filter(t => t.state === k).length]));
    return { flow, counts, tasks, modelWorkersStartedByServer: 0, wakeObserved: false,
      runtimeEvidence: 'host-reported-only; no direct model execution or wake verification' };
  }
}
