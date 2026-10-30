/** Panter-RDD: self-hosted deterministic review authority, NOT Gentle AI's Go controller.
 * The MCP never executes an LLM, authenticates native child model instances or authorizes GitHub writes.
 * One process; immutable SHA/receipt binding; GitHub is queried by the server, not asserted by an LLM.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { NativeSubagentReview } from './native-review-workflow.js';
import type { MeshEngine } from './mesh.js';
import { assessMeshReview } from './native-review.js';
import type { GitHubDeliveryGate, GitHubDecision } from './github-delivery.js';

const validSha = /^[0-9a-f]{40}$/;
const validRepo = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const digest = (v:unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
function demand(v:unknown,m:string):asserts v { if(!v)throw new Error(m); }
export type PanterRddState = 'COLLECTING'|'NEEDS_CORRECTION'|'NEEDS_REVIEW_EVIDENCE'|'NEEDS_GITHUB_PROOF'|'APPROVED_PENDING_ACK'|'ACKNOWLEDGED'|'SUPERSEDED';
export type RddSource = 'NATIVE' | 'REMOTE';
export type PanterRddRecord = {
  id:string; missionId:string; reviewId:string; source:RddSource; candidateSha:string; kind:'4r'|'judgment-day';
  implementerRunId?:string; repository?:string; prNumber?:number; expectedBase?:string;
  state:PanterRddState; evidenceDigest:string|null; githubEvidenceDigest:string|null;
  revision:number; createdAt:string; updatedAt:string; acknowledgedAt:string|null; supersededBy:string|null;
};
type Store={version:1;reviews:PanterRddRecord[]};
type Begin={missionId:string;reviewId:string;source:RddSource;candidateSha:string;kind:'4r'|'judgment-day';
  implementerRunId?:string; repository?:string;prNumber?:number;expectedBase?:string};

export class PanterRdd {
  private data:Store={version:1,reviews:[]};
  private serial:Promise<unknown>=Promise.resolve();
  private constructor(private readonly file:string,private readonly native:NativeSubagentReview,
    private readonly mesh:MeshEngine,private readonly github:GitHubDeliveryGate|null){}
  static async open(dir:string,native:NativeSubagentReview,mesh:MeshEngine,github:GitHubDeliveryGate|null=null){
    await mkdir(resolve(dir),{recursive:true,mode:0o700});
    const a=new PanterRdd(join(resolve(dir),'panter-rdd.json'),native,mesh,github);
    try{
      const d:unknown=JSON.parse(await readFile(a.file,'utf8'));
      demand(d&&typeof d==='object'&&'version' in d&&d.version===1&&'reviews' in d&&Array.isArray(d.reviews),'Invalid Panter-RDD ledger');
      a.data=d as Store;
    }catch(e){if(!(e instanceof Error)||!('code' in e)||e.code!=='ENOENT')throw e;}
    return a;
  }
  private async read<T>(f:(d:Store)=>T):Promise<T>{await this.serial;return structuredClone(f(this.data));}
  private async write<T>(f:(d:Store)=>T):Promise<T>{
    const p=this.serial.then(async()=>{
      const next=structuredClone(this.data),out=f(next);
      const temp=`${this.file}.${randomUUID()}.tmp`;
      await writeFile(temp,JSON.stringify(next,null,2),{mode:0o600,flag:'wx'});
      await rename(temp,this.file);this.data=next;
      return structuredClone(out);
    });
    this.serial=p.then(()=>undefined,()=>undefined);return p;
  }
  private validateBegin(i:Begin){
    demand(!!i.missionId.trim()&&i.missionId.length<=120,'Invalid mission');
    demand(!!i.reviewId.trim()&&i.reviewId.length<=120,'Invalid review ID');
    demand(validSha.test(i.candidateSha),'Panter-RDD requires an exact 40-hex Git commit SHA');
    demand(i.source==='NATIVE'||i.source==='REMOTE','Unknown RDD review source');
    demand(i.kind==='4r'||i.kind==='judgment-day','Invalid RDD review type');
    demand(!i.implementerRunId||/^[A-Za-z0-9._:-]{8,160}$/.test(i.implementerRunId),'Invalid implementer execution ID');
    demand(!i.repository||validRepo.test(i.repository),'Invalid GitHub repository');
    demand(!i.prNumber||(!!i.repository&&Number.isInteger(i.prNumber)&&i.prNumber>0),'GitHub PR requires repository');
    demand(!i.expectedBase||!!i.repository,'GitHub base requires repository');
    demand(!i.repository||!!this.github?.allows(i.repository),'Repository is not in operator allowlist');
  }
  /** Begin creates authority for an existing review, never from an LLM-provided reviewer verdict. */
  async begin(i:Begin){
    this.validateBegin(i);
    const source = i.source==='NATIVE'
      ? await this.native.status(i.reviewId)
      : (await this.mesh.reviewStatus('gpt-a',i.reviewId)).review;
    const sourceSha=source.candidateSha;
    const sourceMission=source.missionId;
    const sourceKind=source.kind;
    demand(sourceSha===i.candidateSha&&sourceMission===i.missionId&&sourceKind===i.kind,'Review identity does not match the frozen transaction');
    return this.write(d=>{
      const original=d.reviews.find(x=>x.missionId===i.missionId&&x.reviewId===i.reviewId);
      if(original){
        demand(original.source===i.source&&original.candidateSha===i.candidateSha&&original.kind===i.kind&&original.implementerRunId===i.implementerRunId,
          'Conflicting review registration');
        demand(!original.repository||original.repository===i.repository,'RDD repository binding conflict');
        demand(!original.prNumber||original.prNumber===i.prNumber,'RDD PR binding conflict');
        demand(!original.expectedBase||original.expectedBase===i.expectedBase,'RDD base binding conflict');
        // The harness may attach an authorized PR after the reviewers finished.
        // Metadata binding can only progress empty -> fixed; evidence/ack resets.
        if((!original.repository&&i.repository)||(!original.prNumber&&i.prNumber)||(!original.expectedBase&&i.expectedBase)){
          original.repository=i.repository;original.prNumber=i.prNumber;original.expectedBase=i.expectedBase;
          original.state='COLLECTING';original.evidenceDigest=null;original.githubEvidenceDigest=null;
          original.acknowledgedAt=null;original.revision++;original.updatedAt=new Date().toISOString();
        }
        return original;
      }
      const now=new Date().toISOString();
      const r:PanterRddRecord={id:randomUUID(),...i,state:'COLLECTING',evidenceDigest:null,githubEvidenceDigest:null,
        revision:1,createdAt:now,updatedAt:now,acknowledgedAt:null,supersededBy:null};
      d.reviews.push(r);return r;
    });
  }
  get(id:string){return this.read(d=>d.reviews.find(r=>r.id===id)??null);}
  getForReview(reviewId:string){return this.read(d=>d.reviews.find(r=>r.reviewId===reviewId)??null);}
  /** Reconcile with actual review ledger and GitHub. Pure model claims cannot pass this gate. */
  async assess(id:string){
    const current=await this.get(id);demand(current,'Unknown Panter-RDD transaction');
    if(current.state==='SUPERSEDED')return {record:current,reason:'A new candidate superseded this review',approved:false};
    let severe=0,complete=false,independence=false,receipts:string[]=[];
    if(current.source==='NATIVE'){
      const r=await this.native.status(current.reviewId);
      demand(r.candidateSha===current.candidateSha&&r.missionId===current.missionId&&r.kind===current.kind,'Native review target changed');
      const slots=r.slots;
      complete=r.evidenceComplete&&slots.every(s=>s.state==='REPORTED'&&/^[0-9a-f]{64}$/.test(s.receiptDigest??''));
      const runs=slots.map(s=>s.subagentRunId).filter((v):v is string=>typeof v==='string');
      independence=complete&&runs.length===slots.length&&new Set(runs).size===runs.length&&runs.every(v=>v!==current.implementerRunId&&v!=='gpt-a');
      severe=r.severeFindings.length;
      receipts=slots.map(s=>s.receiptDigest??'');
    }else{
      const r=await this.mesh.reviewStatus('gpt-a',current.reviewId);
      demand(r.review.candidateSha===current.candidateSha&&r.review.missionId===current.missionId&&r.review.kind===current.kind,'Remote review target changed');
      const a=assessMeshReview({kind:current.kind,candidateSha:current.candidateSha,work:r.work});
      complete=r.stage==='READY_FOR_CONTROLLER'&&a.status==='EVIDENCE_COLLECTED_UNVERIFIED';
      receipts=r.work.map(w=>w.receiptDigest??'');
      // Host identities are authenticated by MCP, but model execution itself is not independently attested.
      independence=complete&&new Set(r.work.map(w=>w.host)).size===r.work.length&&r.work.every(w=>w.host!=='gpt-a');
      severe=0; // Any unparsed/missing findings are not a clean result: they fail closed at the evidence gate below.
      if(complete)for(const w of r.work){try{const data=JSON.parse(w.result??'');if(Array.isArray(data.findings))severe+=data.findings.filter((f:{severity?:string})=>f.severity==='CRITICAL'||f.severity==='BLOCKER').length;else complete=false;}catch{complete=false;}}
    }
    const evidenceHash=complete&&independence?digest({id:current.reviewId,sha:current.candidateSha,receipts}):null;
    let github:GitHubDecision|null=null;
    if(complete&&independence&&severe===0&&current.repository&&current.prNumber&&this.github){
      github=await this.github.inspect({repository:current.repository,prNumber:current.prNumber,expectedSha:current.candidateSha,expectedBase:current.expectedBase});
    }
    const state:PanterRddState=!complete||!independence?'NEEDS_REVIEW_EVIDENCE':severe?'NEEDS_CORRECTION':
      github?.state==='REVIEWABLE'?'APPROVED_PENDING_ACK':'NEEDS_GITHUB_PROOF';
    const githubHash=github?.state==='REVIEWABLE'?digest({sha:github.headSha,checks:github.satisfied,pr:current.prNumber}):null;
    const record=await this.write(d=>{
      const r=d.reviews.find(x=>x.id===id);demand(r,'Unknown Panter-RDD transaction');
      if(r.state==='SUPERSEDED')return r;
      const next=r.state==='ACKNOWLEDGED'&&state==='APPROVED_PENDING_ACK'&&r.evidenceDigest===evidenceHash&&r.githubEvidenceDigest===githubHash?'ACKNOWLEDGED':state;
      if(r.state!==next||r.evidenceDigest!==evidenceHash||r.githubEvidenceDigest!==githubHash){
        r.state=next;r.evidenceDigest=evidenceHash;r.githubEvidenceDigest=githubHash;r.revision++;r.updatedAt=new Date().toISOString();
        if(next!=='ACKNOWLEDGED')r.acknowledgedAt=null;
      }
      return r;
    });
    return {record,approved:record.state==='APPROVED_PENDING_ACK'||record.state==='ACKNOWLEDGED',
      assurance:'GITHUB_CHECKS_VERIFIED__REVIEW_RUNS_HOST_REPORTED' as const,reviewComplete:complete,
      distinctReviewerRuns:independence,severeFindings:severe,github,
      note:'Panter-RDD approval is scoped to this candidate and available evidence. It is not official Gentle AI certification, cryptographic native-child attestation, or GitHub delivery authorization.'};
  }
  /** Burn/ack only after fresh source verification. Acknowledgement is NOT permission to merge. */
  async acknowledge(id:string,expectedRevision:number){
    const assessed=await this.assess(id);
    demand(assessed.record.state==='APPROVED_PENDING_ACK'||assessed.record.state==='ACKNOWLEDGED','Cannot acknowledge an unapproved candidate');
    return this.write(d=>{
      const r=d.reviews.find(x=>x.id===id);demand(r,'Unknown RDD transaction');
      if(r.state==='ACKNOWLEDGED')return r;
      demand(r.revision===expectedRevision,'Stale RDD acknowledgement; re-read current revision');
      demand(r.evidenceDigest&&r.githubEvidenceDigest,'Missing authoritative source proof');
      r.state='ACKNOWLEDGED';r.acknowledgedAt=new Date().toISOString();r.revision++;r.updatedAt=r.acknowledgedAt;
      return r;
    });
  }
  /** Corrections are separate authorized development work; this only retires the old candidate.
   * The new candidate needs a NEW review and GitHub CI on its exact SHA. */
  async supersede(id:string,newReviewId:string,expectedRevision:number){
    const before=await this.get(id);demand(before,'Unknown RDD transaction');
    const next=await this.getForReview(newReviewId);
    demand(next&&next.id!==id&&next.missionId===before.missionId&&next.candidateSha!==before.candidateSha,
      'A new registered review of a different SHA in the same mission is required');
    return this.write(d=>{
      const current=d.reviews.find(x=>x.id===id);demand(current,'Unknown RDD transaction');
      if(current.state==='SUPERSEDED'){demand(current.supersededBy===next.id,'Conflicting supersession');return current;}
      demand(current.revision===expectedRevision,'Stale correction revision');
      demand(current.state!=='ACKNOWLEDGED','Acknowledged candidate cannot be rewritten');
      current.state='SUPERSEDED';current.supersededBy=next.id;current.revision++;current.updatedAt=new Date().toISOString();return current;
    });
  }
}
