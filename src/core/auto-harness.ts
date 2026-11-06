import { leaderHost, leaderLabel, leaderPolicyProfile } from './leadership.js';
import { ownerMode } from './owner-mode.js';
import { SqliteLedger } from './sqlite-ledger.js';
/** Panter automatic ODD harness: the user chooses an objective, not agents.
 * GPT-A/host-owned models execute packets. This engine never launches inference.
 * Persisted orchestration decisions are not authorizations or external proof.
 */
import { createHash, randomUUID } from 'node:crypto';
import { jsonCandidates } from './json-extract.js';
import { specialistPacket, GENTLE_AGENTS, type GentleAgentId } from './gentle-catalog.js';
import { hostRequest } from './policy.js';
import { type Host, type MeshEngine } from './mesh.js';
import { type NativeSubagentReview } from './native-review-workflow.js';
import { assessMeshReview, lensEnvelope, unacceptedSevere, type NativeReviewBridge } from './native-review.js';
import { type GitHubDeliveryGate } from './github-delivery.js';
import { type PanterRdd } from './panter-rdd.js';

const shaPattern=/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const githubProject=/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
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
export type HarnessPhase='DISCOVER'|'DESIGN'|'IMPLEMENT'|'VERIFY'|'REVIEW'|'JUDGMENT';
export type HarnessStep={id:string;phase:HarnessPhase;agentId:GentleAgentId|null;status:'PENDING'|'ISSUED'|'COMPLETE';
  execution?:'GPT_A_INLINE'|'GPT_A_NATIVE'|'REMOTE_A2A';remoteWorkId?:string;redispatchGeneration?:number;
  /** Set when the bound host failed or did not pick the phase up in time: the phase runs native while it stays bound to
   * that host (fallbackFrom); rebinding it to another host lets that host take it. */
  nativeOnly?:boolean;fallbackFrom?:Host;
  result?:{summary:string;evidence:string[];runId?:string;digest:string;verificationMode?:'SELF_UNVERIFIED'|'HOST_REPORTED_UNVERIFIED'};};
export type HarnessRun={id:string;project:string;githubRepository?:string;githubPrNumber?:number;githubExpectedBase?:string;objective:string;key:string;inputDigest:string;permission:'READ_ONLY'|'WRITE_APPROVED';
  mode:HarnessMode; paths:string[]; risk:'LOW'|'HIGH'; reviewTier?:'passive'|'medium'|'high'; reason:string[]; candidateSha:string|null;
  reviewKind:'4r'|null; reviewId:string|null; reviewTransport:'NATIVE'|'REMOTE'|null;
  judgmentRequested?:boolean; judgmentId?:string|null; judgmentTransport?:'NATIVE'|'REMOTE'|null;
  judgmentAttempt?:number; judgmentNativeOnly?:boolean; judgmentEvidenceRetries?:number; writeGrantId?:string;
  correctionAttempts?:number; correctionRunId?:string; correctionRunIds?:string[]; previousReviewId?:string|null; reviewAttempt?:number; reviewNativeOnly?:boolean; reviewEvidenceRetries?:number; deliveryStrategy?:'single-pr'|'feature-branch-chain'|'stacked-to-main';
  units?:Array<{id:string;objective:string;paths:string[];state:'PENDING'|'REPORTED';runId?:string;summary?:string;evidence?:string[]}>;
  steps:HarnessStep[]; createdAt:string;revision:number;
  /** Set when the leader closed the run: it never advances again and its remote work was withdrawn. */
  closedAt?:string;closedReason?:string;};
type WriteGrant={id:string;project:string;objectiveDigest:string;allowedPaths:string[];expiresAt:number;boundRunId:string|null};
type State={version:1;runs:HarnessRun[];grants?:WriteGrant[]};
export type HarnessInput={project:string;githubRepository?:string;githubPrNumber?:number;githubExpectedBase?:string;objective:string;idempotencyKey:string;writesAuthorized:boolean;
  changeSurfaces?:string[];writeGrantId?:string;coordinationMode?:HarnessMode;judgmentDayRequested?:boolean;
  /** Facts supplied by the host, not agent selections. Missing facts are handled conservatively. */
  observations?:{requirementsClear?:boolean;resumableFromDiff?:boolean;independentWorkUnits?:number;unknownCodeArea?:boolean};};
export type HarnessTickResult={runId:string;mode:HarnessMode;risk:'LOW'|'HIGH';reason:string[];
  status:string;next:Array<{agentId?:string|null;workId?:string;phase?:HarnessPhase;[key:string]:unknown}>;
  phaseId?:string;workId?:string;reviewId?:string;concurrentSlots?:number;[key:string]:unknown};
/** Server-side integration of the bound hosts: transport material, per-phase GitHub grants and pickup timeouts. */
export type HarnessHostHooks={
  /** Read-only material for hosts that cannot reach the repository (e.g. Gemini by e-mail). */
  materialFor?(run:HarnessRun,host:Host):Promise<string|undefined>;
  /** Trusted note telling the host how to reach the run's repository for this phase (tools, grant, branch). */
  accessFor?(run:HarnessRun,host:Host,phase:HarnessPhase):string|undefined;
  /** Called for remote work whose result will never be read (e.g. a running lens of an abandoned review), to revoke its grants. */
  abandoned?(input:{workId:string;host:Host}):Promise<void>;
  /** Called after a phase or review lens was dispatched to a host (e.g. to attach a work-scoped GitHub grant). */
  afterDispatch?(input:{run:HarnessRun;workId:string;phase:HarnessPhase;host:Host}):Promise<void>;
  /** How long a host may leave a dispatched phase unstarted before it runs native instead. */
  pickupTimeoutMs?(host:Host):number;
  /** Hosts that were ever allowed to write to a repository (Panter-RDD's writer history), or null if it cannot be read. */
  writerHosts?():string[]|null;
  /** Whether Panter-RDD attests remote reviews by their transport (remote hosts produce no runner signatures). */
  remoteAttestation?():boolean;
  /** When a work's pickup clock starts (ISO), or null while it is legitimately waiting to be signalled; default createdAt. */
  pickupClockStart?(work:{id:string;target:Host;createdAt:string},limitMs:number):Promise<string|null>;
};
export type HarnessRuntime={nativeSubagents:boolean;maxParallelSubagents:number;toolsAvailable:boolean;
  peerStates?:Partial<Record<Host,'CONNECTED'|'UNAVAILABLE'|'UNKNOWN'>>};

export function chooseHarness(input:HarnessInput){
  ensure(input.project.trim().length>0&&input.project.length<=100,'Invalid project');
  if(input.githubRepository!==undefined)ensure(githubProject.test(input.githubRepository)&&!input.githubRepository.includes('..'),'Invalid GitHub repository identity');
  if(input.githubPrNumber!==undefined)ensure(Number.isInteger(input.githubPrNumber)&&input.githubPrNumber>0&&!!input.githubRepository,'GitHub PR requires known repository');
  if(input.githubExpectedBase!==undefined)ensure(!!input.githubRepository&&/^[a-zA-Z0-9._/-]{1,100}$/.test(input.githubExpectedBase),'Invalid GitHub base');
  ensure(input.objective.trim().length>0&&input.objective.length<=6000,'Invalid objective');
  ensure(input.idempotencyKey.trim().length>0&&input.idempotencyKey.length<=160,'Invalid idempotency key');
  ensure(input.coordinationMode===undefined||['AUTO','GPT_A_ONLY'].includes(input.coordinationMode),'Invalid harness mode');
  const paths=[...new Set((input.changeSurfaces??[]).map(safePath))];
  ensure(paths.length<=16,'Too many change surfaces');
  const o=input.observations??{};
  if(o.independentWorkUnits!==undefined)ensure(Number.isInteger(o.independentWorkUnits)&&o.independentWorkUnits>=0&&o.independentWorkUnits<=32,'Invalid unit count');
  const reasons:string[]=[];
  const owner=ownerMode();
  // In owner mode the whole repository is a valid scope: no listed surfaces means "anywhere", not "unknown".
  const unknown=o.unknownCodeArea===true||(!owner&&!paths.length&&input.writesAuthorized);
  const keywordRisk=paths.some(p=>risky.test(p))||riskyGoal.test(input.objective);
  // Owner mode: keywords and unknown areas are advice; only an explicit observation (or Judgment Day) raises risk.
  const risk:'LOW'|'HIGH'=input.writesAuthorized&&(owner?
    (o.requirementsClear===false||o.resumableFromDiff===false):
    (unknown||o.requirementsClear===false||o.resumableFromDiff===false||keywordRisk))?'HIGH':'LOW';
  if(unknown)reasons.push('Code surfaces unknown: run read-only discovery before any edit');
  if(keywordRisk)reasons.push(owner?'Advice: security, data, delivery, or other high-impact surface (owner mode: not a gate)':'Security, data, delivery, or other high-impact surface');
  if(owner&&!paths.length&&input.writesAuthorized)reasons.push('Owner mode: no edit surfaces listed, the whole repository is in scope');
  if(o.requirementsClear===false)reasons.push('Requirements need exploration/clarification');
  if(o.resumableFromDiff===false)reasons.push('Durable ODD tracking required');
  const tier:'passive'|'medium'|'high'=risk==='HIGH'?'high':!input.writesAuthorized||
    (paths.length>0&&paths.every(p=>/\.(?:md|mdx|txt|rst)$/.test(p)))?'passive':'medium';
  const phases:HarnessPhase[]=!input.writesAuthorized?['DISCOVER']:
    risk==='LOW' && !unknown && (o.independentWorkUnits??1)<=1?
      (input.judgmentDayRequested?['IMPLEMENT','JUDGMENT']:['IMPLEMENT']):
    [...(unknown||o.requirementsClear===false?['DISCOVER'] as HarnessPhase[]:[]),'DESIGN','IMPLEMENT',
      ...(risk==='HIGH'?['VERIFY','REVIEW'] as HarnessPhase[]:[]),
      ...(input.judgmentDayRequested===true?['JUDGMENT'] as HarnessPhase[]:[])];
  // Judgment Day is an explicitly requested special workflow, never silently automatic.
  const reviewKind:'4r'|null=input.writesAuthorized&&risk==='HIGH'?'4r':null;
  return {paths,risk,tier,reasons,phases,reviewKind,mode:input.coordinationMode??'AUTO'};
}

