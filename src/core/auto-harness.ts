/** Panter automatic ODD harness: the user chooses an objective, not agents.
 * GPT-A/host-owned models execute packets. This engine never launches inference.
 * Persisted orchestration decisions are not authorizations or external proof.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { specialistPacket, GENTLE_AGENTS, type GentleAgentId } from './gentle-catalog.js';
import { hostRequest } from './policy.js';
import { type Host, type MeshEngine } from './mesh.js';
import { type NativeSubagentReview } from './native-review-workflow.js';
import { assessMeshReview } from './native-review.js';

const shaPattern=/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const risky=/(^|\/)(auth|oauth|security|secrets|permissions?|rbac|payments?|billing|migrations?|database|db|deploy|infra|concurrency|crypto|tokens?|credential|production)(\/|\.|$)/i;
const riskyGoal=/\b(authentication|authorization|security|secret|payment|migration|deploy|permission|credentials|autenticaci[oó]n|seguridad|contraseñas|pagos|migraci[oó]n|permisos|despliegue)\b/i;
const codeAgent=new Set(GENTLE_AGENTS.map(x=>x.id));
const hash=(x:unknown)=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
function ensure(c:unknown,reason:string):asserts c {if(!c)throw new Error(reason);}
function safePath(p:string){
  ensure(p.length>0&&p.length<=256&&!p.startsWith('/')&&!p.includes('\\')&&!p.includes('\0')&&!p.split('/').some(x=>!x||x==='.'||x==='..'||/[\*?\[\]{}]/.test(x)),'Unsafe change surface');
  return p;
}
export type HarnessMode='AUTO'|'GPT_A_ONLY';
export type HarnessPhase='DISCOVER'|'DESIGN'|'IMPLEMENT'|'VERIFY'|'REVIEW';
export type HarnessStep={id:string;phase:HarnessPhase;agentId:GentleAgentId|null;status:'PENDING'|'ISSUED'|'COMPLETE';
  execution?:'GPT_A_INLINE'|'GPT_A_NATIVE'|'REMOTE_A2A';remoteWorkId?:string;
  result?:{summary:string;evidence:string[];runId?:string;digest:string};};
export type HarnessRun={id:string;project:string;objective:string;key:string;inputDigest:string;permission:'READ_ONLY'|'WRITE_APPROVED';
  mode:HarnessMode; paths:string[]; risk:'LOW'|'HIGH'; reason:string[]; candidateSha:string|null;
  reviewKind:'4r'|'judgment-day'|null; reviewId:string|null; reviewTransport:'NATIVE'|'REMOTE'|null;
  steps:HarnessStep[]; createdAt:string;revision:number;};
type State={version:1;runs:HarnessRun[]};
export type HarnessInput={project:string;objective:string;idempotencyKey:string;writesAuthorized:boolean;
  changeSurfaces?:string[];coordinationMode?:HarnessMode;judgmentDayRequested?:boolean;
  /** Facts supplied by the host, not agent selections. Missing facts are handled conservatively. */
  observations?:{requirementsClear?:boolean;resumableFromDiff?:boolean;independentWorkUnits?:number;unknownCodeArea?:boolean};};
export type HarnessRuntime={nativeSubagents:boolean;maxParallelSubagents:number;toolsAvailable:boolean;
  peerStates?:Partial<Record<Host,'CONNECTED'|'UNAVAILABLE'|'UNKNOWN'>>};

