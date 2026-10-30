import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutomaticHarness, chooseHarness } from '../src/core/auto-harness.js';
import { GitHubDeliveryGate } from '../src/core/github-delivery.js';
import { MeshEngine } from '../src/core/mesh.js';
import { NativeSubagentReview } from '../src/core/native-review-workflow.js';
const sha='a'.repeat(40);
const runId='gpt-a-native-run-001';
const solo={nativeSubagents:true,maxParallelSubagents:8,toolsAvailable:true,peerStates:{claude:'CONNECTED' as const}};
async function withHarness<T>(fn:(h:AutomaticHarness,n:NativeSubagentReview,m:MeshEngine)=>Promise<T>){
  const dir=await mkdtemp(join(tmpdir(),'panter-auto-'));
  try{const m=await MeshEngine.open(dir),n=await NativeSubagentReview.open(dir),h=await AutomaticHarness.open(dir,m,n);
    return await fn(h,n,m);}finally{await rm(dir,{recursive:true,force:true});}
}

test('automatic route requires no agent IDs, risk lens names or skill selection',()=>{
  const small=chooseHarness({project:'app',objective:'Update button copy',idempotencyKey:'small',writesAuthorized:true,changeSurfaces:['src/ui/button.ts']});
  assert.deepEqual(small.phases,['IMPLEMENT']);assert.equal(small.risk,'LOW');
  const risky=chooseHarness({project:'app',objective:'Fix login security',idempotencyKey:'high',writesAuthorized:true,changeSurfaces:['src/auth.ts']});
  assert.deepEqual(risky.phases,['DESIGN','IMPLEMENT','VERIFY','REVIEW']);assert.equal(risky.reviewKind,'4r');
  const unknown=chooseHarness({project:'app',objective:'Fix unknown bug',idempotencyKey:'missing',writesAuthorized:true});
  assert.deepEqual(unknown.phases,['DISCOVER','DESIGN','IMPLEMENT','VERIFY','REVIEW']);
  assert.equal(chooseHarness({project:'app',objective:'Read docs',idempotencyKey:'read',writesAuthorized:false}).phases[0],'DISCOVER');
});

test('explicit Judgment Day selects blind judges, never automatically requested for ordinary work',()=>{
  const base={project:'app',objective:'Repair auth',writesAuthorized:true,changeSurfaces:['src/auth/login.ts'],idempotencyKey:'jd'};
  assert.equal(chooseHarness(base).reviewKind,'4r');
  const withJudgment=chooseHarness({...base,judgmentDayRequested:true});
  assert.equal(withJudgment.reviewKind,'4r');
  assert.deepEqual(withJudgment.phases.slice(-2),['REVIEW','JUDGMENT']);
});

test('solo ODD runs discover -> design -> implement -> independent verify -> four native reviewers with no manual agent choices',()=>withHarness(async(h,n,m)=>{
  const start=await h.start({project:'app',objective:'Fix token authentication',idempotencyKey:'task1',writesAuthorized:true,coordinationMode:'GPT_A_ONLY'});
  assert.equal(start.steps.length,5);assert.equal(start.mode,'GPT_A_ONLY');
  const discover=await h.tick(start.id,solo);assert.equal(discover.status,'GPT_A_NATIVE');
  assert.equal(discover.next[0]?.agentId,'gentle-ai-explore');
  let next=await h.report(start.id,discover.phaseId!,{summary:'Mapped source',evidence:['src/auth.ts:5'],discoveredPaths:['src/auth.ts']});
  let design=await h.tick(start.id,solo);assert.equal(design.status,'GPT_A_INLINE');assert.equal(design.next[0]?.agentId,null);
  await h.report(start.id,design.phaseId!,{summary:'Plan with test',evidence:['Plan S1']});
  const implement=await h.tick(start.id,solo);assert.equal(implement.status,'GPT_A_INLINE');
  assert.equal(implement.next[0]?.agentId,'gentle-ai-worker');
  await assert.rejects(h.report(start.id,implement.phaseId!,{summary:'Edited',evidence:['test passed']}),/frozen candidate SHA/);
  await h.report(start.id,implement.phaseId!,{summary:'Edited',evidence:['commit sha'],candidateSha:sha,runId:'gpt-a-parent'});
  const verify=await h.tick(start.id,solo);assert.equal(verify.status,'GPT_A_NATIVE');
  assert.equal(verify.next[0]?.agentId,'gentle-ai-verify');
  await assert.rejects(h.report(start.id,verify.phaseId!,{summary:'Verified',evidence:['focused checks'],candidateSha:sha,runId:'gpt-a-parent'}),/Independent verifier/);
  await h.report(start.id,verify.phaseId!,{summary:'Verified',evidence:['focused checks'],candidateSha:sha,runId});
  const review=await h.tick(start.id,solo);assert.equal(review.status,'READY_FOR_HOST_NATIVE_DISPATCH');
  assert.deepEqual(review.next.map((v:any)=>v.agentId),['review-risk','review-readability','review-reliability','review-resilience']);
  assert.equal(review.concurrentSlots,4);assert.equal(review.approved,false);
  const again=await h.tick(start.id,solo);assert.equal(again.reviewId,review.reviewId);
  const final=await h.get(start.id);assert.equal(final!.steps.find(s=>s.phase==='REVIEW')?.status,'PENDING');
}));