/** How a remote phase reports back, so the harness can record it without the leader re-typing it. */
function completionFormat(phase:HarnessPhase){
  const discover=phase==='DISCOVER'?', "discoveredPaths": ["<each repository-relative file the change must edit, at most 16; this becomes the edit scope>"]':'';
  return `This completion format overrides any output format above. Complete this work with exactly one JSON object and nothing else: {"summary": "<what you did and found>", "evidence": ["<one observed fact per item: commands run and their results, files read, commits made>"], "candidateSha": "<the exact 40-hex commit you produced or verified, if any>", "runId": "<a unique id for this run of yours>"${discover}}. Never claim evidence you did not observe.`;
}
function phaseNotes(phase:HarnessPhase,access?:string){return [access,completionFormat(phase)].filter(Boolean).join('\n\n');}
/** How a remote 4R / Judgment Day lens reports back: the envelope assessMeshReview accepts. */
function reviewCompletionFormat(agentId:string,candidateSha:string){
  return `This completion format overrides any output format above (including "rows" or "review_result" shapes). Complete this review with exactly one JSON object and nothing else: {"agentId": "${agentId}", "candidateSha": "${candidateSha}", "packetDigest": "<work.specialist.packetDigest from your claim>", "subagentRunId": "<a unique id for this review run of yours>", "findings": [{"id": "<stable id>", "location": "<path:line>", "severity": "BLOCKER | CRITICAL | WARNING | SUGGESTION", "claim": "<concrete user-impact claim>", "proofRefs": ["<changed-hunk or file:line you read>"]}], "evidence": ["<what you read or ran>"]}. Use an empty findings array when you find nothing. Never claim evidence you did not observe.`;
}
/** The run fields each review phase keeps: 4R (REVIEW) and the additional, explicitly requested Judgment Day (JUDGMENT). */
const reviewSlots={
  REVIEW:{id:'reviewId',transport:'reviewTransport',attempt:'reviewAttempt',nativeOnly:'reviewNativeOnly',retries:'reviewEvidenceRetries'},
  JUDGMENT:{id:'judgmentId',transport:'judgmentTransport',attempt:'judgmentAttempt',nativeOnly:'judgmentNativeOnly',retries:'judgmentEvidenceRetries'},
} as const;
type ReviewPhase=keyof typeof reviewSlots;
type ReviewKind='4r'|'judgment-day';
const reviewRoles=(kind:ReviewKind)=>kind==='4r'?['review-risk','review-readability','review-reliability','review-resilience']:['jd-judge-a','jd-judge-b'];
type PhaseResult={summary:string;evidence:string[];runId?:string;candidateSha?:string;discoveredPaths?:string[]};
const MAX_RESULT_TEXT=100_000;
/** A copied completion-format placeholder such as "<what you did>". */
const placeholder=(x:unknown)=>typeof x==='string'&&/^<[^<>]*>$/.test(x.trim());
/** null or "" means "not given". */
function given<T>(v:T):T|undefined{return v===null||v===''?undefined:v;}
/** A remote phase result: one JSON object, bare, fenced or surrounded by prose. Every candidate in the text is
 * considered; if they disagree (e.g. a result-shaped object quoted from a diff), nothing is accepted. A copy of the
 * completion-format template (a field that is just an <angle-bracket placeholder>) is ignored. */
