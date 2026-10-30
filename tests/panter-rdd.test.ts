import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {generateKeyPairSync,sign} from 'node:crypto';
import {attestedMessage} from '../src/core/review-attestation.js';
import {PanterRdd} from '../src/core/panter-rdd.js';
import {NativeSubagentReview} from '../src/core/native-review-workflow.js';
import {MeshEngine} from '../src/core/mesh.js';
import {GitHubDeliveryGate} from '../src/core/github-delivery.js';

const sha='a'.repeat(40),newSha='b'.repeat(40),repo='example/project';
const keys=generateKeyPairSync('ed25519');
const publicKey=keys.publicKey.export({type:'spki',format:'pem'}).toString();
const runnerKeys={trusted:publicKey};
function gate(breaks:{head?:string;ci?:string;labels?:string[];additions?:number}={}){
 const pr={state:'open',draft:false,head:{sha:breaks.head??sha,ref:'feat/rdd',repo:{full_name:repo}},base:{ref:'main'},
   body:'Refs #22',labels:(breaks.labels??['type:feature']).map(name=>({name})),additions:breaks.additions??50,deletions:20,commits:1};
 const m:Record<string,unknown>={'':{default_branch:'main'},'pulls/12':pr,'issues/22':{labels:[{name:'status:approved'}]},
  'pulls/12/commits?per_page=100':[{commit:{message:'feat: add review controller'}}],
  [`commits/${sha}/check-runs?per_page=100`]:{total_count:1,check_runs:[{name:'test',status:'completed',conclusion:breaks.ci??'success',head_sha:sha}]}};
 const fetcher=(async(u:string|URL|Request)=>{let k=String(u).split('/repos/example/project/')[1]??'';
  return {ok:m[k]!==undefined,status:m[k]!==undefined?200:404,text:async()=>JSON.stringify(m[k])} as Response;}) as typeof fetch;
 return new GitHubDeliveryGate({allowedRepositories:[repo],requiredChecks:['test']},fetcher);
}
async function setup(fn:(s:{native:NativeSubagentReview;mesh:MeshEngine;rdd:PanterRdd;dir:string})=>Promise<void>, g=gate()){
 const dir=await mkdtemp(join(tmpdir(),'panter-rdd-'));
 try{const native=await NativeSubagentReview.open(dir),mesh=await MeshEngine.open(dir),rdd=await PanterRdd.open(dir,native,mesh,g,runnerKeys);
  await fn({native,mesh,rdd,dir});}finally{await rm(dir,{recursive:true,force:true});}
}
async function input(native:NativeSubagentReview, shaValue=sha, suffix='base'){
 const review=await native.create({missionId:'mission-1',kind:'4r',objective:'Review exact candidate',candidateSha:shaValue,idempotencyKey:suffix});
 return {review,begin:{missionId:'mission-1',reviewId:review.reviewId,source:'NATIVE' as const,candidateSha:shaValue,kind:'4r' as const,repository:repo,prNumber:12,implementerRunId:'builder-1'}};
}
async function reportAll(native:NativeSubagentReview,review:Awaited<ReturnType<NativeSubagentReview['create']>>,withSevere=false){
 for(let i=0;i<review.slots.length;i++){
  const slot=review.slots[i]!;
  const report={agentId:slot.agentId,candidateSha:review.candidateSha,packetDigest:slot.packetDigest,
   subagentRunId:`independent-child-${i}`,evidence:[`Inspected frozen candidate ${review.candidateSha} and reviewed source paths`],
   findings:withSevere&&i===0?[{id:'RISK-1',location:'src/security.ts:1',severity:'CRITICAL' as const,claim:'Authorization bypass',proofRefs:['changed-hunk:src/security.ts:1']}]:[]};
  const signature=sign(null,attestedMessage({reviewId:review.reviewId,slotId:slot.slotId,...report}),keys.privateKey).toString('base64url');
  await native.submit(review.reviewId,slot.slotId,{...report,attestation:{keyId:'trusted',signature}});
 }
}
test('self-hosted RDD never approves before distinct review receipts exist',()=>setup(async({native,rdd})=>{
 const v=await input(native);const tx=await rdd.begin(v.begin);
 const p=await rdd.assess(tx.id);assert.equal(p.approved,false);assert.equal(p.record.state,'NEEDS_REVIEW_EVIDENCE');
 await assert.rejects(rdd.acknowledge(tx.id,p.record.revision),/Cannot acknowledge/);
}));
test('clean independent native reports + verified exact SHA Github checks approve and acknowledge',()=>setup(async({native,rdd,mesh,dir})=>{
 const v=await input(native);const tx=await rdd.begin(v.begin);
 await reportAll(native,v.review);
 const result=await rdd.assess(tx.id);assert.equal(result.approved,true);
 assert.equal(result.record.state,'APPROVED_PENDING_ACK');assert.equal(result.github?.state,'REVIEWABLE');
 assert.equal(result.assurance,'GITHUB_CHECKS_VERIFIED__RUNNER_SIGNED');
 const acknowledged=await rdd.acknowledge(tx.id,result.record.revision);
 assert.equal(acknowledged.state,'ACKNOWLEDGED');
 const again=await PanterRdd.open(dir,native,mesh,gate(),runnerKeys);
 assert.equal((await again.assess(tx.id)).record.state,'ACKNOWLEDGED');
}));
test('critical finding requires correction rather than model approval',()=>setup(async({native,rdd})=>{
 const v=await input(native);const tx=await rdd.begin(v.begin);
 await reportAll(native,v.review,true);
 const s=await rdd.assess(tx.id);assert.equal(s.record.state,'NEEDS_CORRECTION');assert.equal(s.approved,false);
}));
test('stale or failing CI stops review even with favorable model reports',()=>setup(async({native,rdd})=>{
 const v=await input(native);const tx=await rdd.begin(v.begin);await reportAll(native,v.review);
 const s=await rdd.assess(tx.id);assert.equal(s.record.state,'NEEDS_GITHUB_PROOF');assert.equal(s.approved,false);
 assert.match((s.github?.blockers??[]).join(' '),/non-success/);
},gate({ci:'failure'})));
test('review is invalidated if PR changes to another SHA before acknowledgement',()=>setup(async({native,rdd})=>{
 const v=await input(native);const tx=await rdd.begin(v.begin);await reportAll(native,v.review);
 const s=await rdd.assess(tx.id);assert.equal(s.record.state,'NEEDS_GITHUB_PROOF');
 assert.match((s.github?.blockers??[]).join(' '),/HEAD differs/);
},gate({head:newSha})));
test('wrong review identity / unallowed repository cannot bootstrap authority',()=>setup(async({native,rdd})=>{
 const v=await input(native);
 await assert.rejects(rdd.begin({...v.begin,candidateSha:newSha}),/Review identity/);
 await assert.rejects(rdd.begin({...v.begin,repository:'other/project'}),/allowlist/);
}));
test('registration idempotency and conflicting payloads fail closed',()=>setup(async({native,rdd})=>{
 const v=await input(native);const one=await rdd.begin(v.begin);
 assert.equal((await rdd.begin(v.begin)).id,one.id);
 await assert.rejects(rdd.begin({...v.begin,implementerRunId:'builder-2'}),/Conflicting review/);
}));
test('no GitHub PR proof means no positive RDD verdict from model alone',()=>setup(async({native,rdd})=>{
 const v=await input(native);const tx=await rdd.begin({...v.begin,repository:undefined,prNumber:undefined});await reportAll(native,v.review);
 const s=await rdd.assess(tx.id);assert.equal(s.record.state,'NEEDS_GITHUB_PROOF');
}));
test('corrected SHA needs a new review; old transaction becomes superseded',()=>setup(async({native,rdd})=>{
 const v=await input(native);const before=await rdd.begin(v.begin);
 const newReview=await input(native,newSha,'correction');const after=await rdd.begin({...newReview.begin,repository:undefined,prNumber:undefined});
 const old=await rdd.supersede(before.id,newReview.review.reviewId,before.revision);
 assert.equal(old.state,'SUPERSEDED');assert.equal(old.supersededBy,after.id);
 assert.equal((await rdd.assess(before.id)).approved,false);
 await assert.rejects(rdd.supersede(before.id,'wrong',old.revision),/new registered review/);
}));

