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
/** Every report in a lens's text that claims this exact lens and SHA (top-level or nested as
 * review_result.lens_results[]), normalized (proof_refs -> proofRefs), valid or not. An echo of the
 * completion-format template is ignored. */
function boundReports(text:string,agentId:string,candidateSha:string):{objects:number;reports:Record<string,any>[]}{
  const objects:Record<string,any>[]=[];
  for(const c of jsonCandidates(text)){try{const v=JSON.parse(c);if(v&&typeof v==='object'&&!Array.isArray(v))objects.push(v);}catch{/* not JSON */}}
  const distinct=new Map<string,Record<string,any>>();
  for(const obj of objects){
    const nested=Array.isArray(obj.review_result?.lens_results)?obj.review_result.lens_results.filter((x:any)=>x&&typeof x==='object'&&(x.agentId??x.lens)===agentId):[];
    const forms=[obj,...nested.map((x:any)=>({...x,agentId:x.agentId??x.lens,candidateSha:x.candidateSha??obj.candidateSha??obj.review_result?.candidateSha}))];
    for(const f of forms){
      if(f.agentId!==agentId||f.candidateSha!==candidateSha)continue;
      const findings=Array.isArray(f.findings)?f.findings.map((x:any)=>{
        if(!x||typeof x!=='object')return x;const {proof_refs,...rest}=x;return {...rest,proofRefs:x.proofRefs??proof_refs};
      }):f.findings;
      if(templateEcho(findings))continue;
      const r={...f,findings};
      distinct.set(canonical(r),r);
    }
  }
  return {objects:objects.length,reports:[...distinct.values()]};
}
/** Only an exact echo of the completion-format template: every finding is all placeholders. */
const TEMPLATE_SEVERITY='BLOCKER | CRITICAL | WARNING | SUGGESTION';
const placeholder=(v:unknown)=>typeof v==='string'&&/^<[^<>]*>$/.test(v.trim());
function templateEcho(findings:unknown){
  return Array.isArray(findings)&&findings.length>0&&findings.every((x:any)=>x&&x.severity===TEMPLATE_SEVERITY&&placeholder(x.location));
}
/** Order-independent serialization, so the same report written twice is one report. */
function canonical(v:unknown):string{
  if(Array.isArray(v))return `[${v.map(canonical).join(',')}]`;
  if(v&&typeof v==='object')return `{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${canonical((v as any)[k])}`).join(',')}}`;
  return JSON.stringify(v)??'null';
}
const SEVERE_VALUE=/\b(critical|blocker)\b/i;
const SEVERITY_KEY=/^(severity|sev|level|priority)$/i;
/** Severity-like text written anywhere outside strict JSON (YAML, single or typographic quotes, prose "severity: critical"). */
const rawSevere=(text:string)=>(text.match(/["'\u201c\u201d]?\b(severity|sev|level|priority)\b["'\u201c\u201d]?\s*[:=]\s*["'\u201c\u201d]?\s*(critical|blocker)\b(?!\s*\|)/gi)??[]).length;
/** Severe values under severity-like keys in every parsed JSON object of the text, at any depth (bounded), each distinct object once. */
function structuralSevere(text:string){
  const seen=new Set<string>();let n=0;
  const walk=(v:unknown,depth:number):void=>{
    if(depth>32||!v||typeof v!=='object')return;
    if(Array.isArray(v)){for(const x of v)walk(x,depth+1);return;}
    for(const [k,x] of Object.entries(v)){
      if(SEVERITY_KEY.test(k)&&typeof x==='string'&&x!==TEMPLATE_SEVERITY&&SEVERE_VALUE.test(x))n++;
      else walk(x,depth+1);
    }
  };
  for(const c of jsonCandidates(text)){
    let v:unknown;try{v=JSON.parse(c);}catch{continue;}
    if(!v||typeof v!=='object')continue;
    const key=canonical(v);if(seen.has(key))continue;seen.add(key);
    walk(v,0);
  }
  return n;
}
const severe=(x:any)=>typeof x?.severity==='string'&&/^(blocker|critical)$/i.test(x.severity.trim());
/** One lens report as the Panter envelope {agentId, candidateSha, findings[]}, bound to this exact lens and SHA.
 * Hosts often wrap it in prose or fences, or nest it as review_result.lens_results[], or write proof_refs: those
 * forms are normalized. Exactly ONE report may claim this lens and SHA, and it must be fully valid: a second,
 * different report (e.g. a clean draft next to a CRITICAL one) or an invalid one makes the lens unbound, so a
 * severe finding can never be hidden. A free-form approval is never accepted. */
export function lensEnvelope(text:string,agentId:string,candidateSha:string):(Record<string,any>&{findings:LensFinding[]})|'UNSTRUCTURED'|'UNBOUND'{
  if(text.length>100_000)return 'UNSTRUCTURED';
  const {objects,reports}=boundReports(text,agentId,candidateSha);
  if(!objects)return 'UNSTRUCTURED';
  if(reports.length!==1)return 'UNBOUND';
  const r=reports[0]!;
  const ok=Array.isArray(r.findings)&&r.findings.every((x:any)=>!!x&&typeof x==='object'&&typeof x.location==='string'&&SEVERITIES.includes(x.severity)&&Array.isArray(x.proofRefs)&&x.proofRefs.length>0);
  if(!ok)return 'UNBOUND';
  // Backstop for the one dangerous outcome, a lens accepted as clean: if the accepted report carries no severe
  // finding, nothing severity-like may appear anywhere else in the text (another key or nesting, escapes, a
  // truncated scan, non-JSON forms). A report that already carries a severe finding blocks the gate by itself.
  if(!r.findings.some(severe)&&(structuralSevere(text)>0||rawSevere(text)>0))return 'UNBOUND';
  return r as Record<string,any>&{findings:LensFinding[]};
}
/** Severe findings claimed for this lens and SHA in reports that were not accepted, so they are surfaced, never lost. */
export function unacceptedSevere(text:string,agentId:string,candidateSha:string){
  if(text.length>100_000)return 0;
  const bound=boundReports(text,agentId,candidateSha).reports.reduce((n,r)=>n+(Array.isArray(r.findings)?r.findings.filter(severe).length:0),0);
  return Math.max(bound,structuralSevere(text),rawSevere(text));
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
    if(envelope==='UNBOUND'){
      reasons.push(`Unbound or insufficient report: ${w.agentId}`);
      const hidden=unacceptedSevere(w.result,w.agentId??'',input.candidateSha);
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