export function structuredResult(text:string|null|undefined):PhaseResult|null{
  if(!text||text.length>MAX_RESULT_TEXT)return null;
  const candidates=jsonCandidates(text);
  const valid=new Map<string,PhaseResult>();
  for(const c of candidates){
    let v:any;
    try{v=JSON.parse(c);}catch{continue;}
    if(!v||typeof v!=='object'||Array.isArray(v)||typeof v.summary!=='string'||[v.summary,v.runId,v.candidateSha].some(placeholder)||
      !Array.isArray(v.evidence)||!v.evidence.every((e:unknown)=>typeof e==='string'))continue;
    const r:PhaseResult={summary:v.summary,evidence:v.evidence};
    const candidateSha=given(v.candidateSha),runId=given(v.runId),discoveredPaths=given(v.discoveredPaths);
    if(candidateSha!==undefined)r.candidateSha=candidateSha;
    if(runId!==undefined)r.runId=runId;
    if(discoveredPaths!==undefined)r.discoveredPaths=discoveredPaths;
    valid.set(JSON.stringify(r),r);
  }
  return valid.size===1?[...valid.values()][0]!:null;
}
/** The shape panter_harness_report validates up front (phase rules inside the write are handled by the caller). */
function reportable(r:PhaseResult){
  const pathOk=(p:unknown)=>{if(typeof p!=='string')return false;try{safePath(p);return true;}catch{return false;}};
  return r.summary.trim().length>0&&r.summary.length<=6000&&r.evidence.length>0&&r.evidence.length<=40&&
    r.evidence.every(x=>!!x.trim()&&x.length<=1000)&&
    (r.candidateSha===undefined||(typeof r.candidateSha==='string'&&/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(r.candidateSha)))&&
    (r.runId===undefined||(typeof r.runId==='string'&&r.runId.length<=160))&&
    (r.discoveredPaths===undefined||(Array.isArray(r.discoveredPaths)&&r.discoveredPaths.length<=16&&r.discoveredPaths.every(pathOk)));
}
export class AutomaticHarness {
  private state:State={version:1,runs:[]};
  private pending:Promise<unknown>=Promise.resolve();
  private hooks:HarnessHostHooks={};
  setHostHooks(hooks:HarnessHostHooks){this.hooks=hooks;}
  private async dispatched(run:HarnessRun,workId:string,phase:HarnessPhase,host:Host){
    try{await this.hooks.afterDispatch?.({run,workId,phase,host});}catch{/* a failed grant leaves the phase read-only; never blocks */}
  }
  /** True when this host left the work unstarted (queued, or only held by its transport) past its pickup timeout. */
  private async unstartedTooLong(workId:string){
    if(!this.hooks.pickupTimeoutMs)return null;
    const w=await this.mesh.workTarget(leaderHost(),workId).catch(()=>null);
    if(!w||!(w.state==='QUEUED'||w.transportHeld))return null;
    const limit=this.hooks.pickupTimeoutMs(w.target);
    const start=this.hooks.pickupClockStart?await this.hooks.pickupClockStart({id:workId,target:w.target,createdAt:w.createdAt},limit).catch(()=>w.createdAt):w.createdAt;
    if(start===null)return null;
    return Date.now()-Date.parse(start)>limit?{host:w.target,limit}:null;
  }
  /** A started read-only work whose host let its lease run out and did not renew it within a further pickup timeout:
   * the host is gone. (Read-only work never becomes OUTCOME_UNKNOWN; it stays RUNNING for its host to reclaim.) */
  private async leaseLostTooLong(workId:string){
    const w=await this.mesh.workTarget(leaderHost(),workId).catch(()=>null);
    if(!w||w.state!=='RUNNING'||w.transportHeld||!w.leaseUntil)return null;
    const limit=this.hooks.pickupTimeoutMs?.(w.target)??300_000;
    return Date.now()-Date.parse(w.leaseUntil)>limit?{host:w.target,limit}:null;
  }
  /** A review phase runs remote only if every lens is bound to an explicitly connected host. Judgment Day's two blind
   * judges must also be on distinct hosts: Panter-RDD never attests two judges on one host, so that session could not pass. */
  private async remoteReviewReady(record:HarnessRun,phase:ReviewPhase,kind:ReviewKind,mode:HarnessMode,runtime:HarnessRuntime){
    if(mode!=='AUTO'||record[reviewSlots[phase].nativeOnly])return false;
    const assigned=await this.mesh.specialistBindings();
    const hosts=reviewRoles(kind).map(id=>assigned.find(x=>x.agentId===id)?.host);
    if(!hosts.every(h=>!!h&&runtime.peerStates?.[h]==='CONNECTED'))return false;
    // The mesh refuses a lens on a host without the reviewer role; that review must run native, not fail every tick.
    const profiles=await this.mesh.profiles();
    if(!hosts.every(h=>profiles.some(p=>p.host===h&&p.roles.includes('reviewer'))))return false;
    if(kind==='4r')return true;
    // Judgment Day goes remote only where Panter-RDD can attest it: transport attestation on, blind judges on distinct
    // hosts, none of which wrote code. Otherwise its native review, which the runner can sign, is the one that can pass.
    if(this.hooks.remoteAttestation?.()!==true)return false;
    if(new Set(hosts).size!==hosts.length)return false;
    // Same author history Panter-RDD checks: implementer work in the mesh, former leaders, and any host ever granted
    // GitHub commit/PR (even for work it never picked up). Missing or unreadable history: the judges run native.
    const writers=this.hooks.writerHosts?this.hooks.writerHosts():null;
    if(writers===null)return false;
    const authors=[...await this.mesh.authorHosts(),...writers];
    return !hosts.some(h=>authors.includes(h!));
  }
  /** Stop a remote review that will never be read (its candidate was corrected, or it lost the race to be recorded):
   * withdraw its lenses that have not really started (queued, or only held by a transport) and revoke what its lenses
   * were granted. */
  private async retireRemoteReview(reviewId:string){
    const review=await this.mesh.reviewStatus(leaderHost(),reviewId).catch(()=>null);
    for(const w of review?.work??[]){
      if(w.state!=='QUEUED'&&w.state!=='RUNNING')continue;
      // Refused for a lens its host really started; that one keeps running unread, without its grants.
      await this.mesh.withdrawUnstarted(leaderHost(),w.workId,'this review is no longer read').catch(()=>null);
      try{await this.hooks.abandoned?.({workId:w.workId,host:w.host});}catch{/* best effort */}
    }
  }
  private async startRemoteReview(record:HarnessRun,phase:ReviewPhase,kind:ReviewKind){
    const slot=reviewSlots[phase];
    const key=phase==='REVIEW'?`harness:${record.id}:review:${record.candidateSha}:${record.reviewAttempt??0}`:
      `harness:${record.id}:judgment-day:${record.candidateSha}:${record.judgmentAttempt??0}`;
    const remote=await this.mesh.startReview(leaderHost(),{missionId:record.id,kind,objective:record.objective,candidateSha:record.candidateSha!,idempotencyKey:key,
      materialFor:this.hooks.materialFor?host=>this.hooks.materialFor!(record,host):undefined,
      notesFor:(host,agentId)=>[this.hooks.accessFor?.(record,host,phase),reviewCompletionFormat(agentId,record.candidateSha!)].filter(Boolean).join('\n\n')});
    // Recorded only for the candidate it reviews: a correction may have landed since this tick read the run.
    const current=await this.write(s=>{const r=s.runs.find(x=>x.id===record.id)!;
      // Same candidate and same attempt: a session started before a drop must not come back as the current one.
      if(r.closedAt||r.candidateSha!==record.candidateSha||(r[slot.attempt]??0)!==(record[slot.attempt]??0))return false;
      if(!r[slot.id]){r[slot.id]=remote.id;r[slot.transport]='REMOTE';r.revision++;}return r[slot.id]===remote.id;});
    // A session nobody will read is stopped instead of dispatched (and granted).
    if(!current)return this.retireRemoteReview(remote.id);
    for(const workId of remote.workIds){const t=await this.mesh.workTarget(leaderHost(),workId).catch(()=>null);if(t)await this.dispatched(record,workId,phase,t.target);}
  }
  /** Advance a remote review session (4R or Judgment Day): pickup fallback, evidence retry, then Panter-RDD. */
  private async remoteReviewTick(runId:string,runtime:HarnessRuntime,phase:HarnessStep,reviewPhase:ReviewPhase,kind:ReviewKind,now:HarnessRun,
    common:{runId:string;mode:HarnessMode;risk:'LOW'|'HIGH';reason:string[];[key:string]:unknown}):Promise<HarnessTickResult>{
    const slot=reviewSlots[reviewPhase];const reviewId=now[slot.id]!;
    // Drop this session (only if it is still the current one) so the next tick starts a fresh attempt.
    const drop=(nativeOnly:boolean,retries?:number)=>this.write(s=>{const r=s.runs.find(x=>x.id===runId)!;if(r[slot.id]!==reviewId)return;
      r[slot.id]=null;r[slot.transport]=null;r[slot.attempt]=(r[slot.attempt]??0)+1;
      if(retries!==undefined)r[slot.retries]=retries;if(nativeOnly)r[slot.nativeOnly]=true;r.revision++;});
    const review=await this.mesh.reviewStatus(leaderHost(),reviewId);
    if(review.stage==='INTERRUPTED'){
      // Interrupted by a leader switch: close its queued lenses, drop the session and start a fresh
      // attempt (native until rebound).
      await this.mesh.abortInterruptedReview(leaderHost(),reviewId);
      // Lenses still running are never read again: revoke what they were granted.
      for(const w of review.work)if(w.state==='RUNNING')try{await this.hooks.abandoned?.({workId:w.workId,host:w.host});}catch{/* best effort */}
      // A lens withdrawn for a missed pickup means its host did not show up: the retry runs native.
      await drop(review.work.some(w=>w.withdrawn));
      return this.tick(runId,runtime);
    }
    if(review.stage==='AWAITING_REPORTS')
      for(const w of review.work)if(w.state==='QUEUED'||w.state==='RUNNING')await this.dispatched(now,w.workId,reviewPhase,w.host);
    if(review.stage==='AWAITING_REPORTS'&&this.hooks.pickupTimeoutMs){
      const stale=(await Promise.all(review.review.workIds.map(async id=>({id,stale:await this.unstartedTooLong(id)})))).filter(x=>x.stale);
      // Only a stale lens that was really withdrawn drops the session: a lens its host claimed in the meantime
      // keeps the remote review alive (and its result is read).
      const withdrawn=[];
      for(const s of stale){
        const r=await this.mesh.withdrawUnstarted(leaderHost(),s.id,'review lens host did not start in time; review runs native').catch(()=>null);
        if(r?.withdrawn||r?.state==='ABORTED_NO_EFFECTS')withdrawn.push(s);
      }
      if(withdrawn.length){
        // A lens host did not show up in time: drop this remote session and run the whole review native.
        for(const w of review.work){
          if(withdrawn.some(s=>s.id===w.workId))continue;
          const r=w.state==='QUEUED'?await this.mesh.withdrawUnstarted(leaderHost(),w.workId,'review lens host did not start in time; review runs native').catch(()=>null):null;
          // A lens already running keeps running, but its result is never read: revoke what it was granted.
          if(!r?.withdrawn&&(w.state==='RUNNING'||w.state==='QUEUED'))
            try{await this.hooks.abandoned?.({workId:w.workId,host:w.host});}catch{/* best effort */}
        }
        await drop(true);
        const next=await this.tick(runId,runtime);
        return {...next,fallback:{phaseId:phase.id,from:[...new Set(withdrawn.map(s=>s.stale!.host))],reason:'REVIEW_PICKUP_TIMEOUT'}};
      }
    }
    const evidence=assessMeshReview({kind:review.review.kind,candidateSha:review.review.candidateSha,work:review.work});
    // Every lens finished but some report cannot be used (failed, unstructured or not bound to this lens and SHA):
    // the session can never complete, so review the same candidate again — once remote, then native. A session where
    // any lens reports anything severe — in an accepted report, a failed lens or any text that is not a usable report — is
    // never retried away: that needs the leader.
    if(review.stage==='READY_FOR_CONTROLLER'&&evidence.status==='EVIDENCE_INCOMPLETE'&&
      !evidence.reasons.some(x=>x.startsWith('Severe finding(s)'))&&
      !review.work.some(w=>mentionsSevere(w.result,w.state,w.agentId??'',review.review.candidateSha))){
      const retries=now[slot.retries]??0;
      await drop(retries>=1,retries+1);
      const next=await this.tick(runId,runtime);
      return {...next,retry:{phaseId:phase.id,previousReviewId:reviewId,reason:'REVIEW_EVIDENCE_INCOMPLETE',
        reasons:evidence.reasons,native:retries>=1}};
    }
    if(this.rdd&&review.stage==='READY_FOR_CONTROLLER'){
      const tx=await this.rdd.begin({missionId:now.id,reviewId,source:'REMOTE',
        candidateSha:now.candidateSha!,kind,localProject:now.project,repository:now.githubRepository??(githubProject.test(now.project)?now.project:undefined),
        prNumber:now.githubPrNumber,expectedBase:now.githubExpectedBase,deliveryStrategy:now.deliveryStrategy,
        implementerRunId:now.correctionRunId??now.steps.find(x=>x.phase==='IMPLEMENT')?.result?.runId,
        implementerRunIds:this.authorRunIds(now)});
      const verdict=await this.rdd.assess(tx.id);
      if(verdict.record.state==='APPROVED_PENDING_ACK')await this.rdd.acknowledge(tx.id,verdict.record.revision);
      if(['APPROVED_PENDING_ACK','ACKNOWLEDGED'].includes(verdict.record.state)){
        // Only the session still current for the run completes its phase (a correction may have dropped it meanwhile).
        await this.write(s=>{const r=s.runs.find(x=>x.id===runId)!;const item=r.steps.find(x=>x.id===phase.id)!;
          if(!r.closedAt&&r[slot.id]===reviewId&&item.status!=='COMPLETE'){item.status='COMPLETE';r.revision++;}});
        return this.tick(runId,runtime);
      }
      // Panter-RDD will not attest this remote Judgment Day (e.g. a judge host became a writer after dispatch): judge
      // the same candidate native instead of waiting forever.
      if(reviewPhase==='JUDGMENT'&&verdict.record.state==='NEEDS_RUNNER_ATTESTATION'){
        await drop(true);
        const next=await this.tick(runId,runtime);
        return {...next,fallback:{phaseId:phase.id,previousReviewId:reviewId,reason:'REMOTE_JUDGMENT_NOT_ATTESTABLE'}};
      }
      return {...common,status:verdict.record.state,phaseId:phase.id,reviewId,review:evidence,panterRdd:verdict,next:[]};
    }
    return {...common,status:review.stage==='AWAITING_REPORTS'?'WAITING_REMOTE_REVIEW':
      evidence.status==='EVIDENCE_INCOMPLETE'?'REVIEW_EVIDENCE_INCOMPLETE':'AWAITING_RDD_AUTHORITY',
      phaseId:phase.id,reviewId,review:evidence,next:[]};
  }
  private constructor(private readonly sqlite:SqliteLedger,private readonly mesh:MeshEngine,private readonly native:NativeSubagentReview,private readonly github?:GitHubDeliveryGate,private readonly officialRdd?:NativeReviewBridge,private readonly rdd?:PanterRdd,private readonly requireWriteGrant=false){}
  static async open(dir:string,mesh:MeshEngine,native:NativeSubagentReview,github?:GitHubDeliveryGate,officialRdd?:NativeReviewBridge,rdd?:PanterRdd,requireWriteGrant=false){
    const engine=new AutomaticHarness(SqliteLedger.open(dir),mesh,native,github,officialRdd,rdd,requireWriteGrant);
    const value:unknown=engine.sqlite.read('harness',engine.state);
    ensure(!!value&&typeof value==='object'&&'version' in value&&value.version===1&&'runs' in value&&Array.isArray(value.runs),'Invalid harness store');
    engine.state=value as State;
    return engine;
  }
  private async read<T>(fn:(s:State)=>T){
    await this.pending;
    this.state=this.sqlite.read('harness',this.state);
    return structuredClone(fn(this.state));
  }
  private async write<T>(fn:(s:State)=>T){
    const task=this.pending.then(()=>{
      const {after,result}=this.sqlite.mutate('harness',this.state,fn);
      this.state=after;
      return result;
    });
    this.pending=task.then(()=>undefined,()=>undefined);
    return task;
  }