test('automatic GPT-A-only harness drives native 4R into self-hosted RDD acknowledgement without selecting reviewers',()=>setup(async({native,mesh,rdd,dir})=>{
 const {AutomaticHarness}=await import('../src/core/auto-harness.js');
 const harness=await AutomaticHarness.open(dir,mesh,native,gate(),undefined,rdd);
 const run=await harness.start({project:'app',githubRepository:repo,githubPrNumber:12,
  objective:'Fix authentication security',idempotencyKey:'automatic-rdd',writesAuthorized:true,
  changeSurfaces:['src/auth.ts'],coordinationMode:'GPT_A_ONLY'});
 const capacity={nativeSubagents:true,maxParallelSubagents:4,toolsAvailable:true};
 let step=await harness.tick(run.id,capacity);
 assert.equal(step.status,'GPT_A_INLINE');
 await harness.report(run.id,step.phaseId!,{summary:'Designed fix',evidence:['S1 and acceptance tests']});
 step=await harness.tick(run.id,capacity);
 assert.equal(step.status,'GPT_A_INLINE');
 await harness.report(run.id,step.phaseId!,{summary:'Implemented patch',evidence:['Focused tests pass'],candidateSha:sha,runId:'builder-1'});
 step=await harness.tick(run.id,capacity);
 assert.equal(step.status,'GPT_A_NATIVE');
 await harness.report(run.id,step.phaseId!,{summary:'Independently verified frozen SHA',evidence:['Regression suite result'],candidateSha:sha,runId:'verifier-1'});
 step=await harness.tick(run.id,capacity);
 assert.equal(step.status,'READY_FOR_HOST_NATIVE_DISPATCH');
 const slots=await native.status(step.reviewId!);
 await reportAll(native,{reviewId:slots.reviewId,candidateSha:slots.candidateSha,slots:slots.slots} as Awaited<ReturnType<NativeSubagentReview['create']>>);
 const outcome=await harness.tick(run.id,capacity);
 assert.equal(outcome.status,'PANTER_RDD_REVIEWED_NO_DELIVERY_AUTHORITY');
 const current=await rdd.getForReview(step.reviewId!);
 assert.equal(current?.state,'ACKNOWLEDGED');
 assert.equal((await harness.get(run.id))?.steps.at(-1)?.status,'COMPLETE');
 assert.equal(outcome.approved,false); // no automatic merge/deploy privilege
}));

