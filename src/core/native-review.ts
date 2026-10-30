/** Read-only official Gentle AI RDD control plane integration.
 * Official native authority lives in Gentle AI Go; never invent review approval.
 * Disabled by default, and limited to operator-configured local repository and binary.
 */
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
        env:{...process.env,NO_COLOR:'1'},
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

export function assessMeshReview(input:{candidateSha:string;kind:'4r'|'judgment-day';work:Array<{agentId?:string;state:string;receiptDigest:string|null;result:string|null;host:string}>}){
  const expected=input.kind==='4r'?['review-risk','review-readability','review-reliability','review-resilience']:['jd-judge-a','jd-judge-b'];
  const reasons:string[]=[];
  if(input.work.length!==expected.length||new Set(input.work.map(x=>x.agentId)).size!==expected.length)
    reasons.push('Reviewer slots missing or duplicated');
  // Reviewer independence is enforced by Panter-RDD trusted-runner signatures, not host count.
  const summaries=input.work.map(w=>{
    if(!expected.includes(w.agentId??''))reasons.push('Unexpected reviewer identity');
    if(w.state!=='COMPLETED'||!w.receiptDigest||!w.result){reasons.push(`Missing finished receipt: ${w.agentId}`);return {agentId:w.agentId,accepted:false,findings:null};}
    let parsed:unknown;try{parsed=JSON.parse(w.result)}catch{reasons.push(`Unstructured report: ${w.agentId}`);return {agentId:w.agentId,accepted:false,findings:null};}
    if(!parsed||typeof parsed!=='object'){reasons.push(`Invalid report: ${w.agentId}`);return {agentId:w.agentId,accepted:false,findings:null};}
    const obj=parsed as Record<string,unknown>;
    // Accept a Panter envelope, not a free-form model approval. Never call it native Go authority.
    const validated=obj.candidateSha===input.candidateSha&&obj.agentId===w.agentId&&Array.isArray(obj.findings)&&
      (obj.findings as unknown[]).every(f=>!!f&&typeof f==='object'&&typeof (f as any).location==='string'&&typeof (f as any).severity==='string'&&
        ['BLOCKER','CRITICAL','WARNING','SUGGESTION'].includes((f as any).severity)&&Array.isArray((f as any).proofRefs)&& (f as any).proofRefs.length>0);
    if(!validated)reasons.push(`Unbound or insufficient report: ${w.agentId}`);
    return {agentId:w.agentId,accepted:validated,findings:validated?(obj.findings as unknown[]).length:null};
  });
  return {candidateSha:input.candidateSha,kind:input.kind,reviewers:summaries,
    status:reasons.length?'EVIDENCE_INCOMPLETE':'EVIDENCE_COLLECTED_UNVERIFIED',reasons,
    approved:false,nativeAuthority:false,
    next:'Use the official Gentle AI RDD controller against the exact local candidate, follow its provider-issued consent/transition, and independently verify repository/CI evidence. Remote model reports never grant approval or delivery rights.'};
}