  /** An authenticated operator grants narrowly scoped source-write authority; model prose is not a grant. */
  async grantWrite(input:{project:string;objective:string;allowedPaths:string[];ttlSeconds:number}){
    ensure(input.project.length>0&&input.project.length<=100,'Invalid grant project');
    ensure(input.objective.trim().length>0&&input.objective.length<=6000,'Invalid grant objective');
    ensure(Number.isInteger(input.ttlSeconds)&&input.ttlSeconds>=60&&input.ttlSeconds<=86400,'Invalid grant TTL');
    const paths=[...new Set(input.allowedPaths.map(safePath))];ensure(paths.length>0&&paths.length<=16,'Grant requires bounded paths');
    return this.write(s=>{const grant:WriteGrant={id:randomUUID(),project:input.project,objectiveDigest:hash(input.objective),allowedPaths:paths,
      expiresAt:Date.now()+input.ttlSeconds*1000,boundRunId:null};(s.grants??=[]).push(grant);
      return {grantId:grant.id,project:grant.project,allowedPaths:paths,expiresAt:grant.expiresAt};});
  }
  async start(input:HarnessInput){
    const selected=chooseHarness(input);
    const digest=hash({project:input.project,githubRepository:input.githubRepository??null,githubPrNumber:input.githubPrNumber??null,githubExpectedBase:input.githubExpectedBase??null,objective:input.objective,key:input.idempotencyKey,permission:input.writesAuthorized,writeGrantId:input.writeGrantId??null,paths:selected.paths,mode:selected.mode,risk:selected.risk,review:selected.reviewKind,judgmentRequested:input.judgmentDayRequested===true,observations:input.observations??{}});
    return this.write(s=>{
      const old=s.runs.find(r=>r.project===input.project&&r.key===input.idempotencyKey);
      if(old){ensure(old.inputDigest===digest,'Harness start idempotency conflict');return old;}
      let grant:WriteGrant|undefined;
      // An explicitly supplied grant is always enforced (owner mode only makes it optional).
      if(input.writesAuthorized&&(this.requireWriteGrant||!!input.writeGrantId)){
        ensure(!!input.writeGrantId,'Operator write grant required');
        grant=s.grants?.find(g=>g.id===input.writeGrantId);
        ensure(grant&&grant.project===input.project&&grant.objectiveDigest===hash(input.objective)&&grant.expiresAt>Date.now()&&!grant.boundRunId,
          'Missing, expired, or already consumed operator write grant');
        for(const path of selected.paths)ensure(grant.allowedPaths.some(allowed=>path===allowed||path.startsWith(allowed+'/')),'Change surface exceeds operator grant');
      }
      const step=(phase:HarnessPhase):HarnessStep=>({id:randomUUID(),phase,
        agentId:phase==='DISCOVER'?'gentle-ai-explore':phase==='IMPLEMENT'?'gentle-ai-worker':phase==='VERIFY'?'gentle-ai-verify':null,
        status:'PENDING'});
      const run:HarnessRun={id:randomUUID(),project:input.project,githubRepository:input.githubRepository,githubPrNumber:input.githubPrNumber,githubExpectedBase:input.githubExpectedBase,objective:input.objective,key:input.idempotencyKey,inputDigest:digest,
        permission:input.writesAuthorized?'WRITE_APPROVED':'READ_ONLY',writeGrantId:grant?.id,mode:selected.mode,
        // Owner mode with a bounded grant and no listed surfaces: the grant's paths are the scope, not the whole repository.
        paths:selected.paths.length||!grant?selected.paths:[...grant.allowedPaths],risk:selected.risk,reviewTier:selected.tier,reason:selected.reasons,candidateSha:null,reviewKind:selected.reviewKind,
        reviewId:null,reviewTransport:null,judgmentRequested:input.judgmentDayRequested===true,judgmentId:null,correctionAttempts:0,steps:selected.phases.map(step),createdAt:new Date().toISOString(),revision:1};
      if(grant)grant.boundRunId=run.id;
      s.runs.push(run);return run;
    });
  }
  get(runId:string){return this.read(s=>s.runs.find(r=>r.id===runId)??null);}
  async authorizeDelegatedWrite(id:string,paths:string[]){
    const run=await this.get(id);
    ensure(run?.permission==='WRITE_APPROVED'&&run.writeGrantId&&paths.length>0,'Authorized run required');
    ensure(!run.closedAt,'Harness run is closed');
    const grant=await this.read(s=>s.grants?.find(g=>g.id===run.writeGrantId));
    ensure(grant&&grant.boundRunId===id&&grant.expiresAt>Date.now(),'Active operator grant required');
    for(const p of paths)ensure(run.paths.some(q=>p===q||p.startsWith(q+'/'))&&grant.allowedPaths.some(q=>p===q||p.startsWith(q+'/')),'Out-of-scope writer');
  }
  /** Every author of the frozen candidate is excluded from independent review. */
  private authorRunIds(run:HarnessRun):string[]{
    return [...new Set([run.steps.find(x=>x.phase==='IMPLEMENT')?.result?.runId,
      ...(run.units??[]).map(u=>u.runId),...(run.correctionRunIds??[]),run.correctionRunId]
      .filter((id):id is string=>typeof id==='string'&&id.length>0))].sort();
  }
  /** Bound grant checks are repeated at each new write packet, not just mission start. */
  private async activeWriteGrant(runId:string,paths:string[]):Promise<boolean>{
    if(!this.requireWriteGrant&&!(await this.get(runId))?.writeGrantId)return true;
    try{await this.authorizeDelegatedWrite(runId,paths);return true;}catch{return false;}
  }

  /** Bind a PR discovered/created by an authorized host after work started.
   * This changes only Panter's routing metadata, never the remote repository. */
  async bindGithub(runId:string,input:{repository:string;prNumber:number;expectedBase?:string},expectedRevision:number){
    ensure(!!this.github&&this.github.allows(input.repository),'GitHub destination not allowed by operator');
    ensure(Number.isInteger(input.prNumber)&&input.prNumber>0,'Invalid GitHub PR number');
    ensure(!input.expectedBase||/^[a-zA-Z0-9._/-]{1,100}$/.test(input.expectedBase),'Invalid GitHub PR base');
    return this.write(s=>{
      const r=s.runs.find(x=>x.id===runId);ensure(r,'Harness not found');ensure(!r.closedAt,'Harness run is closed');
      if(r.githubRepository)ensure(r.githubRepository===input.repository,'GitHub repository cannot be changed during a run');
      if(r.githubPrNumber){
        ensure(r.githubPrNumber===input.prNumber&&(!r.githubExpectedBase||r.githubExpectedBase===input.expectedBase),'PR binding conflict');
        return r;
      }
      ensure(r.revision===expectedRevision,'Stale harness revision');
      r.githubRepository=input.repository;r.githubPrNumber=input.prNumber;
      if(input.expectedBase)r.githubExpectedBase=input.expectedBase;
      r.revision++;return r;
    });
  }

  /** The leader closes a run it will not finish (abandoned, superseded, stuck in an old format). The run never advances
   * again; its queued remote work is withdrawn and the grants of all its remote work are revoked. Idempotent. */
  async close(runId:string,reason:string,expectedRevision:number){
    ensure(reason.trim().length>0&&reason.length<=500,'Close reason required');
    let works:string[]=[],sessions:string[]=[];
    const closed=await this.write(s=>{const r=s.runs.find(x=>x.id===runId);ensure(r,'Harness not found');
      // Closing again keeps the first close but repeats the cleanup below (it heals a crash after the write).
      if(!r.closedAt){ensure(r.revision===expectedRevision,'Stale harness revision');
        r.closedAt=new Date().toISOString();r.closedReason=reason.trim();r.revision++;}
      works=r.steps.filter(st=>st.execution==='REMOTE_A2A'&&st.remoteWorkId&&st.status!=='COMPLETE').map(st=>st.remoteWorkId!);
      sessions=[r.reviewTransport==='REMOTE'?r.reviewId:null,r.judgmentTransport==='REMOTE'?r.judgmentId:null].filter((x):x is string=>!!x);
      return r;});
    for(const id of works)await this.retireWork(id,`harness run closed: ${(closed.closedReason??reason).slice(0,200)}`);
    for(const id of sessions)await this.retireRemoteReview(id);
    return closed;
  }
  /** Stop one remote work whose result will never be read: withdraw it if it has not really started, revoke its grants. */
  private async retireWork(workId:string,reason:string){
    const t=await this.mesh.workTarget(leaderHost(),workId).catch(()=>null);if(!t)return;
    if(t.state==='QUEUED'||t.state==='RUNNING')await this.mesh.withdrawUnstarted(leaderHost(),workId,reason).catch(()=>null);
    if(t.state==='QUEUED'||t.state==='RUNNING')try{await this.hooks.abandoned?.({workId,host:t.target});}catch{/* best effort */}
  }

  /** Only the authenticated operator can persist a delivery strategy; it is not a model choice. */
  /** Register a real bounded correction only after a new Git candidate was produced.
   * An A2A/model report alone cannot prove this SHA; local/GitHub RDD verifies it again.
   * A correction cannot expand original authorization or reuse the former review.
   */
  async recordCorrection(runId:string,payload:{candidateSha:string;runId:string;evidence:string[]},expectedRevision:number){
    ensure(shaPattern.test(payload.candidateSha)&&payload.candidateSha.length===40,'Correction needs exact Git commit SHA');
    ensure(/^[A-Za-z0-9._:-]{8,160}$/.test(payload.runId),'Correction run identity required');
    ensure(Array.isArray(payload.evidence)&&payload.evidence.length>0&&payload.evidence.length<=30&&
      payload.evidence.every(x=>typeof x==='string'&&x.trim()&&x.length<=1000),'Correction evidence required');
    if(!(await this.activeWriteGrant(runId,(await this.get(runId))?.paths??[])))throw new Error('Active operator grant required for correction');
    // Remote review sessions this correction drops: their lenses are stopped once the write succeeded.
    let retired:string[]=[],retiredWorks:string[]=[];
    const corrected=await this.write(s=>{const r=s.runs.find(x=>x.id===runId);ensure(r,'Harness not found');ensure(!r.closedAt,'Harness run is closed');
      ensure(r.revision===expectedRevision,'Stale correction revision');
      ensure(r.permission==='WRITE_APPROVED'&&(ownerMode()||r.paths.length>0),'Correction is not authorized within a scoped writable run');
      ensure((r.correctionAttempts??0)<(ownerMode()?10:2),'Correction attempt budget exhausted');
      ensure(r.candidateSha&&r.candidateSha!==payload.candidateSha,'Corrected candidate requires a fresh SHA');
      const review=r.steps.find(st=>st.phase==='REVIEW');const judgment=r.steps.find(st=>st.phase==='JUDGMENT');
      ensure(review||judgment,'No review requiring correction');
      ensure(!review||review.status!=='COMPLETE'||(!!judgment&&judgment.status!=='COMPLETE'&&!!r.judgmentId),'Closed review cannot be silently rewritten');
      retired=[r.reviewTransport==='REMOTE'?r.reviewId:null,r.judgmentTransport==='REMOTE'?r.judgmentId:null].filter((x):x is string=>!!x);
      r.previousReviewId=r.reviewId;
      r.candidateSha=payload.candidateSha;r.reviewId=null;r.reviewTransport=null;r.judgmentId=null;r.judgmentTransport=null;
      r.correctionAttempts=(r.correctionAttempts??0)+1;r.correctionRunId=payload.runId;r.reviewEvidenceRetries=0;r.judgmentEvidenceRetries=0;
      r.correctionRunIds=[...new Set([...(r.correctionRunIds??[]),payload.runId])];
      for(const step of r.steps)if(['VERIFY','REVIEW','JUDGMENT'].includes(step.phase)){
        // A remote verification still in flight checks the old candidate: it is stopped below, never read.
        if(step.execution==='REMOTE_A2A'&&step.remoteWorkId&&step.status==='ISSUED')retiredWorks.push(step.remoteWorkId);
        step.status='PENDING';step.execution=undefined;step.remoteWorkId=undefined;step.result=undefined;
      }
      r.revision++;return r;});
    for(const id of retiredWorks)await this.retireWork(id,'candidate corrected; this phase runs again on the new candidate');
    for(const id of retired)await this.retireRemoteReview(id);
    return corrected;
  }

