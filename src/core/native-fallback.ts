/** GPT-A-only host-native fallback. Plans work; never starts AI inference or fabricates native workers. */
import { agentDefinition, checkSkills, gentleCatalog, readOrchestratorSection, specialistPacket, type GentleAgentId } from './gentle-catalog.js';
import { routeFlow, type FlowSignals } from './agents.js';
import { type Host, type SpecialistBinding } from './mesh.js';
import { hostRequest } from './policy.js';

export type PeerState = 'CONNECTED' | 'UNAVAILABLE' | 'UNKNOWN';
export type CoordinationMode = 'AUTO' | 'GPT_A_ONLY';
export type HostNativeCapabilities = {
  nativeSubagents: boolean;
  maxParallelSubagents: number;
  toolsAvailable: boolean;
  evidence: 'HOST_REPORTED_UNVERIFIED';
  /** Unverified host telemetry. Never accepted as proof of actual model execution. */
  observedModel?: string;
  observedReasoningEffort?: string;
  observedWorkerProcessing?: string;
};
export type NativeExecution = 'REMOTE_A2A' | 'GPT_A_NATIVE_SUBAGENT' | 'GPT_A_INLINE' | 'BLOCKED_AUTHORIZATION' | 'BLOCKED_TOOLS';
export type NativeAssignment = {
  agentId: GentleAgentId; host: Host; execution: NativeExecution; skillIds: string[];
  modelRequest: string; effortRequest: string; speedRequest: string; concurrentGroup: number;
  instructions: string; reason: string;
};

