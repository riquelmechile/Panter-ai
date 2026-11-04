/** Read-only official Gentle AI RDD control plane integration.
 * Official native authority lives in Gentle AI Go; never invent review approval.
 * Disabled by default, and limited to operator-configured local repository and binary.
 */
import {childEnv} from './child-env.js';
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
const SEVERE_VALUE=/\b(critical|blocker)\b/i;
/** A lens report is strict: the whole text is ONE JSON object, optionally inside a single code fence. Any prose
 * outside it makes the report unstructured, so nothing written elsewhere can contradict what is counted. */
function strictJson(text:string):Record<string,any>|null{
  let t=text.replace(/\r\n/g,'\n').trim();
  const fence=/^```[a-zA-Z0-9_-]*[ \t]*\n([\s\S]*)\n```$/.exec(t);
  if(fence){t=fence[1]!.trim();if(t.includes('\n```'))return null;}
  if(!t.startsWith('{'))return null;
  try{const v=JSON.parse(t);return v&&typeof v==='object'&&!Array.isArray(v)?v:null;}catch{return null;}
}
/** Severe values anywhere in the parsed report under severity-like keys (severity, sev, level, priority and
 * variants such as severity_level), whatever the value's shape: strings inside arrays or objects under such a key
 * count too. Iterative; anything deeper than the bound counts as severe (fail closed). */
function severeUnderSeverityKeys(root:unknown){
  let n=0;const stack:Array<[unknown,number,boolean]>=[[root,0,false]];
  while(stack.length){
    const [v,depth,underSeverity]=stack.pop()!;
    if(typeof v==='string'){if(underSeverity&&SEVERE_VALUE.test(v))n++;continue;}
    if(!v||typeof v!=='object')continue;
    if(depth>64){n++;continue;}
    const entries=Array.isArray(v)?v.map(x=>['',x] as const):Object.entries(v);
    for(const [k,x] of entries){
      const inSev=underSeverity||(k!==''&&/sev|level|priority/i.test(k));
      // Under a severity-like key, a key naming a severe level with a non-zero value counts too: {"bySeverity":{"critical":1}}.
      if(inSev&&k!==''&&SEVERE_VALUE.test(k)&&!(x===0||x===false||x===null||x===''||x==='0'||(Array.isArray(x)&&x.length===0)))n++;
      stack.push([x,depth+1,inSev]);
    }
  }
  return n;
}
const isSevere=(x:any)=>typeof x?.severity==='string'&&/^(blocker|critical)$/i.test(x.severity.trim());
/** One lens report as the Panter envelope {agentId, candidateSha, findings[]}, bound to this exact lens and SHA.
 * The whole text must be that one JSON object (a single code fence around it is allowed). It may also nest the
 * lens as review_result.lens_results[] (inheriting candidateSha); exactly one entry may claim the lens.
 * proof_refs is accepted as proofRefs. A report accepted as clean must not carry a severe value anywhere else. */
export function lensEnvelope(text:string,agentId:string,candidateSha:string):(Record<string,any>&{findings:LensFinding[]})|'UNSTRUCTURED'|'UNBOUND'{
  if(text.length>100_000)return 'UNSTRUCTURED';
  const obj=strictJson(text);
  if(!obj)return 'UNSTRUCTURED';
  const nested=Array.isArray(obj.review_result?.lens_results)?obj.review_result.lens_results.filter((x:any)=>x&&typeof x==='object'&&(x.agentId??x.lens)===agentId):[];
  const forms=[obj,...nested.map((x:any)=>({...x,agentId:x.agentId??x.lens,candidateSha:x.candidateSha??obj.candidateSha??obj.review_result?.candidateSha}))]
    .filter(f=>f.agentId===agentId&&f.candidateSha===candidateSha);
  if(forms.length!==1)return 'UNBOUND';
  const f=forms[0]!;
  if(!Array.isArray(f.findings))return 'UNBOUND';
  const findings=f.findings.map((x:any)=>{if(!x||typeof x!=='object')return x;const {proof_refs,...rest}=x;return {...rest,proofRefs:x.proofRefs??proof_refs};});
  const ok=findings.every((x:any)=>!!x&&typeof x==='object'&&typeof x.location==='string'&&SEVERITIES.includes(x.severity)&&Array.isArray(x.proofRefs)&&x.proofRefs.length>0);
  if(!ok)return 'UNBOUND';
  if(!findings.some(isSevere)&&severeUnderSeverityKeys(obj)>0)return 'UNBOUND';
  return {...f,findings} as Record<string,any>&{findings:LensFinding[]};
}
/** Severe values claimed in a report that was not accepted, so they are surfaced, never lost. */
export function unacceptedSevere(text:string){
  if(text.length>100_000)return 0;
  const obj=strictJson(text);
  if(obj)return severeUnderSeverityKeys(obj);
  return (text.match(/\b(severity|sev|level|priority)\b\W{0,6}[:=]\W{0,6}(critical|blocker)\b/gi)??[]).length;
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
    if(envelope==='UNSTRUCTURED'){
      reasons.push(`Unstructured report: ${w.agentId}`);
      const hidden=unacceptedSevere(w.result);
      if(hidden)reasons.push(`Severe finding(s) reported in an unaccepted report: ${w.agentId} (${hidden})`);
      return {agentId:w.agentId,accepted:false,findings:null};
    }
    if(envelope==='UNBOUND'){
      reasons.push(`Unbound or insufficient report: ${w.agentId}`);
      const hidden=unacceptedSevere(w.result);
      if(hidden)reasons.push(`Severe finding(s) reported in an unaccepted report: ${w.agentId} (${hidden})`);
      return {agentId:w.agentId,accepted:false,findings:null};
    }
    return {agentId:w.agentId,accepted:true,findings:envelope.findings.length};
  });
  return {candidateSha:input.candidateSha,kind:input.kind,reviewers:summaries,
    status:reasons.length?'EVIDENCE_INCOMPLETE':'EVIDENCE_COLLECTED_UNVERIFIED',reasons,
    approved:false,nativeAuthority:false,
    next:'Use the official Gentle AI RDD controller against the exact local candidate, follow its provider-issued consent/transition, and independently verify repository/CI evidence. Remote model reports never grant approval or delivery rights.'};
}