test('clean unsigned model reports never gain review authority despite passing GitHub CI',()=>setup(async({native,rdd})=>{
 const v=await input(native);const tx=await rdd.begin(v.begin);
 for(let i=0;i<v.review.slots.length;i++){
  const slot=v.review.slots[i]!;
  await native.submit(v.review.reviewId,slot.slotId,{agentId:slot.agentId,candidateSha:sha,packetDigest:slot.packetDigest,
    subagentRunId:`model-declared-${i}`,evidence:['Read candidate'],findings:[]});
 }
 const verdict=await rdd.assess(tx.id);
 assert.equal(verdict.approved,false);assert.equal(verdict.record.state,'NEEDS_RUNNER_ATTESTATION');
 await assert.rejects(rdd.acknowledge(tx.id,verdict.record.revision),/Cannot acknowledge/);
}));

test('explicit Judgment Day runs after approved 4R, as a separate blind additional audit',()=>setup(async({native,mesh,rdd,dir})=>{
 const {AutomaticHarness}=await import('../src/core/auto-harness.js');
 const h=await AutomaticHarness.open(dir,mesh,native,gate(),undefined,rdd);
 const run=await h.start({project:'app',githubRepository:repo,githubPrNumber:12,objective:'Fix critical security',idempotencyKey:'with-jd',
   writesAuthorized:true,changeSurfaces:['src/auth.ts'],coordinationMode:'GPT_A_ONLY',judgmentDayRequested:true});
 const capacity={nativeSubagents:true,maxParallelSubagents:4,toolsAvailable:true};
 let step=await h.tick(run.id,capacity);await h.report(run.id,step.phaseId!,{summary:'Designed',evidence:['Plan']});
 step=await h.tick(run.id,capacity);await h.report(run.id,step.phaseId!,{summary:'Implemented',evidence:['Tests'],candidateSha:sha,runId:'builder-1'});
 step=await h.tick(run.id,capacity);await h.report(run.id,step.phaseId!,{summary:'Verified independently',evidence:['Build'],candidateSha:sha,runId:'verifier-1'});
 step=await h.tick(run.id,capacity);await reportAll(native,{reviewId:step.reviewId!,candidateSha:sha,
   slots:(await native.status(step.reviewId!)).slots} as Awaited<ReturnType<NativeSubagentReview['create']>>);
 step=await h.tick(run.id,capacity);
 assert.equal(step.status,'READY_FOR_HOST_NATIVE_DISPATCH');
 assert.deepEqual(step.next.map(x=>x.agentId),['jd-judge-a','jd-judge-b']);
 assert.notEqual(step.reviewId,(await h.get(run.id))?.reviewId);
 const j=await native.status(step.reviewId!);await reportAll(native,{reviewId:j.reviewId,candidateSha:j.candidateSha,
   slots:j.slots} as Awaited<ReturnType<NativeSubagentReview['create']>>);
 const last=await h.tick(run.id,capacity);
 assert.equal(last.status,'PANTER_RDD_REVIEWED_NO_DELIVERY_AUTHORITY');
 assert.ok((await h.get(run.id))?.steps.every(x=>x.status==='COMPLETE'));
}));

test('signed review must cover exact report content, not just the declared run identity',()=>setup(async({native,rdd})=>{
 const v=await input(native);const tx=await rdd.begin(v.begin);
 for(let i=0;i<v.review.slots.length;i++){
  const slot=v.review.slots[i]!;
  const report={agentId:slot.agentId,candidateSha:sha,packetDigest:slot.packetDigest,
    subagentRunId:`signed-child-${i}`,evidence:['Observed valid state'],findings:[]};
  const signature=sign(null,attestedMessage({reviewId:v.review.reviewId,slotId:slot.slotId,...report}),keys.privateKey).toString('base64url');
  await native.submit(v.review.reviewId,slot.slotId,{...report,evidence:['Forged different evidence'],attestation:{keyId:'trusted',signature}});
 }
 const verdict=await rdd.assess(tx.id);
 assert.equal(verdict.record.state,'NEEDS_RUNNER_ATTESTATION');assert.equal(verdict.approved,false);
}));

test('RDD forwards operator-approved single-PR strategy for oversized bootstrap',()=>setup(async({native,rdd})=>{const v=await input(native);const tx=await rdd.begin({...v.begin,deliveryStrategy:'single-pr'});await reportAll(native,v.review);const x=await rdd.assess(tx.id);assert.equal(x.github?.state,'REVIEWABLE');assert.equal(x.approved,true);},gate({additions:750})));
