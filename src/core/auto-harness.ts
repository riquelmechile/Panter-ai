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
import { assessMeshReview, type NativeReviewBridge } from './native-review.js';
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
  execution?:'GPT_A_INLINE'|'GPT_A_NATIVE'|'REMOTE_A2A';remoteWorkId?:string;
  result?:{summary:string;evidence:string[];runId?:string;digest:string};};
export type HarnessRun={id:string;project:string;githubRepository?:string;githubPrNumber?:number;githubExpectedBase?:string;objective:string;key:string;inputDigest:string;permission:'READ_ONLY'|'WRITE_APPROVED';
  mode:HarnessMode; paths:string[]; risk:'LOW'|'HIGH'; reviewTier?:'passive'|'medium'|'high'; reason:string[]; candidateSha:string|null;
  reviewKind:'4r'|null; reviewId:string|null; reviewTransport:'NATIVE'|'REMOTE'|null;
  judgmentRequested?:boolean; judgmentId?:string|null; writeGrantId?:string;
  correctionAttempts?:number; correctionRunId?:string; previousReviewId?:string|null; deliveryStrategy?:'single-pr'|'feature-branch-chain'|'stacked-to-main';
  units?:Array<{id:string;objective:string;paths:string[];state:'PENDING'|'REPORTED';runId?:string;summary?:string;evidence?:string[]}>;
  steps:HarnessStep[]; createdAt:string;revision:number;};
type WriteGrant={id:string;project:string;objectiveDigest:string;allowedPaths:string[];expiresAt:number;boundRunId:string|null};
type State={version:1;runs:HarnessRun[];grants?:WriteGrant[]};
export type HarnessInput={project:string;githubRepository?:string;githubPrNumber?:number;githubExpectedBase?:string;objective:string;idempotencyKey:string;writesAuthorized:boolean;
  changeSurfaces?:string[];writeGrantId?:string;coordinationMode?:HarnessMode;judgmentDayRequested?:boolean;
  /** Facts supplied by the host, not agent selections. Missing facts are handled conservatively. */
  observations?:{requirementsClear?:boolean;resumableFromDiff?:boolean;independentWorkUnits?:number;unknownCodeArea?:boolean};};
export type HarnessTickResult={runId:string;mode:HarnessMode;risk:'LOW'|'HIGH';reason:string[];
  status:string;next:Array<{agentId?:string|null;workId?:string;phase?:HarnessPhase;[key:string]:unknown}>;
  phaseId?:string;workId?:string;reviewId?:string;concurrentSlots?:number;[key:string]:unknown};
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
  const unknown=o.unknownCodeArea===true||(!paths.length&&input.writesAuthorized);
  const risk:'LOW'|'HIGH'=input.writesAuthorized&&(unknown||o.requirementsClear===false||o.resumableFromDiff===false||
    paths.some(p=>risky.test(p))||riskyGoal.test(input.objective))?'HIGH':'LOW';
  if(unknown)reasons.push('Code surfaces unknown: run read-only discovery before any edit');
  if(paths.some(p=>risky.test(p))||riskyGoal.test(input.objective))reasons.push('Security, data, delivery, or other high-impact surface');
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

