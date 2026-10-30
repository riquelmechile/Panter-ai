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
  assert.equal(chooseHarness({...base,judgmentDayRequested:true}).reviewKind,'judgment-day');
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
    'pulls/4':{state:'open',draft:true,head:{sha:prSha,ref:'feat/feature'},base:{ref:'main'},body:'Refs #7',labels:[{name:'type:feature'}],additions:120,deletions:20,commits:1},
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