export function chooseHarness(input:HarnessInput){
  ensure(input.project.trim().length>0&&input.project.length<=100,'Invalid project');
  ensure(input.objective.trim().length>0&&input.objective.length<=6000,'Invalid objective');
  ensure(input.idempotencyKey.trim().length>0&&input.idempotencyKey.length<=160,'Invalid idempotency key');
  ensure(input.coordinationMode===undefined||['AUTO','GPT_A_ONLY'].includes(input.coordinationMode),'Invalid harness mode');
  const paths=[...new Set((input.changeSurfaces??[]).map(safePath))];
  ensure(paths.length<=16,'Too many change surfaces');
  const o=input.observations??{};
  if(o.independentWorkUnits!==undefined)ensure(Number.isInteger(o.independentWorkUnits)&&o.independentWorkUnits>=0&&o.independentWorkUnits<=32,'Invalid unit count');
  const reasons:string[]=[];
  const unknown=o.unknownCodeArea===true||(!paths.length&&input.writesAuthorized);
  const risk=input.writesAuthorized&&(input.judgmentDayRequested===true||unknown||o.requirementsClear===false||o.resumableFromDiff===false||
    paths.some(p=>risky.test(p))||riskyGoal.test(input.objective))?'HIGH':'LOW';
  if(unknown)reasons.push('Code surfaces unknown: run read-only discovery before any edit');
  if(paths.some(p=>risky.test(p))||riskyGoal.test(input.objective))reasons.push('Security, data, delivery, or other high-impact surface');
  if(o.requirementsClear===false)reasons.push('Requirements need exploration/clarification');
  if(o.resumableFromDiff===false)reasons.push('Durable ODD tracking required');
  const phases:HarnessPhase[]=!input.writesAuthorized?['DISCOVER']:
    risk==='LOW' && !unknown && (o.independentWorkUnits??1)<=1?['IMPLEMENT']:
    [...(unknown||o.requirementsClear===false?['DISCOVER'] as HarnessPhase[]:[]),'DESIGN','IMPLEMENT',
      ...(risk==='HIGH'?['VERIFY','REVIEW'] as HarnessPhase[]:[])];
  // Judgment Day is an explicitly requested special workflow, never silently automatic.
  const reviewKind=input.writesAuthorized&&risk==='HIGH'?(input.judgmentDayRequested?'judgment-day':'4r'):null;
  return {paths,risk,reasons,phases,reviewKind,mode:input.coordinationMode??'AUTO'};
}

