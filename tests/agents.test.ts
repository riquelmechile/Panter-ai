import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AGENT_ROLES, AgentEngine, routeFlow, type FlowSignals } from '../src/core/agents.js';
import { PanterStore } from '../src/core/store.js';

const signals: FlowSignals = { requirementsClear: true, resumableFromDiff: false, risk: 'high',
  unknownCodeArea: false, independentWorkUnits: 2, writesAuthorized: true };
const SHA1 = 'a'.repeat(40);
const SHA2 = 'b'.repeat(40);
async function fixture<T>(fn: (agents: AgentEngine, store: PanterStore, dir: string) => Promise<T>) {
  const dir = await mkdtemp(join(tmpdir(), 'panter-agent-test-'));
  try {
    const store = await PanterStore.open(dir);
    return await fn(await AgentEngine.open(dir, store), store, dir);
  } finally { await rm(dir, { recursive: true, force: true }); }
}

test('routes small changes inline, uncertain work to specialists, and prevents write without permission', () => {
  assert.equal(routeFlow({ ...signals, risk: 'low', resumableFromDiff: true, independentWorkUnits: 1 }).mode, 'INLINE');
  assert.equal(routeFlow({ ...signals, writesAuthorized: false }).mode, 'READ_ONLY');
  const decision = routeFlow(signals);
  assert.equal(decision.mode, 'COORDINATED');
  assert.equal(decision.requireIndependentVerifier, true);
  assert.equal(decision.requireTracking, true);
  assert.ok(AGENT_ROLES.some(r => r.role === 'scout' && r.permissions === 'read-only'));
});

test('verbatim specifications persist, agents claim dependencies, and leases are fenced', () => fixture(async (engine, store, dir) => {
  const mission = await store.createMission('demo', 'Add independent features');
  const specification = 'Implement API exactly: `POST /thing`, including accents áè and examples.';
  const flow = await engine.createFlow(mission.id, specification, signals, true);
  const scout = await engine.addTask({flowId: flow.id, role:'scout',target:'host',objective:'map behavior',idempotencyKey:'scout'});
  const builder = await engine.addTask({flowId: flow.id, role:'builder',target:'host',objective:'implement API',
    scopes:['src/api'], dependsOn:[scout.id], idempotencyKey:'build-1'});
  assert.equal((await engine.packet(builder.id))?.specificationVerbatim, specification);
  assert.deepEqual((await engine.packet(builder.id))?.prerequisites.map(x=>x.id), [scout.id]);
  await assert.rejects(engine.addTask({flowId: flow.id,role:'builder',target:'host',objective:'overlap',scopes:['src'],idempotencyKey:'conflict'}), /Overlapping writer scope/);
  await assert.rejects(engine.addTask({flowId: flow.id,role:'scout',target:'host',objective:'unsafe',scopes:['src'],idempotencyKey:'unsafe'}), /Read-only/);
  const claimed = await engine.claim('host', 'explorer');
  assert.equal(claimed?.id, scout.id);
  assert.equal((await engine.claim('host','writer')), null);
  await assert.rejects(engine.report(scout.id, 'explorer', 2, {summary:'mapped', evidence:[]}), /Stale agent lease/);
  await engine.report(scout.id, 'explorer', 1, {summary:'map complete',evidence:['src/api.ts:1']});
  const bclaim = await engine.claim('host','writer');
  assert.equal(bclaim?.id,builder.id);
  await engine.report(builder.id,'writer',bclaim!.leaseGeneration,{summary:'new API',evidence:['commit '+SHA1]});
  const verifier = await engine.addTask({flowId:flow.id, role:'verifier',target:'host',objective:'independent checks',dependsOn:[builder.id],idempotencyKey:'verify'});
  const reviewer = await engine.addTask({flowId:flow.id, role:'reviewer',target:'host',objective:'safety audit',dependsOn:[builder.id],idempotencyKey:'review'});
  assert.equal(await engine.claim('host','checker'), null);
  await assert.rejects(engine.closeFlow(flow.id, 1), /Missing frozen candidate|Some tasks/);
  const frozen = await engine.freezeCandidate(flow.id,SHA1,1);
  assert.equal(frozen.candidateSha,SHA1);
  const vclaim = await engine.claim('host','checker');
  assert.equal(vclaim?.id,verifier.id);
  await assert.rejects(engine.report(verifier.id,'checker',vclaim!.leaseGeneration,{summary:'checked',evidence:['CI run'],candidateSha:SHA2}), /frozen candidate/);
  await assert.rejects(engine.report(verifier.id,'checker',vclaim!.leaseGeneration,{summary:'checked',evidence:[],candidateSha:SHA1}), /evidence/);
  await engine.report(verifier.id,'checker',vclaim!.leaseGeneration,{summary:'all tests pass',evidence:['CI run 101'],candidateSha:SHA1});
  const rclaim = await engine.claim('host','reviewer-user');
  assert.equal(rclaim?.id,reviewer.id);
  await engine.report(reviewer.id,'reviewer-user',rclaim!.leaseGeneration,{summary:'approved',evidence:['review 22'],approved:true,candidateSha:SHA1});
  assert.equal((await engine.closeFlow(flow.id,2)).state,'CLOSED');
  const reopened = await AgentEngine.open(dir, store);
  assert.equal((await reopened.getFlow(flow.id))?.spec,specification);
  assert.equal((await reopened.summary(flow.id))?.counts.DONE, 4);
}));