test('no host native subagents reports genuine limit instead of approving high-risk review',()=>withHarness(async(h)=>{
  const s=await h.start({project:'app',objective:'Repair authentication',idempotencyKey:'x',writesAuthorized:true,changeSurfaces:['src/auth.ts'],coordinationMode:'GPT_A_ONLY'});
  let x=await h.tick(s.id,{nativeSubagents:false,maxParallelSubagents:0,toolsAvailable:true});
  assert.equal(x.status,'GPT_A_INLINE');
  await h.report(s.id,x.phaseId!,{summary:'Planned',evidence:['design doc']});
  x=await h.tick(s.id,{nativeSubagents:false,maxParallelSubagents:0,toolsAvailable:true});
  await h.report(s.id,x.phaseId!,{summary:'Fixed',evidence:['git commit'],candidateSha:sha});
  x=await h.tick(s.id,{nativeSubagents:false,maxParallelSubagents:0,toolsAvailable:true});
  assert.equal(x.status,'GPT_A_INLINE'); // cannot claim independent evidence from GPT-A alone
  await assert.rejects(h.report(s.id,x.phaseId!,{summary:'self reviewed',evidence:['read diff'],candidateSha:sha}),/Independent verifier/);
}));

test('unknown edit surfaces halt writer, instead of granting unscoped permissions',()=>withHarness(async(h)=>{
  const s=await h.start({project:'app',objective:'Fix bug',idempotencyKey:'x',writesAuthorized:true});
  let t=await h.tick(s.id,solo);await h.report(s.id,t.phaseId!,{summary:'Located no exact file yet',evidence:['grep results']});
  t=await h.tick(s.id,solo);await h.report(s.id,t.phaseId!,{summary:'Plan',evidence:['requirements']});
  t=await h.tick(s.id,solo);assert.equal(t.status,'BLOCKED_EDIT_SCOPE_OR_AUTHORIZATION');
}));

test('read-only goal never schedules implementation or automatic review',()=>withHarness(async(h)=>{
  const s=await h.start({project:'docs',objective:'Explain architecture',idempotencyKey:'ro',writesAuthorized:false,coordinationMode:'GPT_A_ONLY'});
  const t=await h.tick(s.id,solo);assert.equal(t.next[0]?.agentId,'gentle-ai-explore');
  await h.report(s.id,t.phaseId!,{summary:'Explained',evidence:['source:1']});
  const end=await h.tick(s.id,solo);assert.equal(end.status,'REPORTED_COMPLETE_UNVERIFIED');assert.deepEqual(end.next,[]);
}));

test('start idempotency and report immutability survive restart',()=>withHarness(async(h,n,m)=>{
  const inp={project:'app',objective:'Change label',idempotencyKey:'same',writesAuthorized:true,changeSurfaces:['src/label.ts']};
  const a=await h.start(inp),b=await h.start(inp);assert.equal(a.id,b.id);
  const t=await h.tick(a.id,solo);assert.equal(t.status,'GPT_A_INLINE');
  const report={summary:'Done',evidence:['tests run']};
  await h.report(a.id,t.phaseId!,report);
  const repeat=await h.report(a.id,t.phaseId!,report);assert.equal(repeat.steps[0]?.status,'COMPLETE');
  await assert.rejects(h.report(a.id,t.phaseId!,{summary:'Changed result',evidence:['different']}),/Conflicting immutable/);
}));