/** Explicit availability is ephemeral and host-reported, NEVER inferred from configured bindings. */
export function planHostNative(input: {
  signals: FlowSignals;
  assignments: Array<{ agentId:string; objective:string; allowedEditSurfaces?:string[]; candidateSha?:string }>;
  bindings: SpecialistBinding[];
  peerStates: Partial<Record<Host,PeerState>>;
  capabilities: HostNativeCapabilities;
  coordinationMode?: CoordinationMode;
  requestedNativeWorkers?: number;
}) {
  const { signals,capabilities }=input;
  const route=routeFlow(signals);
  const policy=hostRequest('chatgpt');
  const coordinationMode=input.coordinationMode??'AUTO';
  if(coordinationMode!=='AUTO'&&coordinationMode!=='GPT_A_ONLY')throw new Error('Invalid coordination mode');
  const requestedNativeWorkers=input.requestedNativeWorkers??policy.plannerCeiling;
  if(!Number.isInteger(requestedNativeWorkers)||requestedNativeWorkers<0||requestedNativeWorkers>policy.plannerCeiling)
    throw new Error('Invalid requested GPT-A parallel capacity');
  if(!Number.isInteger(capabilities.maxParallelSubagents)||capabilities.maxParallelSubagents<0||capabilities.maxParallelSubagents>32)
    throw new Error('Invalid host-native worker count');
  if(input.assignments.length===0||input.assignments.length>32)throw new Error('Invalid assignment count');
  const configured = new Map(input.bindings.map(x=>[x.agentId,x]));
  // Xanxittoo parity: always request maximum GPT-A reasoning and fast native branches;
  // external peers cannot lower the root capability request in solo mode.
  const reportedNativeSlots=capabilities.nativeSubagents?Math.min(capabilities.maxParallelSubagents,requestedNativeWorkers):0;
  const workerSlots=route.mode==='COORDINATED'?Math.min(reportedNativeSlots,input.assignments.length):0;
  const peerEnabled=coordinationMode==='AUTO';
  const peerEligible=peerEnabled&&input.bindings.some(b=>input.peerStates[b.host]==='CONNECTED');
  const capabilityGaps:string[]=[];
  if(capabilities.observedModel!==undefined&&capabilities.observedModel!==policy.model)
    capabilityGaps.push(`Requested root model ${policy.model}; host reported ${capabilities.observedModel}.`);
  if(capabilities.observedReasoningEffort!==undefined&&
     ![policy.reasoningEffort,policy.reasoningFallback].includes(capabilities.observedReasoningEffort))
    capabilityGaps.push(`Requested max/xhigh reasoning; host reported ${capabilities.observedReasoningEffort}.`);
  if(capabilities.observedWorkerProcessing!==undefined&&capabilities.observedWorkerProcessing!=='fast')
    capabilityGaps.push('Fast native branch processing not reported; preserve max reasoning at standard speed.');
  if(!capabilities.nativeSubagents||reportedNativeSlots===0)
    capabilityGaps.push('Host-native subagents unavailable; GPT-A retains maximum requested reasoning inline.');
  // Distinct native worker slots are NOT a filesystem isolation guarantee.
  // Reject conflicting parallel writer scopes before recommending fanout.
  const writers=input.assignments.filter(a=>agentDefinition(a.agentId)?.role==='implementer'&&a.allowedEditSurfaces?.length);
  if((workerSlots>1||peerEligible)&&writers.length>1)for(let i=0;i<writers.length;i++)for(let j=i+1;j<writers.length;j++){
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
    const available=peerEnabled&&!!host&&input.peerStates[host]==='CONNECTED';
    const needsWrite=agent.role==='implementer';
    const execution:NativeExecution = (needsWrite&&!signals.writesAuthorized)?'BLOCKED_AUTHORIZATION':
      (route.mode!=='READ_ONLY'&&available)?'REMOTE_A2A':
      (!capabilities.toolsAvailable)?'BLOCKED_TOOLS':
      (route.mode!=='READ_ONLY'&&workerSlots>0&&input.assignments.length>1)?'GPT_A_NATIVE_SUBAGENT':'GPT_A_INLINE';
    const chosenHost=execution==='REMOTE_A2A'?host!:'gpt-a';
    const group=execution==='GPT_A_NATIVE_SUBAGENT'?index%Math.max(workerSlots,1):0;
    return {
      agentId:agent.id,host:chosenHost,execution,skillIds:checkSkills(binding?.skillIds??[...agent.defaultSkills]),
      // A remote specialist's model preference is never inherited into GPT-A's own turns.
      modelRequest:execution==='REMOTE_A2A'?(binding?.modelRequest??'host-default'):policy.model,
      effortRequest:execution==='REMOTE_A2A'?(binding?.effortRequest??'host-maximum'):policy.reasoningEffort,
      speedRequest:execution==='GPT_A_NATIVE_SUBAGENT'?policy.worker.preferredProcessing:
        execution==='REMOTE_A2A'?'host-selected':'standard-preserve-reasoning',
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
    coordinationMode, soloActive:coordinationMode==='GPT_A_ONLY'||!peerEligible,
    soloReason:coordinationMode==='GPT_A_ONLY'?'USER_SELECTED_GPT_A_ONLY':(!peerEligible?'NO_CONNECTED_PEERS':'PEERS_ELIGIBLE'),
    // A capacity request is a hard planning priority, not a claim of host-side enforcement.
    capacityContract:{status:'REQUESTED' as const,qualityPriority:'MAXIMUM' as const,
      rootModel:policy.model,rootReasoning:policy.reasoningEffort,reasoningFallback:policy.reasoningFallback,
      preserveReasoning:true,rootProcessing:policy.rootProcessing,
      nativeWorkerModel:policy.worker.model,nativeWorkerReasoning:policy.worker.reasoningEffort,
      nativeWorkerPreferredSpeed:policy.worker.preferredProcessing,
      nativeWorkerFallbackSpeed:policy.worker.fallbackProcessing,
      plannerCeiling:policy.plannerCeiling,requestedNativeWorkers,
      hostReportedNativeWorkers:reportedNativeSlots,scheduledNativeWorkers:workerSlots,
      maxIoPerReasoningBranch:2,
      parallelism:'maximum-observed-independent-work' as const,
      inferenceApiCalls:0 as const,serverModelWorkers:0 as const},
    capacityGaps:capabilityGaps,fullCapacityObserved:false,
    hostReportedEvidence:capabilities.evidence,serverWorkersStarted:0,
    instructions:'GPT-A remains the only orchestrator. In GPT_A_ONLY mode never delegate to a remote host even if CONNECTED. Enforce the maximum requested GPT-A model/effort policy (gpt-6-astra max, xhigh fallback) through the host-native controls when available. Request fast native subagents at maximum observed independent parallelism without degrading reasoning; if unavailable continue with the same maximum-quality root inline and batch independent tool I/O. Report missing native capacity rather than claiming compliance. Load MCP skills for every relevant ODD phase; No model may claim independent review of its own changes. Never re-dispatch writes with unknown outcome.',
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
    allowedEditSurfaces:input.allowedEditSurfaces,modelRequest:input.modelRequest??hostRequest('chatgpt').model,effortRequest:input.effortRequest??hostRequest('chatgpt').reasoningEffort});
  return {...packet,executionOwner:'gpt-a' as const,
    notice:'GPT-A must execute using its own host tools or explicitly available native subagents. This packet does not launch a worker, create a verified reviewer, or grant write privileges.'};
}

export async function nativeOddInstructions(){
  // Load lazily so normal requests do not spend tokens on the entire handbook.
  return readOrchestratorSection('orchestrator');
}