test('candidate changes invalidate old reviews and reject implementer self-verification', () => fixture(async (engine,store) => {
  const m=await store.createMission('x','task');
  const flow=await engine.createFlow(m.id,'feature',signals,false);
  const b=await engine.addTask({flowId:flow.id,role:'builder',target:'h',objective:'write',scopes:['src/foo.ts'],idempotencyKey:'b'});
  const v=await engine.addTask({flowId:flow.id,role:'verifier',target:'h',objective:'verify',dependsOn:[b.id],idempotencyKey:'v'});
  await engine.claim('h','writer');
  await engine.report(b.id,'writer',1,{summary:'done',evidence:[]});
  await engine.freezeCandidate(flow.id,SHA1,1);
  const claim=await engine.claim('h','writer');
  assert.equal(claim?.id,v.id);
  await assert.rejects(engine.report(v.id,'writer',1,{summary:'checked',evidence:['ok'],candidateSha:SHA1}),/implementer cannot/);
  await engine.ask(v.id,'writer',1,'Need reviewer other than implementer');
  await engine.answer(v.id,'Use independent checker');
  await engine.claim('h','checker');
  await engine.report(v.id,'checker',2,{summary:'passed',evidence:['check id'],candidateSha:SHA1});
  await engine.freezeCandidate(flow.id,SHA2,2);
  assert.equal((await engine.getTask(v.id))?.state,'QUEUED');
  assert.equal((await engine.getTask(v.id))?.result,null);
  await assert.rejects(engine.closeFlow(flow.id,3), /unfinished/);
}));

test('locks down unsafe path scopes and duplicate assignment keys', () => fixture(async (engine,store) => {
  const m=await store.createMission('x','task');
  const flow=await engine.createFlow(m.id,'feature', signals, false);
  await assert.rejects(engine.addTask({flowId:flow.id,role:'builder',target:'h',objective:'write',scopes:['../etc'],idempotencyKey:'bad'}),/Unsafe/);
  const b=await engine.addTask({flowId:flow.id,role:'builder',target:'h',objective:'write',scopes:['src/a.ts'],idempotencyKey:'same'});
  assert.equal((await engine.addTask({flowId:flow.id,role:'builder',target:'h',objective:'write',scopes:['src/a.ts'],idempotencyKey:'same'})).id,b.id);
  await assert.rejects(engine.addTask({flowId:flow.id,role:'builder',target:'h',objective:'different',scopes:['src/a.ts'],idempotencyKey:'same'}),/idempotency conflict/);
  await assert.rejects(engine.addTask({flowId:flow.id,role:'scout',target:'h',objective:'wrong dependency',dependsOn:['f0000000-0000-0000-0000-000000000001'],idempotencyKey:'dep'}), /Unknown or cross-flow/);
}));

test('read-only work can only enqueue readers', () => fixture(async (engine,store) => {
  const m=await store.createMission('x','task');
  const flow=await engine.createFlow(m.id,'inspect', {...signals, writesAuthorized:false},false);
  await assert.rejects(engine.addTask({flowId:flow.id,role:'builder',target:'h',objective:'write',scopes:['src'],idempotencyKey:'x'}),/not been authorized/);
  const s=await engine.addTask({flowId:flow.id,role:'scout',target:'h',objective:'inspect',idempotencyKey:'s'});
  assert.equal(s.state,'QUEUED');
}));