test('rejects unsafe paths and fabricated success without actual issued packet',()=>withHarness(async(h)=>{
  await assert.rejects(h.start({project:'a',objective:'Change',idempotencyKey:'e',writesAuthorized:true,changeSurfaces:['../src']}),/Unsafe/);
  const s=await h.start({project:'app',objective:'Change safe',idempotencyKey:'safe',writesAuthorized:true,changeSurfaces:['src/file.ts']});
  await assert.rejects(h.report(s.id,s.steps[0]!.id,{summary:'done',evidence:['fake']}),/must be issued/);
  const t=await h.tick(s.id,{nativeSubagents:false,maxParallelSubagents:0,toolsAvailable:false});
  assert.equal(t.status,'BLOCKED_HOST_TOOLS');
}));

test('AUTO mode dispatches configured specialist without choosing an agent, then advances from remote A2A receipt',()=>withHarness(async(h,n,m)=>{
  await m.setProfile('gpt-a',{host:'claude',actorId:'actor-claude',modelRequest:'host-default',effortRequest:'max',roles:['explorer']},0);
  await m.bindSpecialist('gpt-a',{agentId:'gentle-ai-explore',host:'claude',modelRequest:'host-default',effortRequest:'max',skillIds:['gentle-ai']},0);
  const s=await h.start({project:'app',objective:'Repair unknown issue',idempotencyKey:'remote',writesAuthorized:true});
  const first=await h.tick(s.id,solo);
  assert.equal(first.status,'REMOTE_A2A_DISPATCHED');
  assert.equal(first.next[0]?.agentId,'gentle-ai-explore');
  const workId=first.next[0]?.workId;
  assert.ok(typeof workId==='string');
  const again=await h.tick(s.id,solo);assert.equal(again.status,'WAITING_REMOTE_PEER');
  const claimed=await m.claim('claude',workId);
  await m.complete('claude',workId,claimed.attemptId!,claimed.leaseGeneration,
    JSON.stringify({summary:'Located relevant code',evidence:['src/feature.ts:1'],discoveredPaths:['src/feature.ts'],runId:'claude-run-001'}));
  const next=await h.tick(s.id,solo);
  assert.equal(next.status,'GPT_A_INLINE'); // planning is automatic parent responsibility
  assert.equal(next.next[0]?.phase,'DESIGN');
  assert.equal((await h.get(s.id))?.steps[0]?.status,'COMPLETE');
}));

test('switching an existing AUTO mission to GPT_A_ONLY prevents new remote dispatches',()=>withHarness(async(h,n,m)=>{
  await m.setProfile('gpt-a',{host:'claude',actorId:'actor-claude',modelRequest:'host-default',effortRequest:'max',roles:['explorer']},0);
  await m.bindSpecialist('gpt-a',{agentId:'gentle-ai-explore',host:'claude',modelRequest:'host-default',effortRequest:'max',skillIds:['gentle-ai']},0);
  const s=await h.start({project:'app',objective:'Repair unknown issue',idempotencyKey:'switch',writesAuthorized:true});
  await m.setCoordinationMode('gpt-a','GPT_A_ONLY',0);
  const t=await h.tick(s.id,solo);
  assert.equal(t.mode,'GPT_A_ONLY');assert.equal(t.status,'GPT_A_NATIVE');
  assert.equal(t.next[0]?.agentId,'gentle-ai-explore');
}));

test('GitHub project requires exact 40-character candidate before any delivery check',()=>withHarness(async(h)=>{
  const r=await h.start({project:'my-project',githubRepository:'example/project',objective:'Change a label',idempotencyKey:'gh',writesAuthorized:true,changeSurfaces:['src/label.ts']});
  const x=await h.tick(r.id,solo);
  assert.equal(x.status,'GPT_A_INLINE');
  await assert.rejects(h.report(r.id,x.phaseId!,{summary:'changed',evidence:['tests executed']}),/GitHub\/high-risk/);
  await h.report(r.id,x.phaseId!,{summary:'changed',evidence:['tests executed'],candidateSha:sha});
  const next=await h.tick(r.id,solo);
  assert.equal(next.status,'AWAITING_GITHUB_PR_EVIDENCE');
  const persisted=await h.get(r.id);assert.equal(persisted?.githubRepository,'example/project');
}));