export class AutomaticHarness {
  private state:State={version:1,runs:[]};
  private pending:Promise<unknown>=Promise.resolve();
  private constructor(private readonly file:string,private readonly mesh:MeshEngine,private readonly native:NativeSubagentReview){}
  static async open(dir:string,mesh:MeshEngine,native:NativeSubagentReview){
    await mkdir(resolve(dir),{recursive:true,mode:0o700});
    const engine=new AutomaticHarness(join(resolve(dir),'harness.json'),mesh,native);
    try{const value:unknown=JSON.parse(await readFile(engine.file,'utf8'));
      ensure(!!value&&typeof value==='object'&&'version' in value&&value.version===1&&'runs' in value&&Array.isArray(value.runs),'Invalid harness store');
      engine.state=value as State;
    }catch(e){if(!(e instanceof Error)||!('code' in e)||e.code!=='ENOENT')throw e;}
    return engine;
  }
  private async read<T>(fn:(s:State)=>T){await this.pending;return structuredClone(fn(this.state));}
  private async write<T>(fn:(s:State)=>T){
    const task=this.pending.then(async()=>{const copy=structuredClone(this.state),v=fn(copy);
      const tmp=`${this.file}.${randomUUID()}.tmp`;
      await writeFile(tmp,JSON.stringify(copy,null,2),{mode:0o600,flag:'wx'});
      await rename(tmp,this.file);this.state=copy;return structuredClone(v);});
    this.pending=task.then(()=>undefined,()=>undefined);return task;
  }
  async start(input:HarnessInput){
    const selected=chooseHarness(input);
    const digest=hash({project:input.project,objective:input.objective,key:input.idempotencyKey,permission:input.writesAuthorized,paths:selected.paths,mode:selected.mode,risk:selected.risk,review:selected.reviewKind,observations:input.observations??{}});
    return this.write(s=>{
      const old=s.runs.find(r=>r.project===input.project&&r.key===input.idempotencyKey);
      if(old){ensure(old.inputDigest===digest,'Harness start idempotency conflict');return old;}
      const step=(phase:HarnessPhase):HarnessStep=>({id:randomUUID(),phase,
        agentId:phase==='DISCOVER'?'gentle-ai-explore':phase==='IMPLEMENT'?'gentle-ai-worker':phase==='VERIFY'?'gentle-ai-verify':null,
        status:'PENDING'});
      const run:HarnessRun={id:randomUUID(),project:input.project,objective:input.objective,key:input.idempotencyKey,inputDigest:digest,
        permission:input.writesAuthorized?'WRITE_APPROVED':'READ_ONLY',mode:selected.mode,
        paths:selected.paths,risk:selected.risk,reason:selected.reasons,candidateSha:null,reviewKind:selected.reviewKind,
        reviewId:null,reviewTransport:null,steps:selected.phases.map(step),createdAt:new Date().toISOString(),revision:1};
      s.runs.push(run);return run;
    });
  }
  get(runId:string){return this.read(s=>s.runs.find(r=>r.id===runId)??null);}
  async report(runId:string,stepId:string,payload:{summary:string;evidence:string[];runId?:string;candidateSha?:string;discoveredPaths?:string[]}){
    ensure(payload.summary.trim().length>0&&payload.summary.length<=6000,'Invalid report summary');
    ensure(Array.isArray(payload.evidence)&&payload.evidence.length>0&&payload.evidence.length<=40&&payload.evidence.every(x=>typeof x==='string'&&!!x.trim()&&x.length<=1000),'Concrete evidence required');
    if(payload.candidateSha!==undefined)ensure(shaPattern.test(payload.candidateSha),'Invalid candidate SHA');
    const discovered=[...new Set((payload.discoveredPaths??[]).map(safePath))];
    ensure(discovered.length<=16,'Too many discovery paths');
    return this.write(s=>{
      const r=s.runs.find(x=>x.id===runId);ensure(r,'Harness not found');
      const step=r.steps.find(x=>x.id===stepId);ensure(step,'Unknown harness step');
      const i=r.steps.indexOf(step);
      ensure(r.steps.slice(0,i).every(x=>x.status==='COMPLETE'),'Previous phases are incomplete');
      ensure(step.phase!=='REVIEW','Review evidence must be submitted through review slots');
      const digest=hash({stepId,payload});
      if(step.status==='COMPLETE'){ensure(step.result?.digest===digest,'Conflicting immutable harness report');return r;}
      ensure(step.status==='ISSUED','Phase packet must be issued before reporting');
      if(step.phase==='DISCOVER' && discovered.length){r.paths=[...new Set([...r.paths,...discovered])];}
      if(step.phase==='IMPLEMENT'){
        ensure(r.permission==='WRITE_APPROVED','Unauthorized implementation');
        ensure(r.paths.length>0,'No discovery-confirmed edit surfaces');
        if(r.risk==='HIGH')ensure(!!payload.candidateSha,'High-risk implementation needs frozen candidate SHA');
        r.candidateSha=payload.candidateSha??null;
      }
      if(step.phase==='VERIFY'){
        ensure(payload.candidateSha===r.candidateSha&&!!r.candidateSha,'Verifier must report exact candidate SHA');
        ensure(!!payload.runId&&payload.runId!=='gpt-a'&&payload.runId!==r.steps.find(x=>x.phase==='IMPLEMENT')?.result?.runId,
          'Independent verifier run ID required');
      }
      step.status='COMPLETE';step.result={summary:payload.summary,evidence:payload.evidence,runId:payload.runId,digest};
      r.revision++;return r;
    });
  }
  async tick(runId:string,runtime:HarnessRuntime){
    ensure(Number.isInteger(runtime.maxParallelSubagents)&&runtime.maxParallelSubagents>=0&&runtime.maxParallelSubagents<=32,'Invalid host native capacity');
    const record=await this.get(runId);ensure(record,'Harness not found');
    const phase=record.steps.find(s=>s.status!=='COMPLETE');
    const profile=(await this.mesh.profiles()).find(p=>p.host==='gpt-a');
    // An operator may switch to GPT_A_ONLY mid-mission. Never dispatch fresh
    // remote work after that change, or silently reassign an in-flight write.
    const effectiveMode=profile?.coordinationMode??record.mode;
    const policy=hostRequest('chatgpt');
    const common={runId:record.id,mode:effectiveMode,risk:record.risk,reason:record.reason,
      capacityRequest:{model:policy.model,reasoning:policy.reasoningEffort,workerProcessing:policy.worker.preferredProcessing,
        requestedParallelism:Math.min(runtime.nativeSubagents?runtime.maxParallelSubagents:0,policy.plannerCeiling),
        capacityVerified:false},modelWorkersStartedByServer:0,approved:false};
    if(!phase)return {...common,status:record.risk==='HIGH'?'AWAITING_RDD_AUTHORITY':'REPORTED_COMPLETE_UNVERIFIED',next:[]};
    if(phase.execution==='REMOTE_A2A'&&phase.remoteWorkId){
      const inbox=await this.mesh.inbox('gpt-a');
      const work=inbox.works.find(w=>w.id===phase.remoteWorkId);
      if(work?.state==='FAILED'||work?.state==='OUTCOME_UNKNOWN')
        return {...common,status:'REMOTE_OUTCOME_NEEDS_RECONCILIATION',phaseId:phase.id,workId:phase.remoteWorkId,next:[]};
      if(work?.state==='COMPLETED'){
        const response=inbox.messages.find(m=>m.kind==='RESULT'&&m.workId===phase.remoteWorkId);
        let result:unknown;
        try{result=JSON.parse(response?.text??'');}catch{result=null;}
        if(!result||typeof result!=='object'||!('summary' in result)||!('evidence' in result))
          return {...common,status:'REMOTE_RESULT_NEEDS_STRUCTURED_EVIDENCE',phaseId:phase.id,workId:phase.remoteWorkId,next:[]};
        await this.report(runId,phase.id,result as {summary:string;evidence:string[];runId?:string;candidateSha?:string;discoveredPaths?:string[]});
        return this.tick(runId,runtime);
      }
      return {...common,status:'WAITING_REMOTE_PEER',phaseId:phase.id,workId:phase.remoteWorkId,next:[]};
    }
    if(phase.phase==='IMPLEMENT'&&(!record.paths.length||record.permission!=='WRITE_APPROVED'))
      return {...common,status:'BLOCKED_EDIT_SCOPE_OR_AUTHORIZATION',phaseId:phase.id,next:[]};
    if(['VERIFY','REVIEW'].includes(phase.phase)&&!record.candidateSha)
      return {...common,status:'BLOCKED_CANDIDATE_SHA',phaseId:phase.id,next:[]};
    if(phase.phase==='REVIEW'){
      const kind=record.reviewKind??'4r';
      // Remote 4R is only eligible if every configured review host is explicitly connected.
      // No remote worker is needed for a complete native GPT-A-only review.
      if(!record.reviewId){
        const assigned=await this.mesh.specialistBindings();
        const roles=kind==='4r'?['review-risk','review-readability','review-reliability','review-resilience']:['jd-judge-a','jd-judge-b'];
        const remoteReady=effectiveMode==='AUTO'&&roles.every(id=>{
          const a=assigned.find(x=>x.agentId===id);
          return a&&runtime.peerStates?.[a.host]==='CONNECTED';
        });
        if(remoteReady){
          const remote=await this.mesh.startReview('gpt-a',{missionId:record.id,kind,objective:record.objective,candidateSha:record.candidateSha!,idempotencyKey:`harness:${record.id}:review`});
          await this.write(s=>{const r=s.runs.find(x=>x.id===runId)!;if(!r.reviewId){r.reviewId=remote.id;r.reviewTransport='REMOTE';r.revision++;}});
        }else{
          const native=await this.native.create({missionId:record.id,kind,objective:record.objective,candidateSha:record.candidateSha!,idempotencyKey:`harness:${record.id}:review`});
          await this.write(s=>{const r=s.runs.find(x=>x.id===runId)!;if(!r.reviewId){r.reviewId=native.reviewId;r.reviewTransport='NATIVE';r.revision++;}});
        }
      }
      const now=await this.get(runId);ensure(now?.reviewId&&now.reviewTransport,'Review session not initialized');
      if(now.reviewTransport==='NATIVE'){
        const review=await this.native.status(now.reviewId);
        if(review.stage==='AWAITING_SUBAGENT_REPORTS'){
          const batch=await this.native.batch(now.reviewId,runtime.nativeSubagents?runtime.maxParallelSubagents:0);
          return {...common,status:batch.dispatch,phaseId:phase.id,reviewId:now.reviewId,next:batch.packets,concurrentSlots:batch.concurrentSlots,
            instruction:'GPT-A: automatically dispatch the supplied separate native subagent packets in parallel when supported. No per-task agent selection or model-provider API.'};
        }
        return {...common,status:review.severeFindings.length?'REVIEW_FINDINGS_NEED_CORRECTION':'AWAITING_RDD_AUTHORITY',
          phaseId:phase.id,reviewId:now.reviewId,review, next:[],
          instruction:'Do not mark approved. Freeze a corrected candidate and restart review if severe findings remain; official RDD or trusted external gate must validate final approval.'};
      }
      const review=await this.mesh.reviewStatus('gpt-a',now.reviewId);
      const evidence=assessMeshReview({kind:review.review.kind,candidateSha:review.review.candidateSha,work:review.work});
      return {...common,status:review.stage==='AWAITING_REPORTS'?'WAITING_REMOTE_REVIEW':
        evidence.status==='EVIDENCE_INCOMPLETE'?'REVIEW_EVIDENCE_INCOMPLETE':'AWAITING_RDD_AUTHORITY',
        phaseId:phase.id,reviewId:now.reviewId,review:evidence,next:[]};
    }
    if(!runtime.toolsAvailable)return {...common,status:'BLOCKED_HOST_TOOLS',phaseId:phase.id,next:[]};
    const objective=phase.phase==='DISCOVER'?`Explore the repository for: ${record.objective}. Return exact permitted edit surfaces, risks and path:line evidence. Do not write.`:
      phase.phase==='DESIGN'?`Plan the smallest authorized change for: ${record.objective}. Preserve exact specification, acceptance checks and ODD task IDs. Confirm scoped edit surfaces: ${record.paths.join(', ')||'unknown; do not write yet'}.`:
      phase.phase==='IMPLEMENT'?`Implement the authorized scoped change: ${record.objective}. Allowed surfaces: ${record.paths.join(', ')}. Test first when applicable; return the exact commit SHA for high-risk review.`:
      `Verify the exact frozen candidate ${record.candidateSha} against: ${record.objective}. Independently reproduce checks, read-only; report run identity and evidence.`;
    if(phase.phase==='DESIGN'){
      await this.write(s=>{const r=s.runs.find(x=>x.id===runId)!;const st=r.steps.find(x=>x.id===phase.id)!;if(st.status==='PENDING'){st.status='ISSUED';r.revision++;}});
      return {...common,status:'GPT_A_INLINE',phaseId:phase.id,next:[{phase:phase.phase,agentId:null,instruction:objective,
        skills:['gentle-ai','work-unit-commits'],execution:'GPT_A_INLINE'}]};
    }
    ensure(phase.agentId && codeAgent.has(phase.agentId),'Unknown automatic agent');
    const binding=(await this.mesh.specialistBindings()).find(x=>x.agentId===phase.agentId);
    const implementer=record.steps.find(s=>s.phase==='IMPLEMENT');
    const candidateVerifierIsIndependent=phase.phase!=='VERIFY'||!implementer?.remoteWorkId||
      (await this.mesh.inbox('gpt-a')).works.find(w=>w.id===implementer.remoteWorkId)?.target!==binding?.host;
    const requestedRole=phase.phase==='IMPLEMENT'?'implementer':phase.phase==='VERIFY'?'verifier':'explorer';
    const remoteEligible=effectiveMode==='AUTO'&&binding&&runtime.peerStates?.[binding.host]==='CONNECTED'&&candidateVerifierIsIndependent&&
      (await this.mesh.profiles()).some(p=>p.host===binding.host&&p.roles.includes(requestedRole));
    if(remoteEligible){
      const work=await this.mesh.delegateBoundSpecialist('gpt-a',{missionId:record.id,agentId:phase.agentId,objective,
        candidateSha:record.candidateSha??undefined,allowedEditSurfaces:phase.phase==='IMPLEMENT'?record.paths:undefined,
        idempotencyKey:`harness:${record.id}:${phase.id}`});
      await this.write(s=>{const r=s.runs.find(x=>x.id===runId)!;const st=r.steps.find(x=>x.id===phase.id)!;
        if(st.status==='PENDING'){st.status='ISSUED';st.execution='REMOTE_A2A';st.remoteWorkId=work.id;r.revision++;}});
      return {...common,status:'REMOTE_A2A_DISPATCHED',phaseId:phase.id,next:[{agentId:phase.agentId,workId:work.id,
        execution:'REMOTE_A2A',host:binding.host,automatic:true}]};
    }
    const packet=await specialistPacket({agentId:phase.agentId,objective,skillIds:phase.phase==='IMPLEMENT'?['gentle-ai','work-unit-commits']:
      phase.phase==='DISCOVER'?['gentle-ai']:['gentle-ai'],modelRequest:policy.model,effortRequest:policy.reasoningEffort,
      candidateSha:phase.phase==='VERIFY'?record.candidateSha??undefined:undefined,
      allowedEditSurfaces:phase.phase==='IMPLEMENT'?record.paths:undefined});
    const execution=runtime.nativeSubagents&&runtime.maxParallelSubagents>0&&phase.phase!=='IMPLEMENT'?'GPT_A_NATIVE':'GPT_A_INLINE';
    await this.write(s=>{const r=s.runs.find(x=>x.id===runId)!;const st=r.steps.find(x=>x.id===phase.id)!;
      if(st.status==='PENDING'){st.status='ISSUED';st.execution=execution;r.revision++;}});
    return {...common,status:execution,phaseId:phase.id,next:[{...packet,phase:phase.phase,execution,
      instruction:packet.instruction,requestedWorkerProcessing:policy.worker.preferredProcessing,
      notice:'Host must invoke its actual tool/subagent and return evidence; MCP has not started model inference.'}]};
  }
}
