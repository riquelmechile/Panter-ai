/** GPT-A native-subagent review handoffs and durable evidence collection.
 * Host owns subagent execution. This ledger never confers official Gentle AI RDD approval.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { REVIEW_4R, specialistPacket } from './gentle-catalog.js';
import { hostRequest } from './policy.js';
import type { RunnerAttestation } from './review-attestation.js';

const shaPattern = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const severity = new Set(['BLOCKER', 'CRITICAL', 'WARNING', 'SUGGESTION']);
const blake = (s: string) => createHash('sha256').update(s).digest('hex');
function requireValid(value: unknown, reason: string): asserts value { if (!value) throw new Error(reason); }
export type ReviewKind = '4r' | 'judgment-day';
export type NativeReviewFinding = { id: string; location: string; severity: 'BLOCKER'|'CRITICAL'|'WARNING'|'SUGGESTION'; claim: string; proofRefs: string[] };
export type NativeReviewReport = { agentId: string; candidateSha: string; packetDigest: string; subagentRunId: string; evidence: string[]; findings: NativeReviewFinding[]; attestation?: RunnerAttestation };
export type NativeReviewSlot = {
  id: string; agentId: string; candidateSha: string; packetDigest: string; assetDigests: Record<string,string>;
  state: 'AWAITING_SUBAGENT'|'REPORTED'|'REPORTED_SOLO'; receiptDigest: string|null; subagentRunId: string|null;
  report: NativeReviewReport|null; createdAt: string; completedAt: string|null;
};
export type NativeReviewRecord = {
  id: string; missionId: string; kind: ReviewKind; objective: string; candidateSha: string;
  idempotencyKey: string; owner: 'gpt-a'; slots: NativeReviewSlot[];
  createdAt: string; revision: number;
};
type State = {version:1; reviews:NativeReviewRecord[]};
const coreRoles = { '4r': [...REVIEW_4R], 'judgment-day':['jd-judge-a','jd-judge-b'] } as const;

export class NativeSubagentReview {
  private data: State = {version:1,reviews:[]};
  private chain:Promise<unknown> = Promise.resolve();
  private constructor(private readonly file:string) {}
  static async open(dataDir:string){
    await mkdir(resolve(dataDir),{recursive:true,mode:0o700});
    const x=new NativeSubagentReview(join(resolve(dataDir),'native-reviews.json'));
    try {
      const read:unknown=JSON.parse(await readFile(x.file,'utf8'));
      requireValid(!!read && typeof read==='object' && 'version' in read && read.version===1 && 'reviews' in read && Array.isArray(read.reviews),'Invalid native review store');
      x.data=read as State;
    }catch(e){if(!(e instanceof Error)||!('code' in e)||e.code!=='ENOENT')throw e;}
    return x;
  }
  private async read<T>(fn:(d:State)=>T):Promise<T>{await this.chain;return structuredClone(fn(this.data));}
  private async write<T>(fn:(d:State)=>T):Promise<T>{
    const p=this.chain.then(async()=>{
      const d=structuredClone(this.data), result=fn(d);
      const tmp=`${this.file}.${randomUUID()}.tmp`;
      await writeFile(tmp,JSON.stringify(d,null,2),{flag:'wx',mode:0o600});
      await rename(tmp,this.file);this.data=d;return structuredClone(result);
    });
    this.chain=p.then(()=>undefined,()=>undefined);return p;
  }
  async create(input:{missionId:string;kind:ReviewKind;objective:string;candidateSha:string;idempotencyKey:string}){
    requireValid(input.missionId.trim().length>0&&input.missionId.length<=120,'Invalid mission');
    requireValid(input.objective.trim().length>0&&input.objective.length<=6000,'Invalid objective');
    requireValid(shaPattern.test(input.candidateSha),'Review requires exact frozen SHA');
    requireValid(input.idempotencyKey.trim().length>0&&input.idempotencyKey.length<=160,'Invalid idempotency key');
    requireValid(input.kind==='4r'||input.kind==='judgment-day','Invalid review kind');
    const old=await this.read(d=>d.reviews.find(r=>r.missionId===input.missionId&&r.idempotencyKey===input.idempotencyKey));
    if(old){
      requireValid(old.kind===input.kind&&old.candidateSha===input.candidateSha&&old.objective===input.objective,'Review idempotency conflict');
      return this.publicStatus(old);
    }
    const policy=hostRequest('chatgpt');
    const agents=coreRoles[input.kind];
    const packets=await Promise.all(agents.map(agentId=>specialistPacket({agentId,objective:input.objective,
      candidateSha:input.candidateSha,skillIds:input.kind==='judgment-day'?['judgment-day']:['gentle-ai'],
      modelRequest:policy.model,effortRequest:policy.reasoningEffort})));
    return this.write(d=>{
      // Re-check inside serialized transaction: concurrent calls must be idempotent.
      const prior=d.reviews.find(r=>r.missionId===input.missionId&&r.idempotencyKey===input.idempotencyKey);
      if(prior){requireValid(prior.kind===input.kind&&prior.candidateSha===input.candidateSha&&prior.objective===input.objective,'Review idempotency conflict');return this.publicStatus(prior);}
      const now=new Date().toISOString();
      const review:NativeReviewRecord={id:randomUUID(),...input,owner:'gpt-a',revision:1,createdAt:now,
        slots:packets.map(packet=>({id:randomUUID(),agentId:packet.agentId,candidateSha:input.candidateSha,
          packetDigest:packet.digest,assetDigests:packet.assetDigests,state:'AWAITING_SUBAGENT',receiptDigest:null,
          subagentRunId:null,report:null,createdAt:now,completedAt:null}))};
      d.reviews.push(review);return this.publicStatus(review);
    });
  }
  private publicStatus(r:NativeReviewRecord){
    const missing=r.slots.filter(s=>s.state==='AWAITING_SUBAGENT').map(s=>s.agentId);
    const all=r.slots.every(s=>s.state==='REPORTED');
    const soloComplete=r.kind==='4r'&&r.slots.every(s=>s.state==='REPORTED_SOLO');
    const findings=r.slots.flatMap(s=>s.report?.findings??[]);
    const severe=findings.filter(f=>f.severity==='CRITICAL'||f.severity==='BLOCKER');
    const runIds=r.slots.map(s=>s.subagentRunId).filter(Boolean);
    return {reviewId:r.id,missionId:r.missionId,kind:r.kind,candidateSha:r.candidateSha,revision:r.revision,
      slots:r.slots.map(s=>({slotId:s.id,agentId:s.agentId,packetDigest:s.packetDigest,state:s.state,subagentRunId:s.subagentRunId,receiptDigest:s.receiptDigest,attestation:s.report?.attestation??null,evidence:s.report?.evidence??[],findings:s.report?.findings??[]})),
      missing,findings,severeFindings:severe,reportedSubagentRuns:runIds,
      stage:soloComplete?'SOLO_4R_COMPLETED_UNVERIFIED':!all?'AWAITING_SUBAGENT_REPORTS':severe.length?'FINDINGS_REQUIRE_TRIAGE':'READY_FOR_RDD_CONTROLLER',
      evidenceComplete:all,soloEvidenceComplete:soloComplete,reviewMode:soloComplete?'GPT_A_SOLO_UNVERIFIED':all?'HOST_NATIVE_SUBAGENTS':'IN_PROGRESS',
      independentNativeRunsAttested:false,approved:false,nativeRddAuthority:false,
      next:soloComplete?'GPT-A finished four self-review lenses. No independent verification, RDD approval or merge permission.':!all?'Launch native subagents or perform four explicitly unverified solo lenses sequentially.':
        severe.length?'Review severe findings, authorize and freeze any corrections, then initiate fresh SHA-bound review.':
        'Check exact candidate and subagent run provenance with official Gentle AI RDD or independent trusted Git/CI evidence before approving.'};
  }
  status(reviewId:string){return this.read(d=>{const r=d.reviews.find(x=>x.id===reviewId);requireValid(r,'Review not found');return this.publicStatus(r);});}
  /** Return only the requested slot's content. Blind judges never receive peer reports. */
  async packet(reviewId:string,slotId:string){
    const r=await this.read(d=>d.reviews.find(x=>x.id===reviewId));requireValid(r,'Review not found');
    const slot=r.slots.find(x=>x.id===slotId);requireValid(slot,'Review slot not found');
    const policy=hostRequest('chatgpt');
    const packet=await specialistPacket({agentId:slot.agentId,objective:r.objective,candidateSha:r.candidateSha,
      skillIds:r.kind==='judgment-day'?['judgment-day']:['gentle-ai'],modelRequest:policy.model,effortRequest:policy.reasoningEffort});
    requireValid(packet.digest===slot.packetDigest,'Catalog assets changed: frozen packet mismatch');
    return {reviewId:r.id,slotId:slot.id,kind:r.kind,candidateSha:r.candidateSha,
      ...packet,packetDigest:packet.digest,execution:'HOST_NATIVE_SUBAGENT_REQUESTED' as const,
      independenceRequirement:'Launch a new, separate native child context for this exact slot, never share other lens or blind judge reports. Do not let the implementing agent review its own work.',
      returnContract:'Child returns JSON with agentId, candidateSha, packetDigest, a unique subagentRunId, evidence[], and findings[]. Each finding includes id, location, severity, claim and proofRefs[]. Parent submits this JSON via panter_native_review_submit. For a production Panter-RDD approval, a trusted host runner must attach an Ed25519 attestation of the immutable slot invocation; model-reported child IDs alone are not sufficient.',
      capacityRequest:{model:policy.worker.model,reasoning:policy.worker.reasoningEffort,processing:policy.worker.preferredProcessing},
      launchPerformed:false};
  }
  /** One call prepares all independent native child handoffs for parallel host dispatch.
   * Returns plans, not actual model processes or verified invocation evidence. */
  async batch(reviewId:string, observedNativeParallelism:number){
    requireValid(Number.isInteger(observedNativeParallelism)&&observedNativeParallelism>=0&&observedNativeParallelism<=32,'Invalid observed native parallelism');
    const status=await this.status(reviewId);
    const available=status.slots.filter(s=>s.state==='AWAITING_SUBAGENT');
    const alreadySolo=status.slots.some(s=>s.state==='REPORTED_SOLO');
    const alreadyNative=status.slots.some(s=>s.state==='REPORTED');
    const solo=status.kind==='4r'&&(alreadySolo||(observedNativeParallelism===0&&!alreadyNative));
    const selected=solo?available.slice(0,1):observedNativeParallelism>0?available:[];
    const originalPackets=await Promise.all(selected.map(s=>this.packet(reviewId,s.slotId)));
    const packets=solo?originalPackets.map(p=>({...p,execution:'GPT_A_SOLO_LENS_REQUESTED' as const,
      independenceRequirement:'GPT-A itself reviews this lens; it is not an independent subagent, no independent attestation and no RDD approval.',
      returnContract:'Inspect one lens of this exact candidate, then submit agentId/candidateSha/packetDigest/evidence/findings with panter_native_review_submit_solo. Do not invent a child run ID.'})):originalPackets;
    const capacity=hostRequest('chatgpt');
    return {reviewId,kind:status.kind,candidateSha:status.candidateSha,
      dispatch:solo?'READY_FOR_GPT_A_SOLO_4R':observedNativeParallelism>0?'READY_FOR_HOST_NATIVE_DISPATCH':'HOST_NATIVE_SUBAGENTS_UNAVAILABLE',
      reviewMode:solo?'GPT_A_SOLO_UNVERIFIED':'HOST_NATIVE_SUBAGENTS',
      concurrentSlots:solo?(selected.length?1:0):Math.min(observedNativeParallelism,selected.length),
      remainingSlots:available.length,requestedNativeParallelism:observedNativeParallelism,
      requestedModel:capacity.model,requestedReasoning:capacity.reasoningEffort,
      requestedWorkerSpeed:capacity.worker.preferredProcessing,packets,
      requirements:solo?'GPT-A runs one self-review lens at a time, recording the evidence. Self-review is not independent and cannot pass Panter-RDD.':
      'Launch actual separate host-native children; never fabricate subagent execution or attestations.',
      modelsStartedByMcp:0,approved:false};
  }
  /** Explicit GPT-A solo 4R evidence, never a native-subagent report. */
  submitSolo(reviewId:string,slotId:string,report:Omit<NativeReviewReport,'subagentRunId'|'attestation'>){
    requireValid(report!==null&&typeof report==='object','Invalid solo report');
    requireValid(Array.isArray(report.evidence)&&report.evidence.length>0&&report.evidence.length<=40&&
      report.evidence.every(x=>typeof x==='string'&&x.trim()&&x.length<=1000),'Concrete solo evidence required');
    requireValid(Array.isArray(report.findings)&&report.findings.length<=80,'Invalid findings');
    for(const f of report.findings){
      requireValid(f&&typeof f.id==='string'&&/^[A-Za-z0-9._:-]{1,100}$/.test(f.id),'Invalid finding ID');
      requireValid(typeof f.location==='string'&&f.location.length>0&&f.location.length<=400,'Invalid finding location');
      requireValid(severity.has(f.severity)&&typeof f.claim==='string'&&f.claim.trim().length>0&&f.claim.length<=2000,'Invalid finding');
      requireValid(Array.isArray(f.proofRefs)&&f.proofRefs.length>0&&f.proofRefs.length<=12&&
        f.proofRefs.every(p=>typeof p==='string'&&p.length>0&&p.length<=600),'Finding proof references required');
    }
    return this.write(d=>{
      const review=d.reviews.find(r=>r.id===reviewId);requireValid(review,'Review not found');
      requireValid(review.kind==='4r','Judgment Day requires separate blind judges');
      const slot=review.slots.find(s=>s.id===slotId);requireValid(slot,'Review slot not found');
      requireValid(report.agentId===slot.agentId&&report.candidateSha===review.candidateSha&&
        report.packetDigest===slot.packetDigest,'Solo report does not match frozen SHA and reviewer slot');
      const stored:NativeReviewReport={...report,subagentRunId:'gpt-a'};
      const receipt=blake(JSON.stringify({reviewId,slotId,solo:true,report:stored}));
      if(slot.state==='REPORTED_SOLO'){
        requireValid(slot.receiptDigest===receipt,'Conflicting immutable solo report');
        return {receiptDigest:receipt,idempotent:true,status:this.publicStatus(review)};
      }
      requireValid(slot.state==='AWAITING_SUBAGENT'&&!review.slots.some(s=>s.state==='REPORTED'),
        'Solo and native reviewer reports cannot be mixed');
      requireValid(review.slots.find(s=>s.state==='AWAITING_SUBAGENT')?.id===slotId,
        'GPT-A solo 4R requires sequential lens reporting');
      slot.state='REPORTED_SOLO';slot.report=stored;slot.receiptDigest=receipt;
      slot.subagentRunId=null;slot.completedAt=new Date().toISOString();review.revision++;
      return {receiptDigest:receipt,idempotent:false,status:this.publicStatus(review)};
    });
  }
  submit(reviewId:string,slotId:string,report:NativeReviewReport){
    requireValid(report!==null&&typeof report==='object','Invalid native review report');
    requireValid(typeof report.subagentRunId==='string'&&/^[A-Za-z0-9._:-]{8,160}$/.test(report.subagentRunId)&&report.subagentRunId!=='gpt-a','Unique native subagent run ID required');
    requireValid(Array.isArray(report.evidence)&&report.evidence.length>0&&report.evidence.length<=40&&report.evidence.every(s=>typeof s==='string'&&s.trim().length>0&&s.length<=1000),'Concrete evidence required, including clean results');
    requireValid(Array.isArray(report.findings)&&report.findings.length<=80,'Invalid findings');
    for(const f of report.findings){
      requireValid(f&&typeof f.id==='string'&&/^[A-Za-z0-9._:-]{1,100}$/.test(f.id),'Invalid finding ID');
      requireValid(typeof f.location==='string'&&f.location.length>0&&f.location.length<=400,'Invalid finding location');
      requireValid(severity.has(f.severity)&&typeof f.claim==='string'&&f.claim.trim().length>0&&f.claim.length<=2000,'Invalid finding');
      requireValid(Array.isArray(f.proofRefs)&&f.proofRefs.length>0&&f.proofRefs.length<=12&&f.proofRefs.every(s=>typeof s==='string'&&s.length>0&&s.length<=600),'Finding proof references required');
    }
    return this.write(d=>{
      const r=d.reviews.find(x=>x.id===reviewId);requireValid(r,'Review not found');
      const slot=r.slots.find(s=>s.id===slotId);requireValid(slot,'Review slot not found');
      requireValid(report.agentId===slot.agentId&&report.candidateSha===r.candidateSha&&report.packetDigest===slot.packetDigest,'Mismatched frozen native review packet or SHA');
      const digest=blake(JSON.stringify({reviewId,slotId,report}));
      if(slot.state==='REPORTED'){
        requireValid(slot.receiptDigest===digest,'Conflicting immutable native review report');
        return {receiptDigest:digest,idempotent:true,status:this.publicStatus(r)};
      }
      requireValid(slot.state==='AWAITING_SUBAGENT'&&!r.slots.some(s=>s.state==='REPORTED_SOLO'),
        'Cannot promote or mix GPT-A solo self-review into independently attested native review');
      requireValid(!r.slots.some(s=>s.id!==slotId&&s.subagentRunId===report.subagentRunId),'Native subagent run ID reused across independent reviewers');
      slot.state='REPORTED';slot.report=report;slot.receiptDigest=digest;slot.subagentRunId=report.subagentRunId;
      slot.completedAt=new Date().toISOString();r.revision++;
      return {receiptDigest:digest,idempotent:false,status:this.publicStatus(r)};
    });
  }
}
