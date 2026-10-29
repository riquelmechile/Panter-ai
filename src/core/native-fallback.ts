/** GPT-A-only host-native fallback. Plans work; never starts AI inference or fabricates native workers. */
import { agentDefinition, checkSkills, gentleCatalog, readOrchestratorSection, specialistPacket, type GentleAgentId } from './gentle-catalog.js';
import { routeFlow, type FlowSignals } from './agents.js';
import { HOSTS, type Host, type SpecialistBinding } from './mesh.js';

export type PeerState = 'CONNECTED' | 'UNAVAILABLE' | 'UNKNOWN';
export type HostNativeCapabilities = {
  nativeSubagents: boolean;
  maxParallelSubagents: number;
  toolsAvailable: boolean;
  evidence: 'HOST_REPORTED_UNVERIFIED';
};
export type NativeExecution = 'REMOTE_A2A' | 'GPT_A_NATIVE_SUBAGENT' | 'GPT_A_INLINE' | 'BLOCKED_AUTHORIZATION' | 'BLOCKED_TOOLS';
export type NativeAssignment = {
  agentId: GentleAgentId; host: Host; execution: NativeExecution; skillIds: string[];
  modelRequest: string; effortRequest: string; concurrentGroup: number;
  instructions: string; reason: string;
};

/** Explicit availability is ephemeral and host-reported, NEVER inferred from configured bindings. */
export function planHostNative(input: {
  signals: FlowSignals;
  assignments: Array<{ agentId:string; objective:string; allowedEditSurfaces?:string[]; candidateSha?:string }>;
  bindings: SpecialistBinding[];
  peerStates: Partial<Record<Host,PeerState>>;
  capabilities: HostNativeCapabilities;
}) {
  const { signals,capabilities }=input;
  const route=routeFlow(signals);
  if(!Number.isInteger(capabilities.maxParallelSubagents)||capabilities.maxParallelSubagents<0||capabilities.maxParallelSubagents>32)
    throw new Error('Invalid host-native worker count');
  if(input.assignments.length===0||input.assignments.length>32)throw new Error('Invalid assignment count');
  const configured = new Map(input.bindings.map(x=>[x.agentId,x]));
  const workerSlots=capabilities.nativeSubagents?Math.min(capabilities.maxParallelSubagents,route.mode==='COORDINATED'?input.assignments.length:1):0;
  // Distinct native worker slots are NOT a filesystem isolation guarantee.
  // Reject conflicting parallel writer scopes before recommending fanout.
  const writers=input.assignments.filter(a=>agentDefinition(a.agentId)?.role==='implementer'&&a.allowedEditSurfaces?.length);
  for(let i=0;i<writers.length;i++)for(let j=i+1;j<writers.length;j++){
    const a=writers[i]!.allowedEditSurfaces!,b=writers[j]!.allowedEditSurfaces!;
    if(a.some(p=>b.some(q=>p===q||p.startsWith(q+'/')||q.startsWith(p+'/'))))
      throw new Error('Overlapping native writer scopes require sequential or isolated worktrees');
  }
  const assignments=input.assignments.map((a,index)=>{
    const agent=agentDefinition(a.agentId);
    if(!agent)throw new Error(`Unknown specialist: ${a.agentId}`);
    if(!a.objective.trim()||a.objective.length>6000)throw new Error('Invalid objective');
    const binding=configured.get(a.agentId);
    const host=binding?.host;
    const available=!!host && input.peerStates[host]==='CONNECTED';
    const needsWrite=agent.role==='implementer';
    const execution:NativeExecution = (needsWrite&&!signals.writesAuthorized)?'BLOCKED_AUTHORIZATION':
      (route.mode!=='READ_ONLY'&&available)?'REMOTE_A2A':
      (!capabilities.toolsAvailable)?'BLOCKED_TOOLS':
      (route.mode!=='READ_ONLY'&&workerSlots>0&&input.assignments.length>1)?'GPT_A_NATIVE_SUBAGENT':'GPT_A_INLINE';
    const chosenHost=execution==='REMOTE_A2A'?host!:'gpt-a';
    const group=execution==='GPT_A_NATIVE_SUBAGENT'?index%Math.max(workerSlots,1):0;
    return {
      agentId:agent.id,host:chosenHost,execution,skillIds:checkSkills(binding?.skillIds??[...agent.defaultSkills]),
      modelRequest:binding?.modelRequest??'inherit-host-model', effortRequest:binding?.effortRequest??'inherit-host-effort',
      concurrentGroup:group,
      instructions:a.objective,
      reason:execution==='REMOTE_A2A'?'An independently authenticated remote host is reported connected.':
        execution==='BLOCKED_AUTHORIZATION'?'Writes were not authorized.':
        execution==='BLOCKED_TOOLS'?'The host has no tools to execute this work.':
        execution==='GPT_A_NATIVE_SUBAGENT'?'GPT-A may request a native subagent if its host exposes one.':
        'GPT-A performs this specialist phase inline, without a remote workforce.',
    } satisfies NativeAssignment;
  });
  return {
    mode:route.mode,route,assignments,requestedSubagentSlots:workerSlots,
    hostReportedEvidence:capabilities.evidence,serverWorkersStarted:0,
    instructions:'GPT-A remains the only orchestrator. In inline mode, load the corresponding MCP skills and execute each phase using the connected host tools. Native subagents and parallel execution are optional host capabilities, not server actions. Never claim independent review of your own changes; use external native RDD or mark verification pending. Peer UNKNOWN means unavailable for routing. Never re-dispatch expired writes with unknown outcome.',
    upstream:gentleCatalog().source,
  };
}

/** On demand: returns the same frozen skill packet used by remote collaborators,
 * but addressed to GPT-A for inline/native-subagent execution. No peer binding required. */
export async function nativePacket(input:{agentId:string;objective:string;candidateSha?:string;allowedEditSurfaces?:string[];skillIds?:string[];modelRequest?:string;effortRequest?:string}){
  const agent=agentDefinition(input.agentId);
  if(!agent)throw new Error('Unknown native fallback agent');
  const packet=await specialistPacket({agentId:input.agentId,objective:input.objective,
    skillIds:input.skillIds??[...agent.defaultSkills],candidateSha:input.candidateSha,
    allowedEditSurfaces:input.allowedEditSurfaces,modelRequest:input.modelRequest??'inherit-host-model',effortRequest:input.effortRequest??'inherit-host-effort'});
  return {...packet,executionOwner:'gpt-a' as const,
    notice:'GPT-A must execute using its own host tools or explicitly available native subagents. This packet does not launch a worker, create a verified reviewer, or grant write privileges.'};
}

export async function nativeOddInstructions(){
  // Load lazily so normal requests do not spend tokens on the entire handbook.
  return readOrchestratorSection('orchestrator');
}