  /** GPT-A derives independent work units from the design; the user never picks agents.
   * Each unit must have a disjoint and explicitly scoped surface. Separate worktrees
   * and actual child processes are responsibilities of the trusted host runner. */
  async defineUnits(runId:string,units:Array<{objective:string;paths:string[]}>,expectedRevision:number){
    if(!(await this.activeWriteGrant(runId,(await this.get(runId))?.paths??[])))throw new Error('Active operator grant required for implementation units');
    ensure(units.length>=2&&units.length<=16,'Parallel implementation requires 2-16 units');
    const derived=units.map(u=>{ensure(u.objective.trim().length>0&&u.objective.length<=3000,'Invalid unit objective');
      const paths=[...new Set(u.paths.map(safePath))];ensure(paths.length>0&&paths.length<=12,'Units require scoped paths');
      return {id:randomUUID(),objective:u.objective,paths,state:'PENDING' as const};});
    for(let i=0;i<derived.length;i++)for(let j=i+1;j<derived.length;j++)for(const a of derived[i]!.paths)for(const b of derived[j]!.paths)
      ensure(a!==b&&!a.startsWith(b+'/')&&!b.startsWith(a+'/'),'Parallel writer scopes overlap');
    return this.write(s=>{const r=s.runs.find(x=>x.id===runId);ensure(r,'Harness not found');ensure(!r.closedAt,'Harness run is closed');
      ensure(r.revision===expectedRevision,'Stale harness revision');
      ensure(r.permission==='WRITE_APPROVED','Read-only mission cannot request writers');
      const implement=r.steps.find(x=>x.phase==='IMPLEMENT');ensure(implement?.status==='PENDING','Cannot redefine issued implementation');
      ensure(r.steps.find(x=>x.phase==='DESIGN')?.status==='COMPLETE','Design phase must finish before splitting work');
      ensure(!r.units,'Implementation units already frozen');
      for(const u of derived)for(const path of u.paths)
        ensure(r.paths.some(scope=>path===scope||path.startsWith(scope+'/')),'Unit scope exceeds authorized work surface');
      r.units=derived;r.revision++;return r;});
  }
  async reportUnit(runId:string,unitId:string,result:{runId:string;summary:string;evidence:string[]}){
    ensure(/^[A-Za-z0-9._:-]{8,160}$/.test(result.runId)&&result.runId!==leaderHost(),'Native child run identity required');
    ensure(result.summary.trim().length>0&&result.summary.length<=3000,'Invalid unit summary');
    ensure(Array.isArray(result.evidence)&&result.evidence.length>0&&result.evidence.length<=30&&result.evidence.every(x=>typeof x==='string'&&x.trim()&&x.length<=1000),'Unit evidence required');
    return this.write(s=>{const r=s.runs.find(x=>x.id===runId);ensure(r,'Harness not found');ensure(!r.closedAt,'Harness run is closed');
      const step=r.steps.find(x=>x.phase==='IMPLEMENT');ensure(step?.status==='ISSUED','Parallel implementation was not issued');
      const unit=r.units?.find(x=>x.id===unitId);ensure(unit,'Unknown implementation unit');
      if(unit.state==='REPORTED'){
        ensure(unit.runId===result.runId&&unit.summary===result.summary&&JSON.stringify(unit.evidence)===JSON.stringify(result.evidence),'Conflicting unit result');
        return r;
      }
      ensure(!r.units!.some(u=>u.runId===result.runId),'Native child run reused across writer units');
      unit.state='REPORTED';unit.runId=result.runId;unit.summary=result.summary;unit.evidence=result.evidence;r.revision++;return r;});
  }

  async setDeliveryStrategy(runId:string,strategy:'single-pr'|'feature-branch-chain'|'stacked-to-main',expectedRevision:number){
    return this.write(s=>{const r=s.runs.find(x=>x.id===runId);ensure(r,'Harness not found');ensure(!r.closedAt,'Harness run is closed');
      ensure(r.revision===expectedRevision,'Stale harness revision');
      ensure(!r.deliveryStrategy||r.deliveryStrategy===strategy,'Delivery strategy already frozen');
      r.deliveryStrategy=strategy;r.revision++;return r;});
  }

