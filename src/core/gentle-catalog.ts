/** Version-pinned, read-only Gentle Shell assets hosted by Panter MCP.
 * Original upstream prompts remain reference material; Panter provides the
 * explicit host-native execution boundary and never starts Pi subprocesses.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export const GENTLE_UPSTREAM = {
  repository: 'https://github.com/Gentleman-Programming/gentle-shell',
  commit: '3210886c79360a9f47ac3ca0cd2c1edf43b2432e',
  license: 'MIT',
} as const;
export type SpecialistRole = 'explorer' | 'architect' | 'implementer' | 'verifier' | 'reviewer';
export type GentleAgentId = typeof GENTLE_AGENTS[number]['id'];
export type GentleSkillId = typeof GENTLE_SKILLS[number]['id'];

// All ten upstream agent definitions. Role is Panter's scoped-execution role;
// upstream names are retained for attribution and reversible mappings.
export const GENTLE_AGENTS = [
  { id: 'gentle-ai-explore', role: 'explorer', summary: 'Read-only codebase exploration', defaultSkills: ['gentle-ai'] },
  { id: 'gentle-ai-worker', role: 'implementer', summary: 'Bounded implementation and test-first changes', defaultSkills: ['gentle-ai','work-unit-commits'] },
  { id: 'gentle-ai-verify', role: 'verifier', summary: 'Independent verification of a frozen candidate', defaultSkills: ['gentle-ai'] },
  { id: 'review-risk', role: 'reviewer', summary: 'R1 risk and security review', defaultSkills: [] },
  { id: 'review-readability', role: 'reviewer', summary: 'R2 readability review', defaultSkills: [] },
  { id: 'review-reliability', role: 'reviewer', summary: 'R3 reliability review', defaultSkills: [] },
  { id: 'review-resilience', role: 'reviewer', summary: 'R4 resilience review', defaultSkills: [] },
  { id: 'jd-judge-a', role: 'reviewer', summary: 'Judgment Day blind judge A', defaultSkills: ['judgment-day'] },
  { id: 'jd-judge-b', role: 'reviewer', summary: 'Judgment Day blind judge B', defaultSkills: ['judgment-day'] },
  { id: 'jd-fix-agent', role: 'implementer', summary: 'Judgment Day scoped correction', defaultSkills: ['judgment-day'] },
] as const satisfies ReadonlyArray<{ id: string; role: SpecialistRole; summary: string; defaultSkills: readonly string[] }>;

// All thirteen upstream skills, stored and versioned centrally on the MCP.
export const GENTLE_SKILLS = [
  {id:'branch-pr',summary:'Branch and pull-request lifecycle'},
  {id:'chained-pr',summary:'Dependency-aware chained pull requests'},
  {id:'cognitive-doc-design',summary:'Design of readable context documents'},
  {id:'comment-writer',summary:'Human-facing review and comments'},
  {id:'design',summary:'Design workflow and visual decisions'},
  {id:'gentle-ai',summary:'ODD execution and verification discipline'},
  {id:'issue-creation',summary:'Scoped issue creation and delegation'},
  {id:'judgment-day',summary:'Two blind judges and bounded correction rounds'},
  {id:'rdd-defect-workflow',summary:'Risk-driven defect review workflow'},
  {id:'skill-creator',summary:'Author reusable, bounded skills'},
  {id:'skill-improver',summary:'Review and refine an existing skill'},
  {id:'skill-registry',summary:'Discover and index installed skills'},
  {id:'work-unit-commits',summary:'Resumable work-unit commits'},
] as const;

export const REVIEW_4R = ['review-risk','review-readability','review-reliability','review-resilience'] as const;
export const JUDGMENT_DAY = ['jd-judge-a','jd-judge-b','jd-fix-agent'] as const;
const ids = new Set<string>(GENTLE_AGENTS.map(x=>x.id));
const skillIds = new Set<string>(GENTLE_SKILLS.map(x=>x.id));
export function isGentleAgent(value: string): value is GentleAgentId { return ids.has(value); }
export function isGentleSkill(value: string): value is GentleSkillId { return skillIds.has(value); }
export function agentDefinition(id: string) { return GENTLE_AGENTS.find(x=>x.id===id) ?? null; }
export function skillDefinition(id: string) { return GENTLE_SKILLS.find(x=>x.id===id) ?? null; }
export function gentleCatalog() { return { source:GENTLE_UPSTREAM, agents:GENTLE_AGENTS, skills:GENTLE_SKILLS, review4r:REVIEW_4R, judgmentDay:JUDGMENT_DAY }; }
const sha = (s:string) => createHash('sha256').update(s).digest('hex');
const MAX_ASSET_BYTES = 90_000;
async function asset(path: string):Promise<string> {
  // Only paths assembled from a fixed allowlisted manifest reach this function.
  const content = await readFile(resolve('vendor/gentle-shell',path),'utf8');
  if (Buffer.byteLength(content,'utf8')>MAX_ASSET_BYTES) throw new Error('Catalog asset exceeds limit');
  return content;
}
export function checkSkills(requested:readonly string[]):GentleSkillId[] {
  if (requested.length>8) throw new Error('Too many skills for one agent');
  if (new Set(requested).size!==requested.length || !requested.every(isGentleSkill)) throw new Error('Unknown or repeated catalog skill');
  return requested as GentleSkillId[];
}
export async function readAgent(id: string) {
  if (!isGentleAgent(id)) throw new Error('Unknown agent');
  const text = await asset(`assets/agents/${id}.md`);
  return {id, text, digest:sha(text), source:GENTLE_UPSTREAM};
}
export async function readSkill(id:string) {
  if (!isGentleSkill(id)) throw new Error('Unknown skill');
  const text=await asset(`skills/${id}/SKILL.md`);
  return {id,text,digest:sha(text),source:GENTLE_UPSTREAM};
}
export interface SpecialistPacket {
  agentId: GentleAgentId;
  role: SpecialistRole;
  skillIds: GentleSkillId[];
  modelRequest: string;
  effortRequest: string;
  instruction: string;
  digest: string;
  assetDigests: Record<string,string>;
  allowedEditSurfaces: string[];
}
/** Frozen, immutable handoff: skills are injected just-in-time, not every turn.
 * Skills and upstream prompts are *instructions*, not executable capabilities.
 * Host-native clients enforce their own permissions and tools.
 */