export class AutomaticHarness {
  private state:State={version:1,runs:[]};
  private pending:Promise<unknown>=Promise.resolve();
  private constructor(private readonly file:string,private readonly mesh:MeshEngine,private readonly native:NativeSubagentReview,private readonly github?:GitHubDeliveryGate,private readonly officialRdd?:NativeReviewBridge,private readonly rdd?:PanterRdd,private readonly requireWriteGrant=false){}
  static async open(dir:string,mesh:MeshEngine,native:NativeSubagentReview,github?:GitHubDeliveryGate,officialRdd?:NativeReviewBridge,rdd?:PanterRdd,requireWriteGrant=false){
    await mkdir(resolve(dir),{recursive:true,mode:0o700});
    const engine=new AutomaticHarness(join(resolve(dir),'harness.json'),mesh,native,github,officialRdd,rdd,requireWriteGrant);
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
      if(input.writesAuthorized&&this.requireWriteGrant){
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
        paths:selected.paths,risk:selected.risk,reviewTier:selected.tier,reason:selected.reasons,candidateSha:null,reviewKind:selected.reviewKind,
        reviewId:null,reviewTransport:null,judgmentRequested:input.judgmentDayRequested===true,judgmentId:null,correctionAttempts:0,steps:selected.phases.map(step),createdAt:new Date().toISOString(),revision:1};
      if(grant)grant.boundRunId=run.id;
      s.runs.push(run);return run;
    });
  }
  get(runId:string){return this.read(s=>s.runs.find(r=>r.id===runId)??null);}
  async authorizeDelegatedWrite(id:string,paths:string[]){
    const run=await this.get(id);
    ensure(run?.permission==='WRITE_APPROVED'&&run.writeGrantId&&paths.length>0,'Authorized run required');
    const grant=await this.read(s=>s.grants?.find(g=>g.id===run.writeGrantId));
    ensure(grant&&grant.boundRunId===id&&grant.expiresAt>Date.now(),'Active operator grant required');
    for(const p of paths)ensure(run.paths.some(q=>p===q||p.startsWith(q+'/'))&&grant.allowedPaths.some(q=>p===q||p.startsWith(q+'/')),'Out-of-scope writer');
  }
  /** Bind a PR discovered/created by an authorized host after work started.
   * This changes only Panter's routing metadata, never the remote repository. */
  async bindGithub(runId:string,input:{repository:string;prNumber:number;expectedBase?:string},expectedRevision:number){
    ensure(!!this.github&&this.github.allows(input.repository),'GitHub destination not allowed by operator');
    ensure(Number.isInteger(input.prNumber)&&input.prNumber>0,'Invalid GitHub PR number');
    ensure(!input.expectedBase||/^[a-zA-Z0-9._/-]{1,100}$/.test(input.expectedBase),'Invalid GitHub PR base');
    return this.write(s=>{
      const r=s.runs.find(x=>x.id===runId);ensure(r,'Harness not found');
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
    return this.write(s=>{const r=s.runs.find(x=>x.id===runId);ensure(r,'Harness not found');
      ensure(r.revision===expectedRevision,'Stale correction revision');
      ensure(r.permission==='WRITE_APPROVED'&&r.paths.length>0,'Correction is not authorized within a scoped writable run');
      ensure((r.correctionAttempts??0)<2,'Correction attempt budget exhausted');
      ensure(r.candidateSha&&r.candidateSha!==payload.candidateSha,'Corrected candidate requires a fresh SHA');
      const review=r.steps.find(st=>st.phase==='REVIEW');const judgment=r.steps.find(st=>st.phase==='JUDGMENT');
      ensure(review||judgment,'No review requiring correction');
      ensure(!review||review.status!=='COMPLETE'||(!!judgment&&judgment.status!=='COMPLETE'&&!!r.judgmentId),'Closed review cannot be silently rewritten');
      r.previousReviewId=r.reviewId;
      r.candidateSha=payload.candidateSha;r.reviewId=null;r.reviewTransport=null;r.judgmentId=null;
      r.correctionAttempts=(r.correctionAttempts??0)+1;r.correctionRunId=payload.runId;
      for(const step of r.steps)if(['VERIFY','REVIEW','JUDGMENT'].includes(step.phase)){
        step.status='PENDING';step.execution=undefined;step.remoteWorkId=undefined;step.result=undefined;
      }
      r.revision++;return r;});
  }

  /** GPT-A derives independent work units from the design; the user never picks agents.
   * Each unit must have a disjoint and explicitly scoped surface. Separate worktrees
   * and actual child processes are responsibilities of the trusted host runner. */
  async defineUnits(runId:string,units:Array<{objective:string;paths:string[]}>,expectedRevision:number){
    ensure(units.length>=2&&units.length<=16,'Parallel implementation requires 2-16 units');
    const derived=units.map(u=>{ensure(u.objective.trim().length>0&&u.objective.length<=3000,'Invalid unit objective');
      const paths=[...new Set(u.paths.map(safePath))];ensure(paths.length>0&&paths.length<=12,'Units require scoped paths');
      return {id:randomUUID(),objective:u.objective,paths,state:'PENDING' as const};});
    for(let i=0;i<derived.length;i++)for(let j=i+1;j<derived.length;j++)for(const a of derived[i]!.paths)for(const b of derived[j]!.paths)
      ensure(a!==b&&!a.startsWith(b+'/')&&!b.startsWith(a+'/'),'Parallel writer scopes overlap');
    return this.write(s=>{const r=s.runs.find(x=>x.id===runId);ensure(r,'Harness not found');
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
    ensure(/^[A-Za-z0-9._:-]{8,160}$/.test(result.runId)&&result.runId!=='gpt-a','Native child run identity required');
    ensure(result.summary.trim().length>0&&result.summary.length<=3000,'Invalid unit summary');
    ensure(Array.isArray(result.evidence)&&result.evidence.length>0&&result.evidence.length<=30&&result.evidence.every(x=>typeof x==='string'&&x.trim()&&x.length<=1000),'Unit evidence required');
    return this.write(s=>{const r=s.runs.find(x=>x.id===runId);ensure(r,'Harness not found');
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
    return this.write(s=>{const r=s.runs.find(x=>x.id===runId);ensure(r,'Harness not found');
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
      const r=s.runs.find(x=>x.id===runId);ensure(r,'Harness not found');
      const step=r.steps.find(x=>x.id===stepId);ensure(step,'Unknown harness step');
      const i=r.steps.indexOf(step);
      ensure(r.steps.slice(0,i).every(x=>x.status==='COMPLETE'),'Previous phases are incomplete');
      ensure(step.phase!=='REVIEW'&&step.phase!=='JUDGMENT','Review evidence must be submitted through review slots');
      const digest=hash({stepId,payload});
      if(step.status==='COMPLETE'){ensure(step.result?.digest===digest,'Conflicting immutable harness report');return r;}
      ensure(step.status==='ISSUED','Phase packet must be issued before reporting');
      if(step.phase==='DISCOVER' && discovered.length){
        if(this.requireWriteGrant&&r.permission==='WRITE_APPROVED'){
          const grant=s.grants?.find(g=>g.id===r.writeGrantId);ensure(grant,'Missing original grant');
          for(const path of discovered)ensure(grant.allowedPaths.some(allowed=>path===allowed||path.startsWith(allowed+'/')),
            'Discovered edit surface exceeds operator grant');
        }
        r.paths=[...new Set([...r.paths,...discovered])];
      }
      if(step.phase==='IMPLEMENT'){
        ensure(!r.units||r.units.every(u=>u.state==='REPORTED'),'All isolated implementation units must finish before integration');
        ensure(r.permission==='WRITE_APPROVED','Unauthorized implementation');
        ensure(r.paths.length>0,'No discovery-confirmed edit surfaces');
        if(r.risk==='HIGH'||r.judgmentRequested||!!r.githubRepository||githubProject.test(r.project))ensure(!!payload.candidateSha,'GitHub/high-risk implementation needs frozen candidate SHA');
        if(r.githubRepository||githubProject.test(r.project))ensure(!!payload.candidateSha&&/^[a-f0-9]{40}$/.test(payload.candidateSha),'GitHub requires an exact 40-character Git commit SHA');
        r.candidateSha=payload.candidateSha??null;
      }
      if(step.phase==='VERIFY'){
        ensure(payload.candidateSha===r.candidateSha&&!!r.candidateSha,'Verifier must report exact candidate SHA');
        ensure(!!payload.runId&&payload.runId!=='gpt-a'&&payload.runId!==r.steps.find(x=>x.phase==='IMPLEMENT')?.result?.runId&&payload.runId!==r.correctionRunId&&!(r.units??[]).some(u=>u.runId===payload.runId),
          'Independent verifier run ID required');
      }
      step.status='COMPLETE';step.result={summary:payload.summary,evidence:payload.evidence,runId:payload.runId,digest};
      r.revision++;return r;
    });
  }
  async tick(runId:string,runtime:HarnessRuntime):Promise<HarnessTickResult>{
    ensure(Number.isInteger(runtime.maxParallelSubagents)&&runtime.maxParallelSubagents>=0&&runtime.maxParallelSubagents<=32,'Invalid host native capacity');
    const record=await this.get(runId);ensure(record,'Harness not found');
    const phase=record.steps.find(s=>s.status!=='COMPLETE');
    const profile=(await this.mesh.profiles()).find(p=>p.host==='gpt-a');
    // An operator may switch to GPT_A_ONLY mid-mission. Never dispatch fresh
    // remote work after that change, or silently reassign an in-flight write.
    const effectiveMode:HarnessMode=record.mode==='GPT_A_ONLY'||profile?.coordinationMode==='GPT_A_ONLY'?'GPT_A_ONLY':'AUTO';
    const policy=hostRequest('chatgpt');
    const common={runId:record.id,mode:effectiveMode,risk:record.risk,reason:record.reason,
      capacityRequest:{model:policy.model,reasoning:policy.reasoningEffort,workerProcessing:policy.worker.preferredProcessing,
        requestedParallelism:Math.min(runtime.nativeSubagents?runtime.maxParallelSubagents:0,policy.plannerCeiling),
        capacityVerified:false},modelWorkersStartedByServer:0,approved:false};
    if(!phase){
      const repository=record.githubRepository??(githubProject.test(record.project)?record.project:null);
      const nativeVerdict=this.rdd&&record.reviewId?await this.rdd.getForReview(record.reviewId):null;
      if(record.risk==='HIGH'&&nativeVerdict?.state!=='ACKNOWLEDGED')return {...common,status:'AWAITING_PANTER_RDD_AUTHORITY',rdd:nativeVerdict,next:[]};
      const judgmentVerdict=this.rdd&&record.judgmentId?await this.rdd.getForReview(record.judgmentId):null;
      if(record.judgmentRequested&&judgmentVerdict?.state!=='ACKNOWLEDGED')return {...common,status:'AWAITING_JUDGMENT_RDD_AUTHORITY',rdd:judgmentVerdict,next:[]};
      if(!repository)return {...common,status:record.risk==='HIGH'?'PANTER_RDD_REVIEWED_NO_GITHUB_DELIVERY_AUTHORITY':'REPORTED_COMPLETE_UNVERIFIED',next:[]};
      if(!record.githubPrNumber)return {...common,status:'AWAITING_GITHUB_PR_EVIDENCE',next:[],instruction:'GPT-A must identify or obtain permission to create the exact target PR; never push or open a PR without authorization.'};
      if(!record.candidateSha||!(/^[a-f0-9]{40}$/.test(record.candidateSha)))return {...common,status:'BLOCKED_CANDIDATE_SHA',next:[]};
      if(!this.github)return {...common,status:'GITHUB_VERIFICATION_NOT_CONFIGURED',next:[]};
      const github=await this.github.inspect({repository,prNumber:record.githubPrNumber,expectedSha:record.candidateSha,expectedBase:record.githubExpectedBase,deliveryStrategy:record.deliveryStrategy,parentAuthorizedSinglePr:record.deliveryStrategy==='single-pr'});
      return {...common,status:github.state==='REVIEWABLE'?(record.risk==='HIGH'?'PANTER_RDD_REVIEWED_NO_DELIVERY_AUTHORITY':'GITHUB_EVIDENCE_READY_NO_DELIVERY_AUTHORITY'):'GITHUB_GATE_BLOCKED',github,next:[],
        instruction:'GitHub verification is evidence, not permission for commit, push, merge, release, or deployment.'};
    }
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
    if(['VERIFY','REVIEW','JUDGMENT'].includes(phase.phase)&&!record.candidateSha)
      return {...common,status:'BLOCKED_CANDIDATE_SHA',phaseId:phase.id,next:[]};
    if(phase.phase==='REVIEW'||phase.phase==='JUDGMENT'){
      const previous=phase.phase==='REVIEW'?record.reviewId:record.judgmentId;
      if(previous){
        const nativeStatus=phase.phase==='JUDGMENT'?await this.native.status(previous):null;
        const rddRecord=phase.phase==='REVIEW'&&this.rdd?await this.rdd.getForReview(previous):null;
        const severe=nativeStatus?.severeFindings??[];
        if(severe.length||rddRecord?.state==='NEEDS_CORRECTION'){
          const findings=severe.length?severe.map(f=>`${f.id}: ${f.location}: ${f.claim}`):['See Panter-RDD severe findings'];
          if((record.correctionAttempts??0)>=2)return {...common,status:'CORRECTION_BUDGET_EXHAUSTED',phaseId:phase.id,next:[],findings};
          if(record.permission!=='WRITE_APPROVED')return {...common,status:'CORRECTION_REQUIRES_WRITE_GRANT',phaseId:phase.id,next:[],findings};
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
        const jd=await this.native.create({missionId:record.id,kind:'judgment-day',objective:record.objective,
          candidateSha:record.candidateSha!,idempotencyKey:`harness:${record.id}:judgment-day:${record.candidateSha}`});
        await this.write(s=>{const r=s.runs.find(x=>x.id===runId)!;
          if(!r.judgmentId){r.judgmentId=jd.reviewId;r.revision++;}});
      }
      const latest=await this.get(runId);ensure(latest?.judgmentId,'Judgment Day not prepared');
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
        implementerRunId:latest.correctionRunId??latest.steps.find(x=>x.phase==='IMPLEMENT')?.result?.runId});
      const verdict=await this.rdd.assess(tx.id);
      if(verdict.record.state==='APPROVED_PENDING_ACK')await this.rdd.acknowledge(tx.id,verdict.record.revision);
      if(!['APPROVED_PENDING_ACK','ACKNOWLEDGED'].includes(verdict.record.state))
        return {...common,status:verdict.record.state,phaseId:phase.id,reviewId:latest.judgmentId,panterRdd:verdict,next:[]};
      await this.write(s=>{const r=s.runs.find(x=>x.id===runId)!;const st=r.steps.find(x=>x.id===phase.id)!;
        if(st.status!=='COMPLETE'){st.status='COMPLETE';r.revision++;}});
      return this.tick(runId,runtime);
    }
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
          const remote=await this.mesh.startReview('gpt-a',{missionId:record.id,kind,objective:record.objective,candidateSha:record.candidateSha!,idempotencyKey:`harness:${record.id}:review:${record.candidateSha}`});
          await this.write(s=>{const r=s.runs.find(x=>x.id===runId)!;if(!r.reviewId){r.reviewId=remote.id;r.reviewTransport='REMOTE';r.revision++;}});
        }else{
          const native=await this.native.create({missionId:record.id,kind,objective:record.objective,candidateSha:record.candidateSha!,idempotencyKey:`harness:${record.id}:review:${record.candidateSha}`});
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
        if(this.rdd){
          const tx=await this.rdd.begin({missionId:now.id,reviewId:now.reviewId,source:'NATIVE',
            candidateSha:now.candidateSha!,kind,localProject:now.project,repository:now.githubRepository??(githubProject.test(now.project)?now.project:undefined),
            prNumber:now.githubPrNumber,expectedBase:now.githubExpectedBase,deliveryStrategy:now.deliveryStrategy,
            implementerRunId:now.correctionRunId??now.steps.find(x=>x.phase==='IMPLEMENT')?.result?.runId});
          if(now.previousReviewId){const previous=await this.rdd.getForReview(now.previousReviewId);
            if(previous&&previous.state!=='SUPERSEDED'&&previous.state!=='ACKNOWLEDGED')
              await this.rdd.supersede(previous.id,now.reviewId,previous.revision);}
          const verdict=await this.rdd.assess(tx.id);
          if(verdict.record.state==='APPROVED_PENDING_ACK')await this.rdd.acknowledge(tx.id,verdict.record.revision);
          if(['APPROVED_PENDING_ACK','ACKNOWLEDGED'].includes(verdict.record.state)){
            await this.write(s=>{const r=s.runs.find(x=>x.id===runId)!;const item=r.steps.find(x=>x.id===phase.id)!;
              if(item.status!=='COMPLETE'){item.status='COMPLETE';r.revision++;}});
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
      const review=await this.mesh.reviewStatus('gpt-a',now.reviewId);
      const evidence=assessMeshReview({kind:review.review.kind,candidateSha:review.review.candidateSha,work:review.work});
      if(this.rdd&&review.stage==='READY_FOR_CONTROLLER'){
        const tx=await this.rdd.begin({missionId:now.id,reviewId:now.reviewId,source:'REMOTE',
          candidateSha:now.candidateSha!,kind,localProject:now.project,repository:now.githubRepository??(githubProject.test(now.project)?now.project:undefined),
          prNumber:now.githubPrNumber,expectedBase:now.githubExpectedBase,deliveryStrategy:now.deliveryStrategy,
          implementerRunId:now.correctionRunId??now.steps.find(x=>x.phase==='IMPLEMENT')?.result?.runId});
        const verdict=await this.rdd.assess(tx.id);
        if(verdict.record.state==='APPROVED_PENDING_ACK')await this.rdd.acknowledge(tx.id,verdict.record.revision);
        if(['APPROVED_PENDING_ACK','ACKNOWLEDGED'].includes(verdict.record.state)){
          await this.write(s=>{const r=s.runs.find(x=>x.id===runId)!;const item=r.steps.find(x=>x.id===phase.id)!;
            if(item.status!=='COMPLETE'){item.status='COMPLETE';r.revision++;}});
          return this.tick(runId,runtime);
        }
        return {...common,status:verdict.record.state,phaseId:phase.id,reviewId:now.reviewId,review:evidence,panterRdd:verdict,next:[]};
      }
      return {...common,status:review.stage==='AWAITING_REPORTS'?'WAITING_REMOTE_REVIEW':
        evidence.status==='EVIDENCE_INCOMPLETE'?'REVIEW_EVIDENCE_INCOMPLETE':'AWAITING_RDD_AUTHORITY',
        phaseId:phase.id,reviewId:now.reviewId,review:evidence,next:[]};
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
          if(st.status==='PENDING'){st.status='ISSUED';st.execution=max>0?'GPT_A_NATIVE':'GPT_A_INLINE';r.revision++;}});
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
      `Verify the exact frozen candidate ${record.candidateSha} against: ${brief}. Independently reproduce checks, read-only; report run identity and evidence.`;
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
        idempotencyKey:`harness:${record.id}:${phase.id}:${record.candidateSha??'none'}:${record.correctionAttempts??0}`});
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