  async report(runId:string,stepId:string,payload:{summary:string;evidence:string[];runId?:string;candidateSha?:string;discoveredPaths?:string[]}){
    ensure(payload.summary.trim().length>0&&payload.summary.length<=6000,'Invalid report summary');
    ensure(Array.isArray(payload.evidence)&&payload.evidence.length>0&&payload.evidence.length<=40&&payload.evidence.every(x=>typeof x==='string'&&!!x.trim()&&x.length<=1000),'Concrete evidence required');
    if(payload.candidateSha!==undefined)ensure(shaPattern.test(payload.candidateSha),'Invalid candidate SHA');
    const discovered=[...new Set((payload.discoveredPaths??[]).map(safePath))];
    ensure(discovered.length<=16,'Too many discovery paths');
    return this.write(s=>{
      const r=s.runs.find(x=>x.id===runId);ensure(r,'Harness not found');ensure(!r.closedAt,'Harness run is closed');
      const step=r.steps.find(x=>x.id===stepId);ensure(step,'Unknown harness step');
      const i=r.steps.indexOf(step);
      ensure(r.steps.slice(0,i).every(x=>x.status==='COMPLETE'),'Previous phases are incomplete');
      ensure(step.phase!=='REVIEW'&&step.phase!=='JUDGMENT','Review evidence must be submitted through review slots');
      const digest=hash({stepId,payload});
      if(step.status==='COMPLETE'){ensure(step.result?.digest===digest,'Conflicting immutable harness report');return r;}
      ensure(step.status==='ISSUED','Phase packet must be issued before reporting');
      if(step.phase==='DISCOVER' && discovered.length){
        if((this.requireWriteGrant||!!r.writeGrantId)&&r.permission==='WRITE_APPROVED'){
          const grant=s.grants?.find(g=>g.id===r.writeGrantId);ensure(grant,'Missing original grant');
          for(const path of discovered)ensure(grant.allowedPaths.some(allowed=>path===allowed||path.startsWith(allowed+'/')),
            'Discovered edit surface exceeds operator grant');
        }
        r.paths=[...new Set([...r.paths,...discovered])];
      }
      if(step.phase==='IMPLEMENT'){
        ensure(!r.units||r.units.every(u=>u.state==='REPORTED'),'All isolated implementation units must finish before integration');
        ensure(r.permission==='WRITE_APPROVED','Unauthorized implementation');
        ensure(ownerMode()||r.paths.length>0,'No discovery-confirmed edit surfaces');
        if(r.risk==='HIGH'||r.judgmentRequested||!!r.githubRepository||githubProject.test(r.project))ensure(!!payload.candidateSha,'GitHub/high-risk implementation needs frozen candidate SHA');
        if(r.githubRepository||githubProject.test(r.project))ensure(!!payload.candidateSha&&/^[a-f0-9]{40}$/.test(payload.candidateSha),'GitHub requires an exact 40-character Git commit SHA');
        r.candidateSha=payload.candidateSha??null;
      }
      if(step.phase==='VERIFY'){
        ensure(payload.candidateSha===r.candidateSha&&!!r.candidateSha,'Verifier must report exact candidate SHA');
        if(step.execution==='GPT_A_INLINE'){
          ensure(payload.runId===leaderHost(),`Solo verifier must identify ${leaderLabel()} itself; no fabricated independent run ID`);
        }else{
          ensure(!!payload.runId&&payload.runId!==leaderHost()&&payload.runId!==r.steps.find(x=>x.phase==='IMPLEMENT')?.result?.runId&&payload.runId!==r.correctionRunId&&!(r.units??[]).some(u=>u.runId===payload.runId),
            'Independent verifier run ID required');
        }
      }
      step.status='COMPLETE';step.result={summary:payload.summary,evidence:payload.evidence,runId:payload.runId,digest,
        verificationMode:step.phase==='VERIFY'?(step.execution==='GPT_A_INLINE'?'SELF_UNVERIFIED':'HOST_REPORTED_UNVERIFIED'):undefined};
      r.revision++;return r;
    });
  }
  private closedResult(record:HarnessRun):HarnessTickResult{
    return {runId:record.id,mode:record.mode,risk:record.risk,reason:record.reason,status:'HARNESS_CLOSED',
      closedAt:record.closedAt,closedReason:record.closedReason,next:[]};
  }
  async tick(runId:string,runtime:HarnessRuntime):Promise<HarnessTickResult>{
    const result=await this.tickOnce(runId,runtime);
    if(result.status==='HARNESS_CLOSED'||!Array.isArray(result.next)||!result.next.length)return result;
    // Closed while this tick prepared work: the host is handed nothing to execute (closing already stopped the
    // run's remote work and its grants).
    const now=await this.get(runId);
    return now?.closedAt?this.closedResult(now):result;
  }
  private async tickOnce(runId:string,runtime:HarnessRuntime):Promise<HarnessTickResult>{
    ensure(Number.isInteger(runtime.maxParallelSubagents)&&runtime.maxParallelSubagents>=0&&runtime.maxParallelSubagents<=32,'Invalid host native capacity');
    const record=await this.get(runId);ensure(record,'Harness not found');
    if(record.closedAt)return this.closedResult(record);
    const phase=record.steps.find(s=>s.status!=='COMPLETE');
    const profile=(await this.mesh.profiles()).find(p=>p.host===leaderHost());
    // An operator may switch to GPT_A_ONLY mid-mission. Never dispatch fresh
    // remote work after that change, or silently reassign an in-flight write.
    const effectiveMode:HarnessMode=record.mode==='GPT_A_ONLY'||profile?.coordinationMode==='GPT_A_ONLY'?'GPT_A_ONLY':'AUTO';
    const policy=hostRequest(leaderPolicyProfile());
    const common={runId:record.id,mode:effectiveMode,risk:record.risk,reason:record.reason,
      capacityRequest:{model:policy.model,reasoning:policy.reasoningEffort,workerProcessing:policy.worker.preferredProcessing,
        requestedParallelism:Math.min(runtime.nativeSubagents?runtime.maxParallelSubagents:0,policy.plannerCeiling),
        capacityVerified:false},modelWorkersStartedByServer:0,approved:false};
    if(!phase){
      // A solo 4R is a real four-lens inspection, but not independent authority.
      // Redo it with new frozen slots when native children become available.
      if(record.reviewTransport==='NATIVE'&&record.reviewId&&runtime.nativeSubagents&&runtime.maxParallelSubagents>0){
        const previous=await this.native.status(record.reviewId);
        if(previous.soloEvidenceComplete){
          await this.write(state=>{const run=state.runs.find(r=>r.id===runId)!;
            const review=run.steps.find(step=>step.phase==='REVIEW');
            if(run.closedAt||!review||review.status!=='COMPLETE')return;
            review.status='PENDING';run.reviewId=null;run.reviewTransport=null;
            const verify=run.steps.find(step=>step.phase==='VERIFY');
            if(verify?.result?.verificationMode==='SELF_UNVERIFIED'){
              verify.status='PENDING';verify.result=undefined;verify.execution=undefined;verify.remoteWorkId=undefined;
            }
            run.reviewAttempt=(run.reviewAttempt??0)+1;run.revision++;
          });
          return this.tick(runId,runtime);
        }
      }
      const repository=record.githubRepository??(githubProject.test(record.project)?record.project:null);
      const nativeVerdict=this.rdd&&record.reviewId?await this.rdd.getForReview(record.reviewId):null;
      if(record.risk==='HIGH'&&nativeVerdict?.state!=='ACKNOWLEDGED'){
        const solo=record.reviewTransport==='NATIVE'&&record.reviewId?await this.native.status(record.reviewId):null;
        if(solo?.soloEvidenceComplete)return {...common,status:'SOLO_4R_COMPLETED_UNVERIFIED',reviewId:record.reviewId??undefined,review:solo,
          verificationMode:record.steps.find(s=>s.phase==='VERIFY')?.result?.verificationMode??null,
          rdd:nativeVerdict,next:[],approved:false,
          instruction:`${leaderLabel()} completed all four self-review lenses. These are not independent: a new signed native 4R is still required for RDD approval and merge.`};
        return {...common,status:'AWAITING_PANTER_RDD_AUTHORITY',rdd:nativeVerdict,next:[]};
      }
      const judgmentVerdict=this.rdd&&record.judgmentId?await this.rdd.getForReview(record.judgmentId):null;
      if(record.judgmentRequested&&judgmentVerdict?.state!=='ACKNOWLEDGED')return {...common,status:'AWAITING_JUDGMENT_RDD_AUTHORITY',rdd:judgmentVerdict,next:[]};
      if(!repository)return {...common,status:record.risk==='HIGH'?'PANTER_RDD_REVIEWED_NO_GITHUB_DELIVERY_AUTHORITY':'REPORTED_COMPLETE_UNVERIFIED',next:[]};
      if(!record.githubPrNumber)return {...common,status:'AWAITING_GITHUB_PR_EVIDENCE',next:[],instruction:`${leaderLabel()} must identify or obtain permission to create the exact target PR; never push or open a PR without authorization.`};
      if(!record.candidateSha||!(/^[a-f0-9]{40}$/.test(record.candidateSha)))return {...common,status:'BLOCKED_CANDIDATE_SHA',next:[]};
      if(!this.github)return {...common,status:'GITHUB_VERIFICATION_NOT_CONFIGURED',next:[]};
      const github=await this.github.inspect({repository,prNumber:record.githubPrNumber,expectedSha:record.candidateSha,expectedBase:record.githubExpectedBase,deliveryStrategy:record.deliveryStrategy,parentAuthorizedSinglePr:record.deliveryStrategy==='single-pr'});
      return {...common,status:github.state==='REVIEWABLE'?(record.risk==='HIGH'?'PANTER_RDD_REVIEWED_NO_DELIVERY_AUTHORITY':'GITHUB_EVIDENCE_READY_NO_DELIVERY_AUTHORITY'):'GITHUB_GATE_BLOCKED',github,next:[],
        instruction:'GitHub verification is evidence, not permission for commit, push, merge, release, or deployment.'};
    }
    if(phase.execution==='REMOTE_A2A'&&phase.remoteWorkId){
      const inbox=await this.mesh.inbox(leaderHost());
      const work=inbox.works.find(w=>w.id===phase.remoteWorkId);
      if(work?.state==='ABORTED_NO_EFFECTS'){
        await this.write(s=>{const r=s.runs.find(x=>x.id===runId)!;
          const st=r.steps.find(x=>x.id===phase.id)!;
          // A concurrent tick may already have reset this step after withdrawing it.
          if(!(st.execution==='REMOTE_A2A'&&st.remoteWorkId===work.id&&st.status==='ISSUED'))return;
          st.execution=undefined;st.remoteWorkId=undefined;st.status='PENDING';
          // Withdrawn by the leader (missed pickup, or a lost lease): never re-send to that host, run it native.
          if(work.withdrawn){st.nativeOnly=true;st.fallbackFrom=work.target;}
          st.redispatchGeneration=(st.redispatchGeneration??0)+1;r.revision++;
        });
        if(work.withdrawn)try{await this.hooks.abandoned?.({workId:work.id,host:work.target});}catch{/* best effort */}
        return {...common,status:'REMOTE_NO_EFFECTS_RECONCILED',phaseId:phase.id,workId:work.id,
          next:[],instruction:work.withdrawn?'The leader withdrew this work without effects; the phase runs native on the next tick.':
            'The trusted operator confirmed no effects. A NEW fenced attempt may be dispatched on the next tick if authorization is still valid.'};
      }
      const readOnly=phase.phase==='DISCOVER'||phase.phase==='VERIFY';
      const expired=readOnly&&work?.state==='RUNNING'?await this.leaseLostTooLong(work.id):null;
      // End the orphaned work in the mesh first (atomically refused if the host came back), so it never stays RUNNING.
      const lost=expired?(await this.mesh.abandonExpiredReadOnly(leaderHost(),work!.id,expired.limit,
        `${expired.host} let its lease expire for more than ${Math.round(expired.limit/1000)}s`).catch(()=>null))?.abandoned===true:false;
      if(work&&(work.state==='FAILED'||work.state==='OUTCOME_UNKNOWN'||lost)){
        // A read-only phase (discovery, verification) has nothing to reconcile: at most a verifier's PR comment, which
        // no gate reads. Revoke that work's grant and run the phase native instead of waiting for an operator. A writer
        // still waits.
        if(readOnly){
          const reset=await this.write(s=>{const r=s.runs.find(x=>x.id===runId)!;const st=r.steps.find(x=>x.id===phase.id)!;
            if(!(st.execution==='REMOTE_A2A'&&st.remoteWorkId===work.id&&st.status==='ISSUED'))return false;
            st.execution=undefined;st.remoteWorkId=undefined;st.status='PENDING';st.nativeOnly=true;st.fallbackFrom=work.target;
            st.redispatchGeneration=(st.redispatchGeneration??0)+1;r.revision++;return true;});
          if(reset)try{await this.hooks.abandoned?.({workId:work.id,host:work.target});}catch{/* best effort */}
          const next=await this.tick(runId,runtime);
          return reset?{...next,fallback:{phaseId:phase.id,from:work.target,
            reason:lost?'REMOTE_LEASE_LOST':work.state==='FAILED'?'REMOTE_FAILED':'REMOTE_OUTCOME_UNKNOWN'}}:next;
        }
        return {...common,status:'REMOTE_OUTCOME_NEEDS_RECONCILIATION',phaseId:phase.id,workId:phase.remoteWorkId,next:[]};
      }
      if(work?.state==='COMPLETED'){
        // Result is persisted in the Mesh ledger and never echoed via inbox.
        const persisted=await this.mesh.resultGet(leaderHost(),phase.remoteWorkId);
        const result=structuredResult(persisted.result);
        if(!result||typeof result!=='object'||!('summary' in result)||!('evidence' in result))
          return {...common,status:'REMOTE_RESULT_NEEDS_STRUCTURED_EVIDENCE',phaseId:phase.id,workId:phase.remoteWorkId,next:[]};
        if(!reportable(result))return {...common,status:'REMOTE_RESULT_NEEDS_STRUCTURED_EVIDENCE',phaseId:phase.id,workId:phase.remoteWorkId,next:[]};
        // Host-controlled content can still fail a phase rule checked inside the write (scope, SHA, verifier
        // independence): surface the reason instead of throwing from every tick; the leader can report by hand.
        try{await this.report(runId,phase.id,result);}
        catch(error){return {...common,status:'REMOTE_RESULT_REJECTED',phaseId:phase.id,workId:phase.remoteWorkId,next:[],
          detail:error instanceof Error?error.message.slice(0,300):'rejected'};}
        return this.tick(runId,runtime);
      }
      const stale=await this.unstartedTooLong(phase.remoteWorkId);
      if(stale){
        const withdrawn=await this.mesh.withdrawUnstarted(leaderHost(),phase.remoteWorkId,
          `${stale.host} did not start this phase within ${Math.round(stale.limit/1000)}s`).catch(()=>null);
        if(withdrawn?.withdrawn){
          await this.write(s=>{const r=s.runs.find(x=>x.id===runId)!;const st=r.steps.find(x=>x.id===phase.id)!;
            if(st.status==='ISSUED'&&st.remoteWorkId===phase.remoteWorkId){st.status='PENDING';st.execution=undefined;st.remoteWorkId=undefined;
              st.redispatchGeneration=(st.redispatchGeneration??0)+1;st.nativeOnly=true;st.fallbackFrom=stale.host;r.revision++;}});
          const next=await this.tick(runId,runtime);
          return {...next,fallback:{phaseId:phase.id,from:stale.host,reason:'PICKUP_TIMEOUT',afterSeconds:Math.round(stale.limit/1000)}};
        }
      }
      // Grants are re-issued while waiting (an identical grant is a no-op), so a lost or failed first grant heals.
      if(work&&(work.state==='QUEUED'||work.state==='RUNNING'))await this.dispatched(record,work.id,phase.phase,work.target);
      return {...common,status:'WAITING_REMOTE_PEER',phaseId:phase.id,workId:phase.remoteWorkId,next:[]};
    }
    if(phase.phase==='IMPLEMENT'&&((!record.paths.length&&!ownerMode())||record.permission!=='WRITE_APPROVED'))
      return {...common,status:'BLOCKED_EDIT_SCOPE_OR_AUTHORIZATION',phaseId:phase.id,next:[]};
    if(phase.phase==='IMPLEMENT'&&!(await this.activeWriteGrant(runId,record.paths)))
      return {...common,status:'BLOCKED_WRITE_GRANT_EXPIRED',phaseId:phase.id,next:[],instruction:'Obtain fresh operator authorization before issuing new writer tasks.'};
    if(['VERIFY','REVIEW','JUDGMENT'].includes(phase.phase)&&!record.candidateSha)
      return {...common,status:'BLOCKED_CANDIDATE_SHA',phaseId:phase.id,next:[]};
    if(phase.phase==='REVIEW'||phase.phase==='JUDGMENT'){
      const previous=phase.phase==='REVIEW'?record.reviewId:record.judgmentId;
      if(previous){
        // A Judgment Day prepared before remote judges existed has no transport: it is native.
        const transport=phase.phase==='REVIEW'?record.reviewTransport:(record.judgmentTransport??'NATIVE');
        const nativeStatus=transport==='NATIVE'?await this.native.status(previous):null;
        const rddRecord=(phase.phase==='REVIEW'||transport==='REMOTE')&&this.rdd?await this.rdd.getForReview(previous):null;
        // Finish the four solo lenses before triaging their aggregate findings.
        const partialSolo4R=nativeStatus?.kind==='4r'&&!nativeStatus.soloEvidenceComplete&&nativeStatus.slots.some(s=>s.state==='REPORTED_SOLO');
        const severe=partialSolo4R?[]:nativeStatus?.severeFindings??[];
        if(severe.length||rddRecord?.state==='NEEDS_CORRECTION'){
          const findings=severe.length?severe.map(f=>`${f.id}: ${f.location}: ${f.claim}`):['See Panter-RDD severe findings'];
          if((record.correctionAttempts??0)>=2)return {...common,status:'CORRECTION_BUDGET_EXHAUSTED',phaseId:phase.id,next:[],findings};
          if(record.permission!=='WRITE_APPROVED'||!(await this.activeWriteGrant(runId,record.paths)))return {...common,status:'CORRECTION_REQUIRES_WRITE_GRANT',phaseId:phase.id,next:[],findings};
          const packet=await specialistPacket({agentId:'gentle-ai-worker',objective:`Fix only the review findings within the existing authorization for ${record.objective}. ${findings.join(' | ')}`,
            skillIds:['gentle-ai','rdd-defect-workflow'],candidateSha:record.candidateSha!,
            allowedEditSurfaces:record.paths,modelRequest:policy.model,effortRequest:policy.reasoningEffort});
          return {...common,status:'CORRECTION_PACKET_READY',phaseId:phase.id,next:[{...packet,execution:'HOST_NATIVE_OR_INLINE',
            requestedWorkerProcessing:policy.worker.preferredProcessing}],
            instruction:'Perform one bounded correction, run exact tests, obtain a NEW Git commit SHA and call panter_harness_correction_report. Never invent fixes or expand paths.'};
        }
      }
    }
    if(phase.phase==='JUDGMENT'){
      // Judgment Day is an additional, explicitly requested audit, never a substitute for 4R.
      if(!record.judgmentId){
        // The two blind judges run remote when both are bound to connected, distinct hosts; otherwise native.
        if(await this.remoteReviewReady(record,'JUDGMENT','judgment-day',effectiveMode,runtime))
          await this.startRemoteReview(record,'JUDGMENT','judgment-day');
        else{
          const jd=await this.native.create({missionId:record.id,kind:'judgment-day',objective:record.objective,
            candidateSha:record.candidateSha!,idempotencyKey:`harness:${record.id}:judgment-day:${record.candidateSha}`});
          await this.write(s=>{const r=s.runs.find(x=>x.id===runId)!;
            if(!r.closedAt&&!r.judgmentId&&r.candidateSha===record.candidateSha){r.judgmentId=jd.reviewId;r.judgmentTransport='NATIVE';r.revision++;}});
        }
      }
      const latest=await this.get(runId);
      // A correction landed while this tick prepared the session: start over on the new candidate.
      if(latest&&!latest.judgmentId&&(latest.candidateSha!==record.candidateSha||latest.revision!==record.revision))return this.tick(runId,runtime);
      ensure(latest?.judgmentId,'Judgment Day not prepared');
      if(latest.judgmentTransport==='REMOTE')return this.remoteReviewTick(runId,runtime,phase,'JUDGMENT','judgment-day',latest,common);
      const status=await this.native.status(latest.judgmentId);
      if(!status.evidenceComplete){
        const batch=await this.native.batch(latest.judgmentId,runtime.nativeSubagents?runtime.maxParallelSubagents:0);
        return {...common,status:batch.dispatch,phaseId:phase.id,reviewId:latest.judgmentId,
          next:batch.packets,concurrentSlots:batch.concurrentSlots,
          instruction:'Run two blind Judgment Day judges separately. Do not share their findings or treat this audit as 4R.'};
      }
      if(status.severeFindings.length)return {...common,status:'JUDGMENT_FINDINGS_NEED_CORRECTION',phaseId:phase.id,
        reviewId:latest.judgmentId,review:status,next:[]};
      if(!this.rdd)return {...common,status:'AWAITING_JUDGMENT_RDD_AUTHORITY',phaseId:phase.id,reviewId:latest.judgmentId,next:[]};
      const tx=await this.rdd.begin({missionId:latest.id,reviewId:latest.judgmentId,source:'NATIVE',
        candidateSha:latest.candidateSha!,kind:'judgment-day',localProject:latest.project,
        repository:latest.githubRepository??(githubProject.test(latest.project)?latest.project:undefined),
        prNumber:latest.githubPrNumber,expectedBase:latest.githubExpectedBase,deliveryStrategy:latest.deliveryStrategy,
        implementerRunId:latest.correctionRunId??latest.steps.find(x=>x.phase==='IMPLEMENT')?.result?.runId,
        implementerRunIds:this.authorRunIds(latest)});
      const verdict=await this.rdd.assess(tx.id);
      if(verdict.record.state==='APPROVED_PENDING_ACK')await this.rdd.acknowledge(tx.id,verdict.record.revision);
      if(!['APPROVED_PENDING_ACK','ACKNOWLEDGED'].includes(verdict.record.state))
        return {...common,status:verdict.record.state,phaseId:phase.id,reviewId:latest.judgmentId,panterRdd:verdict,next:[]};
      // Only the session still current for the run completes it (a correction may have dropped it meanwhile).
      await this.write(s=>{const r=s.runs.find(x=>x.id===runId)!;const st=r.steps.find(x=>x.id===phase.id)!;
        if(!r.closedAt&&r.judgmentId===latest.judgmentId&&st.status!=='COMPLETE'){st.status='COMPLETE';r.revision++;}});
      return this.tick(runId,runtime);
    }
    if(phase.phase==='REVIEW'){
      const kind=record.reviewKind??'4r';
      // Remote 4R is only eligible if every configured review host is explicitly connected.
      // No remote worker is needed for a complete native GPT-A-only review.
      if(!record.reviewId){
        if(await this.remoteReviewReady(record,'REVIEW',kind,effectiveMode,runtime))await this.startRemoteReview(record,'REVIEW',kind);
        else{
          const native=await this.native.create({missionId:record.id,kind,objective:record.objective,candidateSha:record.candidateSha!,idempotencyKey:`harness:${record.id}:review:${record.candidateSha}:${record.reviewAttempt??0}`});
          await this.write(s=>{const r=s.runs.find(x=>x.id===runId)!;if(!r.closedAt&&!r.reviewId&&r.candidateSha===record.candidateSha){r.reviewId=native.reviewId;r.reviewTransport='NATIVE';r.revision++;}});
        }
      }
      const now=await this.get(runId);
      if(now&&!now.reviewId&&(now.candidateSha!==record.candidateSha||now.revision!==record.revision))return this.tick(runId,runtime);
      ensure(now?.reviewId&&now.reviewTransport,'Review session not initialized');
      if(now.reviewTransport==='NATIVE'){
        const review=await this.native.status(now.reviewId);
        if(review.soloEvidenceComplete){
          if(review.severeFindings.length)return {...common,status:'SOLO_4R_FINDINGS_NEED_CORRECTION',
            phaseId:phase.id,reviewId:now.reviewId,review,next:[],approved:false};
          await this.write(state=>{const run=state.runs.find(r=>r.id===runId)!;
            const item=run.steps.find(step=>step.id===phase.id)!;
            if(!run.closedAt&&run.reviewId===now.reviewId&&item.status!=='COMPLETE'){item.status='COMPLETE';run.revision++;}
          });
          return this.tick(runId,runtime);
        }
        if(review.stage==='AWAITING_SUBAGENT_REPORTS'){
          const batch=await this.native.batch(now.reviewId,runtime.nativeSubagents?runtime.maxParallelSubagents:0);
          return {...common,status:batch.dispatch,phaseId:phase.id,reviewId:now.reviewId,next:batch.packets,concurrentSlots:batch.concurrentSlots,
            reviewMode:batch.reviewMode,approved:false,
            instruction:batch.reviewMode==='GPT_A_SOLO_UNVERIFIED'?
              `${leaderLabel()}: run this one 4R lens inline and submit via panter_native_review_submit_solo, then request the next lens. Do not claim independent review or approval.`:
              `${leaderLabel()}: automatically dispatch real native child packets in parallel when supported. No remote peers or model-provider APIs are required.`};
        }
        if(this.rdd){
          const tx=await this.rdd.begin({missionId:now.id,reviewId:now.reviewId,source:'NATIVE',
            candidateSha:now.candidateSha!,kind,localProject:now.project,repository:now.githubRepository??(githubProject.test(now.project)?now.project:undefined),
            prNumber:now.githubPrNumber,expectedBase:now.githubExpectedBase,deliveryStrategy:now.deliveryStrategy,
            implementerRunId:now.correctionRunId??now.steps.find(x=>x.phase==='IMPLEMENT')?.result?.runId,
            implementerRunIds:this.authorRunIds(now)});
          if(now.previousReviewId){const previous=await this.rdd.getForReview(now.previousReviewId);
            if(previous&&previous.state!=='SUPERSEDED'&&previous.state!=='ACKNOWLEDGED')
              await this.rdd.supersede(previous.id,now.reviewId,previous.revision);}
          const verdict=await this.rdd.assess(tx.id);
          if(verdict.record.state==='APPROVED_PENDING_ACK')await this.rdd.acknowledge(tx.id,verdict.record.revision);
          if(['APPROVED_PENDING_ACK','ACKNOWLEDGED'].includes(verdict.record.state)){
            await this.write(s=>{const r=s.runs.find(x=>x.id===runId)!;const item=r.steps.find(x=>x.id===phase.id)!;
              if(!r.closedAt&&r.reviewId===now.reviewId&&item.status!=='COMPLETE'){item.status='COMPLETE';r.revision++;}});
            return this.tick(runId,runtime);
          }
          return {...common,status:verdict.record.state,phaseId:phase.id,reviewId:now.reviewId,
            review,panterRdd:verdict,next:[],instruction:'Panter-RDD checks frozen reviewer receipts and GitHub proof. Address blockers or authorize a separate correction; reviewer prose never grants delivery authority.'};
        }
        const officialRdd=review.severeFindings.length?null:(this.officialRdd?await this.officialRdd.status():null);
        return {...common,status:review.severeFindings.length?'REVIEW_FINDINGS_NEED_CORRECTION':'AWAITING_RDD_AUTHORITY',
          phaseId:phase.id,reviewId:now.reviewId,review,officialRdd,next:[],
          instruction:'Panter-RDD not configured; no model report grants approval.'};
      }
      return this.remoteReviewTick(runId,runtime,phase,'REVIEW',kind,now,common);
    }
    if(phase.phase==='IMPLEMENT'&&record.units?.length){
      const unreported=record.units.filter(x=>x.state==='PENDING');
      if(unreported.length){
        const max=runtime.nativeSubagents?Math.min(runtime.maxParallelSubagents,policy.plannerCeiling):0;
        // Without host-native execution, the parent may work units sequentially but cannot
        // falsely report a parallel run. Tool isolation remains a separate trusted runner gate.
        if(!runtime.toolsAvailable)return {...common,status:'BLOCKED_HOST_TOOLS',phaseId:phase.id,next:[]};
        const packets=await Promise.all(unreported.map(async unit=>({
          ...(await specialistPacket({agentId:'gentle-ai-worker',objective:unit.objective,
            skillIds:['gentle-ai','work-unit-commits'],allowedEditSurfaces:unit.paths,
            modelRequest:policy.model,effortRequest:policy.reasoningEffort})),
          unitId:unit.id,allowedEditSurfaces:unit.paths,
          execution:max>0?'GPT_A_NATIVE_WORKTREE_REQUESTED':'GPT_A_INLINE_SEQUENTIAL',
          requestedWorkerProcessing:policy.worker.preferredProcessing,
          notice:'Each native writer MUST use a separate trusted worktree and cannot edit another unit scope. Host confirmation is not filesystem enforcement.'
        })));
        await this.write(s=>{const r=s.runs.find(x=>x.id===runId)!;const st=r.steps.find(x=>x.id===phase.id)!;
          if(!r.closedAt&&st.status==='PENDING'){st.status='ISSUED';st.execution=max>0?'GPT_A_NATIVE':'GPT_A_INLINE';r.revision++;}});
        return {...common,status:max>0?'GPT_A_NATIVE_IMPLEMENTATION_BATCH':'GPT_A_SEQUENTIAL_IMPLEMENTATION_UNITS',
          phaseId:phase.id,next:packets,concurrentSlots:max>0?Math.min(max,unreported.length):1,
          instruction:'Schedule only independent units; isolate writers in separate trusted worktrees, then integrate, test and freeze ONE final SHA. The parent reports each unit via panter_harness_unit_report before the final integration.'};
      }
      // Completed units still need one parent-controlled integration, tests, final SHA.
      return {...common,status:'IMPLEMENTATION_INTEGRATION_REQUIRED',phaseId:phase.id,next:[{
        phase:'IMPLEMENT',execution:'GPT_A_INLINE',unitReports:record.units,
        instruction:'Integrate all completed units, verify shared invariants, run applicable tests, and report the actual final Git commit SHA. No extra writer may bypass unit scopes.'}]};
    }
    if(phase.status==='ISSUED')return {...common,status:'WAITING_HOST_PHASE_REPORT',phaseId:phase.id,next:[],instruction:'Reconcile the original issued phase; never dispatch a duplicate when peer availability changes.'};
    if(!runtime.toolsAvailable)return {...common,status:'BLOCKED_HOST_TOOLS',phaseId:phase.id,next:[]};
    const brief=record.objective.length>5000?record.objective.slice(0,5000)+' [Full objective is stored in harness status; retrieve it before writing.]':record.objective;
    const objective=phase.phase==='DISCOVER'?`Explore the repository for: ${brief}. Return exact permitted edit surfaces, risks and path:line evidence. Do not write.`:
      phase.phase==='DESIGN'?`Plan the smallest authorized change for: ${brief}. Preserve exact specification, acceptance checks and ODD task IDs. Confirm scoped edit surfaces: ${record.paths.join(', ')||'unknown; do not write yet'}.`:
      phase.phase==='IMPLEMENT'?`Implement the authorized scoped change: ${brief}. Allowed surfaces: ${record.paths.join(', ')}. Test first when applicable; return the exact commit SHA for high-risk review.`:
      `Verify the exact frozen candidate ${record.candidateSha} against: ${brief}. If the host supplies an actual verifier, report its independent run ID. Otherwise perform a ${leaderLabel()} self-check inline, report runId=${leaderHost()}, and label evidence SELF_UNVERIFIED.`;
    const packetObjective=objective.length>5800?objective.slice(0,5700)+' [Retrieve complete objective and paths from panter_harness_status.]':objective;
    if(phase.phase==='DESIGN'){
      await this.write(s=>{const r=s.runs.find(x=>x.id===runId)!;const st=r.steps.find(x=>x.id===phase.id)!;if(!r.closedAt&&st.status==='PENDING'){st.status='ISSUED';r.revision++;}});
      return {...common,status:'GPT_A_INLINE',phaseId:phase.id,next:[{phase:phase.phase,agentId:null,instruction:objective,
        skills:['gentle-ai','work-unit-commits'],execution:'GPT_A_INLINE'}]};
    }
    ensure(phase.agentId && codeAgent.has(phase.agentId),'Unknown automatic agent');
    const binding=(await this.mesh.specialistBindings()).find(x=>x.agentId===phase.agentId);
    const implementer=record.steps.find(s=>s.phase==='IMPLEMENT');
    const candidateVerifierIsIndependent=phase.phase!=='VERIFY'||!implementer?.remoteWorkId||
      (await this.mesh.inbox(leaderHost())).works.find(w=>w.id===implementer.remoteWorkId)?.target!==binding?.host;
    const requestedRole=phase.phase==='IMPLEMENT'?'implementer':phase.phase==='VERIFY'?'verifier':'explorer';
    // A phase sent native because its host failed or never showed up stays native for that host only; once the phase
    // is bound to another host, that host gets its turn. (Older records without fallbackFrom stay native.)
    const hostExcluded=!!phase.nativeOnly&&(!phase.fallbackFrom||phase.fallbackFrom===binding?.host);
    const remoteEligible=effectiveMode==='AUTO'&&!hostExcluded&&binding&&runtime.peerStates?.[binding.host]==='CONNECTED'&&candidateVerifierIsIndependent&&
      (await this.mesh.profiles()).some(p=>p.host===binding.host&&p.roles.includes(requestedRole));
    if(remoteEligible){
      const work=await this.mesh.delegateBoundSpecialist(leaderHost(),{missionId:record.id,agentId:phase.agentId,objective:packetObjective,
        candidateSha:record.candidateSha??undefined,allowedEditSurfaces:phase.phase==='IMPLEMENT'?record.paths:undefined,
        idempotencyKey:`harness:${record.id}:${phase.id}:${record.candidateSha??'none'}:${record.correctionAttempts??0}:${phase.redispatchGeneration??0}`,
        material:this.hooks.materialFor?await this.hooks.materialFor(record,binding.host):undefined,
        leaderNotes:phaseNotes(phase.phase,this.hooks.accessFor?.(record,binding.host,phase.phase))});
      const closedMeanwhile=await this.write(s=>{const r=s.runs.find(x=>x.id===runId)!;const st=r.steps.find(x=>x.id===phase.id)!;
        if(r.closedAt)return true;
        if(st.status==='PENDING'){st.status='ISSUED';st.execution='REMOTE_A2A';st.remoteWorkId=work.id;r.revision++;}return false;});
      // Closed while this tick dispatched: the work it created is stopped and never granted.
      if(closedMeanwhile){await this.retireWork(work.id,'harness run closed');return this.tick(runId,runtime);}
      await this.dispatched(record,work.id,phase.phase,binding.host);
      return {...common,status:'REMOTE_A2A_DISPATCHED',phaseId:phase.id,next:[{agentId:phase.agentId,workId:work.id,
        execution:'REMOTE_A2A',host:binding.host,automatic:true}]};
    }
    const packet=await specialistPacket({agentId:phase.agentId,objective:packetObjective,skillIds:phase.phase==='IMPLEMENT'?['gentle-ai','work-unit-commits']:
      phase.phase==='DISCOVER'?['gentle-ai']:['gentle-ai'],modelRequest:policy.model,effortRequest:policy.reasoningEffort,
      candidateSha:phase.phase==='VERIFY'?record.candidateSha??undefined:undefined,
      allowedEditSurfaces:phase.phase==='IMPLEMENT'?record.paths:undefined});
    const execution=runtime.nativeSubagents&&runtime.maxParallelSubagents>0&&phase.phase!=='IMPLEMENT'?'GPT_A_NATIVE':'GPT_A_INLINE';
    await this.write(s=>{const r=s.runs.find(x=>x.id===runId)!;const st=r.steps.find(x=>x.id===phase.id)!;
      if(!r.closedAt&&st.status==='PENDING'){st.status='ISSUED';st.execution=execution;r.revision++;}});
    return {...common,status:execution,phaseId:phase.id,next:[{...packet,phase:phase.phase,execution,
      instruction:packet.instruction,requestedWorkerProcessing:policy.worker.preferredProcessing,
      notice:'Host must invoke its actual tool/subagent and return evidence; MCP has not started model inference.'}]};
  }
}

/** Whether a lens result says anything severe. A report accepted for its lens and SHA is judged by its findings (an
 * accepted clean report carries no severe value anywhere); any other text — failed, prose, unbound — counts as severe
 * when the words appear at all, in any spelling, since nothing then tells a finding from a passing mention. */
function mentionsSevere(result:string|null,state:string,agentId:string,candidateSha:string):boolean{
  if(!result)return false;
  // Only a finished lens can be accepted; a failed one is judged by its text like any other unusable report.
  const envelope=state==='COMPLETED'?lensEnvelope(result,agentId,candidateSha):'UNSTRUCTURED';
  if(typeof envelope==='object')return envelope.findings.some(f=>/^(critical|blocker)$/i.test(String(f.severity).trim()));
  // Any spelling: plurals, compound keys (criticalCount, critical_findings), and letters written as JSON \u escapes.
  const decoded=result.replace(/\\u([0-9a-fA-F]{4})/g,(_,h:string)=>String.fromCharCode(parseInt(h,16)));
  return /critical|blocker/i.test(decoded)||!!unacceptedSevere(result);
}