test('automatic final tick checks target GitHub PR evidence without manual agent or skill selection',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'panter-github-harness-'));
  const prSha='a'.repeat(40);
  const resources:Record<string,unknown>={
    '':{default_branch:'main'},
    'pulls/4':{state:'open',draft:false,head:{sha:prSha,ref:'feat/feature'},base:{ref:'main'},body:'Refs #7',labels:[{name:'type:feature'}],additions:120,deletions:20,commits:1},
    'issues/7':{labels:[{name:'status:approved'}]},
    'pulls/4/commits?per_page=100':[{sha:prSha,commit:{message:'feat: change label'}}],
    [`commits/${prSha}/check-runs?per_page=100`]:{total_count:1,check_runs:[{name:'ci',status:'completed',conclusion:'success',head_sha:prSha}]}
  };
  const fetcher=(async(url:string|URL|Request)=>{
    const part=String(url).split('/repos/example/project/')[1]??'';
    const data=resources[part];return {ok:data!==undefined,status:data!==undefined?200:404,text:async()=>JSON.stringify(data)} as Response;
  }) as typeof fetch;
  try{
    const mesh=await MeshEngine.open(dir),native=await NativeSubagentReview.open(dir);
    const gate=new GitHubDeliveryGate({allowedRepositories:['example/project'],requiredChecks:['ci']},fetcher);
    const harness=await AutomaticHarness.open(dir,mesh,native,gate);
    const run=await harness.start({project:'website',githubRepository:'example/project',githubPrNumber:4,githubExpectedBase:'main',objective:'Change label',idempotencyKey:'gh-auto',writesAuthorized:true,changeSurfaces:['src/label.ts']});
    const tick=await harness.tick(run.id,solo);
    await harness.report(run.id,tick.phaseId!,{summary:'Changed and tested',evidence:['tests passed'],candidateSha:prSha});
    const result=await harness.tick(run.id,solo);
    assert.equal(result.status,'GITHUB_EVIDENCE_READY_NO_DELIVERY_AUTHORITY');
    assert.equal((result.github as {state:string}).state,'REVIEWABLE');
    assert.equal(result.approved,false);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('can bind a later observed PR to an existing GitHub run without changing repository or restart',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'panter-github-later-'));
 const mock=(async()=>({ok:false,status:404,text:async()=>'{}'} as Response)) as typeof fetch;
 try{
  const m=await MeshEngine.open(dir),n=await NativeSubagentReview.open(dir);
  const g=new GitHubDeliveryGate({allowedRepositories:['example/project'],requiredChecks:['ci']},mock);
  const h=await AutomaticHarness.open(dir,m,n,g);
  const run=await h.start({project:'website',githubRepository:'example/project',objective:'Fix copy',idempotencyKey:'before-pr',writesAuthorized:true,changeSurfaces:['src/copy.ts']});
  const task=await h.tick(run.id,solo);
  const finished=await h.report(run.id,task.phaseId!,{summary:'Edited and tested',evidence:['test output'],candidateSha:sha});
  assert.equal((await h.tick(run.id,solo)).status,'AWAITING_GITHUB_PR_EVIDENCE');
  const bound=await h.bindGithub(run.id,{repository:'example/project',prNumber:123,expectedBase:'main'},finished.revision);
  assert.equal(bound.githubPrNumber,123);
  const retry=await h.bindGithub(run.id,{repository:'example/project',prNumber:123,expectedBase:'main'},finished.revision);
  assert.equal(retry.revision,bound.revision);
  await assert.rejects(h.bindGithub(run.id,{repository:'other/project',prNumber:123},bound.revision),/destination not allowed/);
  await assert.rejects(h.bindGithub(run.id,{repository:'example/project',prNumber:124},bound.revision),/binding conflict/);
  const next=await h.tick(run.id,solo);
  assert.equal(next.status,'GITHUB_GATE_BLOCKED');assert.equal((next.github as {state:string}).state,'PENDING');
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('operator write grant is required on production harness and cannot be reused',()=>withHarness(async (_h,n,m)=>{
 const {mkdtemp,rm}=await import('node:fs/promises');const {join}=await import('node:path');const {tmpdir}=await import('node:os');
 const dir=await mkdtemp(join(tmpdir(),'panter-grant-'));
 try{
  const secure=await AutomaticHarness.open(dir,m,n,undefined,undefined,undefined,true);
  const input={project:'example',objective:'Fix login',idempotencyKey:'one',writesAuthorized:true,changeSurfaces:['src/auth/login.ts']};
  await assert.rejects(secure.start(input),/Operator write grant required/);
  const granted=await secure.grantWrite({project:'example',objective:'Fix login',allowedPaths:['src/auth'],ttlSeconds:3600});
  const run=await secure.start({...input,writeGrantId:granted.grantId});
  assert.equal(run.permission,'WRITE_APPROVED');
  await assert.rejects(secure.start({...input,idempotencyKey:'two',writeGrantId:granted.grantId}),/consumed/);
  const second=await secure.grantWrite({project:'example',objective:'Fix login',allowedPaths:['src/auth'],ttlSeconds:3600});
  await assert.rejects(secure.start({...input,idempotencyKey:'two',changeSurfaces:['src/payments'],writeGrantId:second.grantId}),/exceeds operator grant/);
  const wrong=await secure.grantWrite({project:'example',objective:'Different',allowedPaths:['src/auth'],ttlSeconds:3600});
  await assert.rejects(secure.start({...input,idempotencyKey:'three',writeGrantId:wrong.grantId}),/Missing, expired/);
 }finally{await rm(dir,{recursive:true,force:true});}
}));

test('parallel implementation needs a complete design and strictly disjoint scoped native workers',()=>withHarness(async (h)=>{
 const run=await h.start({project:'app',objective:'Refactor independent services',idempotencyKey:'parallel',writesAuthorized:true,
   changeSurfaces:['src/service-a','src/service-b'],observations:{independentWorkUnits:2}});
 const design=await h.tick(run.id,solo);assert.equal(design.status,'GPT_A_INLINE');
 await assert.rejects(h.defineUnits(run.id,[{objective:'A',paths:['src/service-a']},{objective:'B',paths:['src/service-b']}],(await h.get(run.id))!.revision),/Design phase/);
 await h.report(run.id,design.phaseId!,{summary:'Mapped both services',evidence:['Design spec S1, S2']});
 const r=await h.get(run.id);assert.ok(r);
 await assert.rejects(h.defineUnits(run.id,[{objective:'A',paths:['src/service-a']},{objective:'Duplicate',paths:['src/service-a/file.ts']}],r.revision),/overlap/);
 await assert.rejects(h.defineUnits(run.id,[{objective:'A',paths:['src/service-a']},{objective:'Out of scope',paths:['src/payment']}],r.revision),/exceeds authorized/);
 const stored=await h.defineUnits(run.id,[{objective:'Implement A',paths:['src/service-a']},{objective:'Implement B',paths:['src/service-b']}],r.revision);
 assert.equal(stored.units?.length,2);
 const batch=await h.tick(run.id,solo);
 assert.equal(batch.status,'GPT_A_NATIVE_IMPLEMENTATION_BATCH');assert.equal(batch.concurrentSlots,2);assert.equal(batch.next.length,2);
 await assert.rejects(h.report(run.id,batch.phaseId!,{summary:'Integrated',evidence:['test'],candidateSha:sha}),/All isolated implementation units/);
 for(let i=0;i<2;i++)await h.reportUnit(run.id,stored.units![i]!.id,{runId:`unit-child-${i}`,summary:`Unit ${i} done`,evidence:['Unit tests pass']});
 const integration=await h.tick(run.id,solo);assert.equal(integration.status,'IMPLEMENTATION_INTEGRATION_REQUIRED');
 await h.report(run.id,batch.phaseId!,{summary:'Integrated both scoped units',evidence:['Integration tests pass'],candidateSha:sha,runId:'gpt-a-parent'});
 const after=await h.tick(run.id,solo);assert.ok(['GPT_A_NATIVE','READY_FOR_HOST_NATIVE_DISPATCH','REPORTED_COMPLETE_UNVERIFIED'].includes(after.status));
}));

test('delivery strategy is an immutable operator decision reused by the automatic harness',()=>withHarness(async(h)=>{
 const run=await h.start({project:'project',objective:'Add feature',idempotencyKey:'delivery',writesAuthorized:true,changeSurfaces:['src/feature']});
 const saved=await h.setDeliveryStrategy(run.id,'feature-branch-chain',run.revision);
 assert.equal(saved.deliveryStrategy,'feature-branch-chain');
 await assert.rejects(h.setDeliveryStrategy(run.id,'single-pr',saved.revision),/already frozen/);
}));

test('bounded correction requires a new SHA and resets independent verification plus 4R',()=>withHarness(async(h)=>{
 const run=await h.start({project:'app',objective:'Fix sensitive login',idempotencyKey:'correction',writesAuthorized:true,changeSurfaces:['src/auth.ts']});
 let t=await h.tick(run.id,solo);await h.report(run.id,t.phaseId!,{summary:'Design',evidence:['Plan']});
 t=await h.tick(run.id,solo);await h.report(run.id,t.phaseId!,{summary:'Original change',evidence:['Unit tests'],candidateSha:sha,runId:'builder-1'});
 t=await h.tick(run.id,solo);await h.report(run.id,t.phaseId!,{summary:'Verification',evidence:['test pass'],candidateSha:sha,runId:'verifier-1'});
 t=await h.tick(run.id,solo);assert.equal(t.status,'READY_FOR_HOST_NATIVE_DISPATCH');
 const old=await h.get(run.id);assert.equal(old?.reviewId,t.reviewId);
 const corrected=await h.recordCorrection(run.id,{candidateSha:'b'.repeat(40),runId:'corrector-1',evidence:['Test suite rerun']},old!.revision);
 assert.equal(corrected.correctionAttempts,1);assert.equal(corrected.previousReviewId,t.reviewId);
 assert.equal(corrected.steps.find(s=>s.phase==='VERIFY')?.status,'PENDING');
 t=await h.tick(run.id,solo);assert.equal(t.status,'GPT_A_NATIVE');
 await assert.rejects(h.report(run.id,t.phaseId!,{summary:'Self check',evidence:['test'],candidateSha:'b'.repeat(40),runId:'corrector-1'}),/Independent verifier/);
 await h.report(run.id,t.phaseId!,{summary:'New independent check',evidence:['tests run'],candidateSha:'b'.repeat(40),runId:'verifier-2'});
 t=await h.tick(run.id,solo);assert.notEqual(t.reviewId,old?.reviewId);
 await assert.rejects(h.recordCorrection(run.id,{candidateSha:'b'.repeat(40),runId:'corrector-2',evidence:['bad']},(await h.get(run.id))!.revision),/fresh SHA/);
}));

test('changing Judgment Day intent invalidates start idempotency',()=>withHarness(async h=>{const i={project:'app',objective:'Change copy',idempotencyKey:'jd-digest',writesAuthorized:true,changeSurfaces:['src/copy.ts']};await h.start(i);await assert.rejects(h.start({...i,judgmentDayRequested:true}),/idempotency conflict/); }));

test('issued local discovery cannot spawn a remote duplicate after peer reconnect',()=>withHarness(async(h,n,m)=>{
 await m.setProfile('gpt-a',{host:'claude',actorId:'actor-claude',modelRequest:'host-default',effortRequest:'max',roles:['explorer']},0);
 await m.bindSpecialist('gpt-a',{agentId:'gentle-ai-explore',host:'claude',modelRequest:'host-default',effortRequest:'max',skillIds:['gentle-ai']},0);
 const run=await h.start({project:'app',objective:'Find unknown bug',idempotencyKey:'restore',writesAuthorized:true});
 const first=await h.tick(run.id,{...solo,peerStates:{claude:'UNAVAILABLE'}});
 assert.equal(first.status,'GPT_A_NATIVE');
 const retry=await h.tick(run.id,{...solo,peerStates:{claude:'CONNECTED'}});
 assert.equal(retry.status,'WAITING_HOST_PHASE_REPORT');
 assert.equal((await m.pending('claude')).length,0);
}));

test('6000-character accepted objective produces a bounded executable packet',()=>withHarness(async h=>{const run=await h.start({project:'app',objective:'x'.repeat(6000),idempotencyKey:'long',writesAuthorized:true,changeSurfaces:['src/value.ts']});const tick=await h.tick(run.id,solo);assert.equal(tick.status,'GPT_A_INLINE');assert.equal((await h.get(run.id))?.objective.length,6000);}));

test('expired operator grant blocks local implementation packets without launching a writer',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'panter-expired-'));
 const savedNow=Date.now;
 try{
  const mesh=await MeshEngine.open(dir),native=await NativeSubagentReview.open(dir);
  const secure=await AutomaticHarness.open(dir,mesh,native,undefined,undefined,undefined,true);
  const objective='Update copy safely';
  const grant=await secure.grantWrite({project:'app',objective,allowedPaths:['src/copy.ts'],ttlSeconds:60});
  const run=await secure.start({project:'app',objective,idempotencyKey:'expires',writesAuthorized:true,writeGrantId:grant.grantId,changeSurfaces:['src/copy.ts']});
  Date.now=()=>grant.expiresAt+1;
  const blocked=await secure.tick(run.id,solo);
  assert.equal(blocked.status,'BLOCKED_WRITE_GRANT_EXPIRED');
  assert.equal(blocked.next.length,0);
  assert.equal((await secure.get(run.id))?.steps[0]?.status,'PENDING');
 }finally{Date.now=savedNow;await rm(dir,{recursive:true,force:true});}
});
test('expired grant also blocks implementation-unit creation and later corrective writes',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'panter-grant-phases-'));
 const savedNow=Date.now;
 try{
  const mesh=await MeshEngine.open(dir),native=await NativeSubagentReview.open(dir);
  const secure=await AutomaticHarness.open(dir,mesh,native,undefined,undefined,undefined,true);
  const objective='Repair authentication safely';
  const grant=await secure.grantWrite({project:'app',objective,allowedPaths:['src/auth'],ttlSeconds:60});
  const run=await secure.start({project:'app',objective,idempotencyKey:'phase-expiry',writesAuthorized:true,writeGrantId:grant.grantId,
    changeSurfaces:['src/auth/a.ts','src/auth/b.ts'],observations:{independentWorkUnits:2}});
  let phase=await secure.tick(run.id,solo);
  assert.equal(phase.status,'GPT_A_INLINE');
  await secure.report(run.id,phase.phaseId!,{summary:'Design complete',evidence:['Scoped implementation plan']});
  const current=await secure.get(run.id);assert.ok(current);
  Date.now=()=>grant.expiresAt+1;
  await assert.rejects(secure.defineUnits(run.id,[{objective:'A',paths:['src/auth/a.ts']},{objective:'B',paths:['src/auth/b.ts']}],current.revision),/Active operator grant/);
  assert.equal((await secure.tick(run.id,solo)).status,'BLOCKED_WRITE_GRANT_EXPIRED');
 }finally{Date.now=savedNow;await rm(dir,{recursive:true,force:true});}
});