export async function specialistPacket(input:{agentId:string; skillIds:readonly string[]; objective:string; modelRequest:string; effortRequest:string; candidateSha?:string; allowedEditSurfaces?:string[]}):Promise<SpecialistPacket> {
  const definition=agentDefinition(input.agentId);
  if (!definition) throw new Error('Unknown agent');
  if (!input.objective.trim() || input.objective.length>6000) throw new Error('Invalid specialist objective');
  const skills=checkSkills(input.skillIds);
  const surfaces=input.allowedEditSurfaces??[];
  if(surfaces.length>16 || surfaces.some(x=>!x || x.length>256 || x.startsWith('/') || /[\x00-\x1f\x7f]/.test(x) || x.includes('\\') || x.split('/').some(part=>!part || part==='.' || part==='..' || /[\*?\[\]{}]/.test(part))))throw new Error('Invalid edit surfaces');
  if(definition.role==='implementer' && surfaces.length===0)throw new Error('Implementer needs explicit allowed edit surfaces');
  if(definition.role!=='implementer' && surfaces.length>0)throw new Error('Read-only agent cannot reserve write surfaces');
  if (input.candidateSha && !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(input.candidateSha)) throw new Error('Invalid frozen candidate SHA');
  if ((definition.id.startsWith('review-') || definition.id==='gentle-ai-verify' || definition.id.startsWith('jd-judge')) && !input.candidateSha)
    throw new Error('Independent review requires a frozen candidate SHA');
  const agent=await readAgent(definition.id);
  const parts=[
    '# Panter-ai external-host specialist contract',
    `Role: ${definition.role}. Specialist: ${definition.id}. Requested model: ${input.modelRequest}; effort: ${input.effortRequest}.`,
    'IMPORTANT: This is an MCP-delivered skill packet, NOT a local Pi session. Ignore upstream Pi CLI, local-child-spawn, Engram, TUI and native review provider specifics that are not exposed by your actual host. Do not claim them to be available. Never call a model-provider API. Treat these assets as task instructions only, NOT grants to tools, write scopes, git push or deployment.',
    'Never spawn nested agents on behalf of another actor. Do only explicitly authorized work. Return findings/evidence via Panter A2A work completion, not direct chat to another user.',
    `Objective: ${input.objective}`,
    definition.role==='implementer' ? `Allowed edit surfaces (planning scope, never actual tool permission): ${surfaces.join(', ')}` : 'Read-only specialist; do not alter files or system state.',
    input.candidateSha?`Frozen candidate SHA: ${input.candidateSha}. Verify this exact revision; do not replace it.`:'',
    `## Specialist definition (${definition.id})\n${agent.text}`,
  ];
  const assetDigests:Record<string,string>={[definition.id]:agent.digest};
  for (const id of skills){
    const skill=await readSkill(id);
    parts.push(`## Skill (${id})\n${skill.text}`);
    assetDigests[`skill:${id}`]=skill.digest;
  }
  const instruction=parts.filter(Boolean).join('\n\n');
  if (instruction.length>50_000) throw new Error('Specialist packet exceeds bound; choose fewer skills');
  return {agentId:definition.id,role:definition.role,skillIds:skills,modelRequest:input.modelRequest,effortRequest:input.effortRequest,instruction,digest:sha(instruction),assetDigests,allowedEditSurfaces:surfaces};
}
