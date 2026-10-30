import assert from 'node:assert/strict';
import {test} from 'node:test';
import {GitHubDeliveryGate, inspectBranchName, inspectCommitMessage} from '../src/core/github-delivery.js';
const sha='a'.repeat(40), other='b'.repeat(40);
const base={repository:'example/project',prNumber:12,expectedSha:sha};
const project={default_branch:'main'};
const pr={state:'open',draft:true,head:{sha,ref:'feat/new-login',repo:{full_name:'example/project'}},base:{ref:'main'},body:'Refs #22',labels:[{name:'type:feature'}],additions:120,deletions:20,commits:1};
const issue={labels:[{name:'status:approved'}]};
const checks={total_count:1,check_runs:[{name:'test',status:'completed',conclusion:'success',head_sha:sha}]};
function mock(records:Record<string,unknown>):typeof fetch {
  return (async (url:string|URL|Request)=>{
    const suffix=String(url).split('/repos/example/project/')[1]??'';
    const response=records[suffix];
    return {ok:response!==undefined,status:response===undefined?404:200,text:async()=>JSON.stringify(response)} as Response;
  }) as typeof fetch;
}
function gate(overrides:Record<string,unknown>={}){
  const all={'':project,'pulls/12':pr,'issues/22':issue,'pulls/12/commits?per_page=100':[{sha,commit:{message:'feat: implement login'}}], [`commits/${sha}/check-runs?per_page=100`]:checks,...overrides};
  return new GitHubDeliveryGate({allowedRepositories:['example/project'],requiredChecks:['test']},mock(all));
}
test('matches Gentle Shell branch and Conventional Commit formats',()=>{
  assert.equal(inspectBranchName('feat/alpha-v2'),true);
  assert.equal(inspectBranchName('main'),false);
  assert.equal(inspectBranchName('Feat/new'),false);
  assert.equal(inspectCommitMessage('feat(review): add review tests'),true);
  assert.equal(inspectCommitMessage('Update everything'),false);
});
test('verifies exact PR SHA, approved issue, single type label and completed CI',async()=>{
  const r=await gate().inspect(base);
  assert.equal(r.state,'REVIEWABLE');assert.deepEqual(r.blockers,[]);
  assert.equal(r.headSha,sha);assert.equal(r.reviewLoad,140);
  assert.equal(r.approvals.merge,false);
});
test('rejects outdated SHA and cannot rely on CI from another commit',async()=>{
  const r=await gate({'pulls/12':{...pr,head:{...pr.head,sha:other}}}).inspect(base);
  assert.equal(r.state,'BLOCKED');assert.match(r.blockers.join(' '),/SHA/);
});
test('requires approved issue and exactly one type label',async()=>{
  const r=await gate({'issues/22':{labels:[]},'pulls/12':{...pr,labels:[{name:'type:feature'},{name:'type:bug'}]}}).inspect(base);
  assert.match(r.blockers.join(' '),/type:\*/);assert.match(r.blockers.join(' '),/status:approved/);
});
test('rejects pending or unsuccessful checks instead of inferring green from PR',async()=>{
  const r=await gate({[`commits/${sha}/check-runs?per_page=100`]:{total_count:1,check_runs:[{...checks.check_runs[0],status:'in_progress',conclusion:null}]}}).inspect(base);
  assert.match(r.blockers.join(' '),/pending/);
});
test('oversized PR needs conscious delivery strategy, not code truncation',async()=>{
  const g=gate({'pulls/12':{...pr,additions:410,deletions:20}});
  const a=await g.inspect(base);assert.equal(a.state,'BLOCKED');assert.match(a.blockers.join(' '),/strategy/);
  const b=await g.inspect({...base,deliveryStrategy:'single-pr',parentAuthorizedSinglePr:true});
  assert.equal(b.state,'REVIEWABLE');assert.equal(b.reviewLoad,430);assert.match(b.warnings.join(' '),/advisory/);
});
test('allowlist and GitHub-only API prevent arbitrary URL/fork routing',async()=>{
  await assert.rejects(gate().inspect({...base,repository:'other/project'}),/allowlist/);
  await assert.rejects(gate().inspect({...base,repository:'example/project?redirect='}),/allowlist/);
});
test('network or GitHub permission errors always fail closed',async()=>{
  const r=await gate({'issues/22':undefined}).inspect(base);
  assert.equal(r.state,'PENDING');assert.equal(r.approvals.merge,false);
});
test('no declared required checks means unknown, not reviewable',async()=>{
  const g=new GitHubDeliveryGate({allowedRepositories:['example/project'],requiredChecks:[]},mock({'':project,'pulls/12':pr,'issues/22':issue,'pulls/12/commits?per_page=100':[{sha,commit:{message:'feat: implement login'}}]}));
  assert.match((await g.inspect(base)).blockers.join(' '),/not configured/);
});


test('rejects non-conventional commits and non-consented Co-Authored-By trailers',async()=>{
  const x=await gate({'pulls/12/commits?per_page=100':[{sha,commit:{message:'Quick change\n\nCo-Authored-By: Other <other@example.com>'}}]}).inspect(base);
  assert.equal(x.state,'BLOCKED');
  assert.match(x.blockers.join(' '),/Conventional Commits/);
  assert.match(x.blockers.join(' '),/Co-Authored-By/);
});


test('multiple successful check-runs of the same job do not falsely fail verification',async()=>{
  const identical={name:'test',status:'completed',conclusion:'success',head_sha:sha};
  const result=await gate({[`commits/${sha}/check-runs?per_page=100`]:{total_count:2,check_runs:[identical,{...identical}]}}).inspect(base);
  assert.equal(result.state,'REVIEWABLE');
});


test('cross-repository issue mention cannot impersonate an approved target issue',async()=>{
  const r=await gate({'pulls/12':{...pr,body:'Closes unrelated/repository#22'}}).inspect(base);
  assert.equal(r.state,'BLOCKED');assert.match(r.blockers.join(' '),/approved issue/);
});
