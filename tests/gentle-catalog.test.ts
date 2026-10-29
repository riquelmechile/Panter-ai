import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GENTLE_AGENTS, GENTLE_SKILLS, REVIEW_4R, JUDGMENT_DAY, checkSkills, gentleCatalog, readAgent, readSkill, specialistPacket } from '../src/core/gentle-catalog.js';
import { MeshEngine } from '../src/core/mesh.js';

const SHA='a'.repeat(40);
async function withMesh(fn:(m:MeshEngine)=>Promise<void>) {
  const dir=await mkdtemp(join(tmpdir(),'panter-gentle-'));
  try{await fn(await MeshEngine.open(dir))}finally{await rm(dir,{recursive:true,force:true})}
}
const p={host:'claude' as const,actorId:'actor-claude',modelRequest:'host-default',effortRequest:'max',roles:['reviewer' as const,'implementer' as const]};

test('all pinned Gentle Shell agent and skill names are unique',()=>{
  const catalog=gentleCatalog();
  assert.equal(GENTLE_AGENTS.length,10);assert.equal(GENTLE_SKILLS.length,13);
  assert.equal(new Set(GENTLE_AGENTS.map(x=>x.id)).size,10);
  assert.equal(new Set(GENTLE_SKILLS.map(x=>x.id)).size,13);
  assert.deepEqual([...REVIEW_4R],['review-risk','review-readability','review-reliability','review-resilience']);
  assert.deepEqual([...JUDGMENT_DAY],['jd-judge-a','jd-judge-b','jd-fix-agent']);
  assert.equal(catalog.source.license,'MIT');
  assert.throws(()=>checkSkills(['not-installed']),/Unknown/);
  assert.throws(()=>checkSkills(['gentle-ai','gentle-ai']),/repeated/);
});

test('the MCP repository ships the versioned upstream prompts and skills',async()=>{
  const a=await readAgent('review-risk');const skill=await readSkill('gentle-ai');
  assert.match(a.text,/review-risk/i);
  assert.match(skill.text,/gentle-ai/i);
  assert.match(a.digest,/^[0-9a-f]{64}$/);
  await assert.rejects(readAgent('../secret'),/Unknown agent/);
  await assert.rejects(readSkill('x/../../secret'),/Unknown skill/);
});

test('only GPT-A can CAS-bind specialist to an independent authenticated host',()=>withMesh(async m=>{
  const binding={agentId:'review-risk',host:'claude' as const,modelRequest:'requested-model',effortRequest:'max',skillIds:['gentle-ai']};
  assert.throws(()=>m.bindSpecialist('grok',binding,0),/Only GPT-A/);
  const b=await m.bindSpecialist('gpt-a',binding,0);assert.equal(b.revision,1);
  await assert.rejects(m.bindSpecialist('gpt-a',binding,0),/Stale/);
  assert.throws(()=>m.bindSpecialist('gpt-a',{...binding,agentId:'fake-agent'},0),/Unknown catalog/);
  assert.throws(()=>m.bindSpecialist('gpt-a',{...binding,host:'gpt-a'},0),/worker host/);
}));

test('a bound reviewer receives only its assigned MCP skills with frozen evidence and returns via A2A',()=>withMesh(async m=>{
  await m.setProfile('gpt-a',p,0);
  await m.bindSpecialist('gpt-a',{agentId:'review-risk',host:'claude',modelRequest:'host-default',effortRequest:'high',skillIds:['gentle-ai']},0);
  await assert.rejects(m.delegateBoundSpecialist('gpt-a',{missionId:'mission1',agentId:'review-risk',objective:'Review the frozen patch',idempotencyKey:'r1'}),/frozen candidate SHA/);
  const input={missionId:'mission1',agentId:'review-risk',objective:'Review the frozen patch',candidateSha:SHA,idempotencyKey:'r1'};
  const w=await m.delegateBoundSpecialist('gpt-a',input);
  assert.equal(w.specialist?.agentId,'review-risk');
  assert.deepEqual(w.specialist?.skillIds,['gentle-ai']);
  assert.equal(w.specialist?.bindingRevision,1);
  assert.match(w.instruction,/review-risk/);
  assert.match(w.instruction,/Frozen candidate SHA/);
  assert.ok(w.instruction.includes('MCP-delivered skill packet'));
  assert.equal((await m.delegateBoundSpecialist('gpt-a',input)).id,w.id);
  await assert.rejects(m.claim('grok',w.id),/not found/);
  const work=await m.claim('claude',w.id);
  await m.complete('claude',w.id,work.attemptId!,work.leaseGeneration,'Findings attached');
  const inbox=await m.inbox('gpt-a');
  assert.equal(inbox.messages.at(-1)?.text,'Findings attached');
}));

test('implementers need narrow scopes and cannot reserve overlapping files',()=>withMesh(async m=>{
  await m.setProfile('gpt-a',p,0);
  await m.bindSpecialist('gpt-a',{agentId:'gentle-ai-worker',host:'claude',modelRequest:'host-default',effortRequest:'max',skillIds:[]},0);
  const base={missionId:'m2',agentId:'gentle-ai-worker',objective:'Write focused tests and code'};
  await assert.rejects(m.delegateBoundSpecialist('gpt-a',{...base,idempotencyKey:'one'}),/edit surfaces/);
  await assert.rejects(m.delegateBoundSpecialist('gpt-a',{...base,idempotencyKey:'one',allowedEditSurfaces:['../secrets']}),/Invalid edit surfaces/);
  const w=await m.delegateBoundSpecialist('gpt-a',{...base,idempotencyKey:'one',allowedEditSurfaces:['src/core']});
  assert.deepEqual(w.specialist?.allowedEditSurfaces,['src/core']);
  await assert.rejects(m.delegateBoundSpecialist('gpt-a',{...base,idempotencyKey:'two',allowedEditSurfaces:['src/core/secret.ts']}),/Overlapping active writer/);
}));

test('Judgment Day judges cannot receive an unbound review of an unknown SHA',async()=>{
  await assert.rejects(specialistPacket({agentId:'jd-judge-a',skillIds:['judgment-day'],objective:'Review candidate',modelRequest:'host',effortRequest:'max'}),/frozen candidate SHA/);
});