test('expired operator grant rejects a fresh-SHA correction without changing the candidate',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'panter-expired-correction-'));
 const originalNow=Date.now;
 try{
  const mesh=await MeshEngine.open(dir),native=await NativeSubagentReview.open(dir);
  const secure=await AutomaticHarness.open(dir,mesh,native,undefined,undefined,undefined,true);
  const objective='Repair token authentication';
  const grant=await secure.grantWrite({project:'app',objective,allowedPaths:['src/auth'],ttlSeconds:60});
  const run=await secure.start({project:'app',objective,idempotencyKey:'correct-expired',writesAuthorized:true,
    writeGrantId:grant.grantId,changeSurfaces:['src/auth/login.ts']});
  let step=await secure.tick(run.id,solo);
  await secure.report(run.id,step.phaseId!,{summary:'Designed',evidence:['Design checks']});
  step=await secure.tick(run.id,solo);
  await secure.report(run.id,step.phaseId!,{summary:'Implemented',evidence:['Git commit'],candidateSha:sha,runId:'builder-run-1'});
  step=await secure.tick(run.id,solo);
  await secure.report(run.id,step.phaseId!,{summary:'Verified',evidence:['Independent tests'],candidateSha:sha,runId:'verifier-run-1'});
  await secure.tick(run.id,solo);
  const before=await secure.get(run.id);assert.ok(before);
  Date.now=()=>grant.expiresAt+1;
  await assert.rejects(secure.recordCorrection(run.id,{candidateSha:'b'.repeat(40),runId:'corrector-run-1',evidence:['Fix tested']},before.revision),/Active operator grant/);
  const after=await secure.get(run.id);
  assert.equal(after?.candidateSha,sha);
  assert.equal(after?.correctionAttempts,0);
 }finally{Date.now=originalNow;await rm(dir,{recursive:true,force:true});}
});
