import assert from 'node:assert/strict';
import {test} from 'node:test';
import {GitHubDeliveryGate} from '../src/core/github-delivery.js';

const sha='a'.repeat(40), old='c'.repeat(40);
const base={repository:'example/project',prNumber:12,expectedSha:sha};
const pr={state:'open',draft:false,user:{login:'owner-dev'},head:{sha,ref:'feat/new-login',repo:{full_name:'example/project'}},
  base:{ref:'main'},body:'Refs #22',labels:[{name:'type:feature'}],additions:120,deletions:20,commits:1};
const commit={sha,author:{login:'owner-dev'},committer:{login:'web-flow'},commit:{message:'feat: implement login'}};
const reviewer='panter-reviewer';
const review=(state:string,commitId=sha,login=reviewer,id=1)=>({id,state,commit_id:commitId,user:{login}});

function gate(overrides:Record<string,unknown>={},independentReviewer:string|null=reviewer){
  const records:Record<string,unknown>={'':{default_branch:'main'},'pulls/12':pr,'issues/22':{labels:[{name:'status:approved'}]},
    'pulls/12/commits?per_page=100':[commit],
    [`commits/${sha}/check-runs?per_page=100`]:{total_count:1,check_runs:[{name:'test',status:'completed',conclusion:'success',head_sha:sha}]},
    'pulls/12/reviews?per_page=100':[review('APPROVED')],...overrides};
  const fetcher=(async(url:string|URL|Request)=>{
    const payload=records[String(url).split('/repos/example/project/')[1]??''];
    return {ok:payload!==undefined,status:payload===undefined?404:200,text:async()=>JSON.stringify(payload)} as Response;
  }) as typeof fetch;
  return new GitHubDeliveryGate({allowedRepositories:['example/project'],requiredChecks:['test'],independentReviewer:independentReviewer??undefined},fetcher);
}

test('configured reviewer APPROVE on the exact head SHA satisfies the independent-review gate',async()=>{
  const r=await gate().inspect(base);
  assert.equal(r.state,'REVIEWABLE');
  assert.deepEqual(r.independentReview,{login:reviewer,state:'APPROVED_EXACT_SHA',reviewId:1,commitId:sha});
  assert.ok(r.satisfied.includes(`independent_review:${reviewer}`));
  assert.equal(r.approvals.review,false,'Panter never converts GitHub evidence into its own approval');
  assert.equal(r.approvals.merge,false);
});

test('missing approval, or approval by any other account, blocks',async()=>{
  const none=await gate({'pulls/12/reviews?per_page=100':[]}).inspect(base);
  assert.equal(none.state,'BLOCKED');assert.equal(none.independentReview?.state,'MISSING');
  const other=await gate({'pulls/12/reviews?per_page=100':[review('APPROVED',sha,'someone-else')]}).inspect(base);
  assert.equal(other.state,'BLOCKED');assert.match(other.blockers.join(' '),/has not approved/);
});

test('an approval of an earlier commit is stale after a new push',async()=>{
  const r=await gate({'pulls/12/reviews?per_page=100':[review('APPROVED',old)]}).inspect(base);
  assert.equal(r.state,'BLOCKED');assert.equal(r.independentReview?.state,'STALE_SHA');
  assert.match(r.blockers.join(' '),/different commit/);
});

test('the latest state-changing review wins; comments never revoke or grant approval',async()=>{
  const changes=await gate({'pulls/12/reviews?per_page=100':[review('APPROVED',sha,reviewer,1),review('CHANGES_REQUESTED',sha,reviewer,2)]}).inspect(base);
  assert.equal(changes.independentReview?.state,'CHANGES_REQUESTED');assert.equal(changes.state,'BLOCKED');
  const reapproved=await gate({'pulls/12/reviews?per_page=100':[review('CHANGES_REQUESTED',sha,reviewer,1),review('APPROVED',sha,reviewer,2),review('COMMENTED',sha,reviewer,3)]}).inspect(base);
  assert.equal(reapproved.independentReview?.state,'APPROVED_EXACT_SHA');assert.equal(reapproved.independentReview?.reviewId,2);
  const dismissed=await gate({'pulls/12/reviews?per_page=100':[review('APPROVED',sha,reviewer,1),review('DISMISSED',sha,reviewer,2)]}).inspect(base);
  assert.equal(dismissed.independentReview?.state,'DISMISSED');
  const onlyComment=await gate({'pulls/12/reviews?per_page=100':[review('COMMENTED')]}).inspect(base);
  assert.equal(onlyComment.independentReview?.state,'MISSING');
});

test('login matching is case-insensitive but identity must be exact',async()=>{
  const r=await gate({'pulls/12/reviews?per_page=100':[review('APPROVED',sha,'Panter-Reviewer')]}).inspect(base);
  assert.equal(r.independentReview?.state,'APPROVED_EXACT_SHA');
  const lookalike=await gate({'pulls/12/reviews?per_page=100':[review('APPROVED',sha,'panter-reviewer-2')]}).inspect(base);
  assert.equal(lookalike.independentReview?.state,'MISSING');
});

test('the reviewer cannot be the PR author or author/committer of any commit',async()=>{
  const prAuthor=await gate({'pulls/12':{...pr,user:{login:reviewer}}}).inspect(base);
  assert.equal(prAuthor.independentReview?.state,'REVIEWER_IS_AUTHOR');assert.equal(prAuthor.state,'BLOCKED');
  const commitAuthor=await gate({'pulls/12/commits?per_page=100':[{...commit,author:{login:'PANTER-REVIEWER'}}]}).inspect(base);
  assert.equal(commitAuthor.independentReview?.state,'REVIEWER_IS_AUTHOR');
  const committer=await gate({'pulls/12/commits?per_page=100':[{...commit,committer:{login:reviewer}}]}).inspect(base);
  assert.equal(committer.independentReview?.state,'REVIEWER_IS_AUTHOR');
  assert.match(committer.blockers.join(' '),/not independent/);
});

test('incomplete commit history fails closed instead of skipping authorship checks',async()=>{
  const r=await gate({'pulls/12':{...pr,commits:2}}).inspect(base);
  assert.equal(r.state,'BLOCKED');assert.equal(r.independentReview?.state,'UNAVAILABLE');
});

test('review pagination is followed and an unreadable review list fails closed',async()=>{
  const filler=Array.from({length:100},(_,i)=>review('COMMENTED',sha,'bot-'+i,i+10));
  const paged=await gate({'pulls/12/reviews?per_page=100':filler,'pulls/12/reviews?per_page=100&page=2':[review('APPROVED',sha,reviewer,500)]}).inspect(base);
  assert.equal(paged.independentReview?.state,'APPROVED_EXACT_SHA');assert.equal(paged.independentReview?.reviewId,500);
  const broken=await gate({'pulls/12/reviews?per_page=100':undefined}).inspect(base);
  assert.equal(broken.state,'PENDING');
});

test('without configuration the gate keeps old behavior but warns loudly',async()=>{
  const r=await gate({},null).inspect(base);
  assert.equal(r.state,'REVIEWABLE');assert.equal(r.independentReview,undefined);
  assert.match(r.warnings.join(' '),/PANTER_GITHUB_INDEPENDENT_REVIEWER/);
});

test('invalid reviewer logins are rejected at startup',()=>{
  for(const bad of ['-lead','bad--login','spaces here','a'.repeat(40),'evil/login'])
    assert.throws(()=>gate({},bad),/Invalid independent reviewer/);
});
