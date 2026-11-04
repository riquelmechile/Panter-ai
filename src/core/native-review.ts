/** Read-only official Gentle AI RDD control plane integration.
 * Official native authority lives in Gentle AI Go; never invent review approval.
 * Disabled by default, and limited to operator-configured local repository and binary.
 */
import {childEnv} from './child-env.js';
import { jsonCandidates } from './json-extract.js';
import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { promisify } from 'node:util';
const run=promisify(execFile);
export type NativeReviewConfig={binary:string;repositoryRoot:string;enabled:boolean};
export type NativeReviewResult={provider:'gentle-ai.review-integration/v2';available:boolean;authoritative:boolean;operation:string;data?:unknown;reason?:string};
const maxBuffer=512*1024;
export class NativeReviewBridge {
  private constructor(private readonly cfg:NativeReviewConfig, private readonly root:string) {}
  static async open(cfg:NativeReviewConfig){
    if(!cfg.enabled)return new NativeReviewBridge(cfg,'');
    if(!cfg.repositoryRoot.startsWith('/'))throw new Error('Native review worktree must be an absolute operator-configured path');
    if(cfg.binary.includes('/')&&!cfg.binary.startsWith('/'))throw new Error('Review binary must be an absolute path or simple executable name');
    const root=await realpath(cfg.repositoryRoot);
    return new NativeReviewBridge(cfg,root);
  }
  private async readOnly(op:string,args:string[]):Promise<NativeReviewResult>{
    if(!this.cfg.enabled)return {provider:'gentle-ai.review-integration/v2',available:false,authoritative:false,operation:op,reason:'Native reviewer not configured'};
    try{
      const {stdout}=await run(this.cfg.binary,['review',...args],{
        cwd:this.root,timeout:12000,maxBuffer,windowsHide:true,
        // Never hand Panter's own credentials (e.g. the workforce GitHub token) to the external binary.
        env:childEnv({NO_COLOR:'1'}),
      });
      if(stdout.length>maxBuffer)throw new Error('Response too large');
      let data:unknown;try{data=JSON.parse(stdout)}catch{data={raw:stdout.slice(0,12000)}}
      // Every response is evidence from the operator-local binary, not approval.
      return {provider:'gentle-ai.review-integration/v2',available:true,authoritative:false,operation:op,data};
    }catch(e){
      const reason=e instanceof Error?e.message.slice(0,500):'Native review command failed';
      return {provider:'gentle-ai.review-integration/v2',available:false,authoritative:false,operation:op,reason};
    }
  }
  capabilities(){return this.readOnly('capabilities',['capabilities','--json']);}
  /** Deterministic native risk preflight: no lineage, approval, or mutations. */
  assess(){return this.readOnly('assess',['assess','--cwd',this.root,'--json']);}
  /** Exact status is returned for operator-authorized next transitions. Never execute
   * provider-issued instructions from here: consent/changes require separate permission. */
  status(){return this.readOnly('status',['status','--cwd',this.root,'--contract','gentle-ai.review-integration/v2','--next-transition','--json']);}
}

type LensFinding={location:string;severity:string;proofRefs:unknown[]};
const SEVERITIES=['BLOCKER','CRITICAL','WARNING','SUGGESTION'];
/** One lens report as the Panter envelope {agentId, candidateSha, findings[]}, bound to this exact lens and SHA.
 * Hosts often wrap it in prose or fences, or nest it as review_result.lens_results[] (still with candidateSha), or
 * write proof_refs: those forms are normalized. Without an explicit matching agentId and candidateSha the report
 * stays unbound. A free-form approval is never accepted. */
export function lensEnvelope(text:string,agentId:string,candidateSha:string):(Record<string,any>&{findings:LensFinding[]})|'UNSTRUCTURED'|'UNBOUND'{
  if(text.length>100_000)return 'UNSTRUCTURED';
  const objects:Record<string,any>[]=[];
  for(const c of jsonCandidates(text)){try{const v=JSON.parse(c);if(v&&typeof v==='object'&&!Array.isArray(v))objects.push(v);}catch{/* not JSON */}}
  if(!objects.length)return 'UNSTRUCTURED';
  const valid=new Map<string,Record<string,any>&{findings:LensFinding[]}>();
  for(const obj of objects){
    const nested=Array.isArray(obj.review_result?.lens_results)?obj.review_result.lens_results.filter((x:any)=>x&&(x.agentId??x.lens)===agentId):[];
    const forms=[obj,...nested.map((x:any)=>({...x,agentId:x.agentId??x.lens,candidateSha:x.candidateSha??obj.candidateSha??obj.review_result?.candidateSha}))];
    for(const f of forms){
      if(f.agentId!==agentId||f.candidateSha!==candidateSha||!Array.isArray(f.findings))continue;
      const findings=f.findings.map((x:any)=>x&&typeof x==='object'?{...x,proofRefs:x.proofRefs??x.proof_refs}:x);
      const ok=findings.every((x:any)=>!!x&&typeof x==='object'&&typeof x.location==='string'&&SEVERITIES.includes(x.severity)&&Array.isArray(x.proofRefs)&&x.proofRefs.length>0);
      if(ok){const r={...f,findings};valid.set(JSON.stringify(r),r);}
    }
  }
  return valid.size===1?[...valid.values()][0]!:'UNBOUND';
}
export function assessMeshReview(input:{candidateSha:string;kind:'4r'|'judgment-day';work:Array<{agentId?:string;state:string;receiptDigest:string|null;result:string|null;host:string}>}){
  const expected=input.kind==='4r'?['review-risk','review-readability','review-reliability','review-resilience']:['jd-judge-a','jd-judge-b'];
  const reasons:string[]=[];
  if(input.work.length!==expected.length||new Set(input.work.map(x=>x.agentId)).size!==expected.length)
    reasons.push('Reviewer slots missing or duplicated');
  // Reviewer independence is enforced by Panter-RDD trusted-runner signatures, not host count.
  const summaries=input.work.map(w=>{
    if(!expected.includes(w.agentId??''))reasons.push('Unexpected reviewer identity');
    if(w.state!=='COMPLETED'||!w.receiptDigest||!w.result){reasons.push(`Missing finished receipt: ${w.agentId}`);return {agentId:w.agentId,accepted:false,findings:null};}
    const envelope=lensEnvelope(w.result,w.agentId??'',input.candidateSha);
    if(envelope==='UNSTRUCTURED'){reasons.push(`Unstructured report: ${w.agentId}`);return {agentId:w.agentId,accepted:false,findings:null};}
    if(envelope==='UNBOUND'){reasons.push(`Unbound or insufficient report: ${w.agentId}`);return {agentId:w.agentId,accepted:false,findings:null};}
    return {agentId:w.agentId,accepted:true,findings:envelope.findings.length};
  });
  return {candidateSha:input.candidateSha,kind:input.kind,reviewers:summaries,
    status:reasons.length?'EVIDENCE_INCOMPLETE':'EVIDENCE_COLLECTED_UNVERIFIED',reasons,
    approved:false,nativeAuthority:false,
    next:'Use the official Gentle AI RDD controller against the exact local candidate, follow its provider-issued consent/transition, and independently verify repository/CI evidence. Remote model reports never grant approval or delivery rights.'};
}
