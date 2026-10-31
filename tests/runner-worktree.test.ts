import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {test} from 'node:test';
import {planWorktree, UnsafeWorktreePlan} from '../src/core/runner-worktree.js';

const good={repository:'riquelmechile/Panter-ai',candidateSha:'a'.repeat(40),
  missionId:'mission-1',workId:'work-1',attemptId:'attempt-1'};
const digest=(s:string)=>createHash('sha256').update(s,'utf8').digest('hex');

test('deterministic detached-SHA plan binds repo and full SHA in path and attemptKey',()=>{
  const plan=planWorktree('/tmp/panter-isolated',good);
  const parts=[digest(good.repository),good.candidateSha,digest(good.missionId),digest(good.workId),digest(good.attemptId)];
  assert.equal(plan.detachedSha,good.candidateSha);
  assert.equal(plan.repository,good.repository);
  assert.equal(plan.worktreePath,'/tmp/panter-isolated/worktrees/'+parts.join('/'));
  assert.equal(plan.attemptKey,parts.join(':'));
  assert.equal(planWorktree('/tmp/panter-isolated',good).worktreePath,plan.worktreePath);
});

test('different repositories or exact SHA with the same IDs yield distinct paths and keys',()=>{
  const root='/tmp/panter-isolated';
  const first=planWorktree(root,good);
  const differentRepo=planWorktree(root,{...good,repository:'riquelmechile/plasticov-store'});
  const differentSha=planWorktree(root,{...good,candidateSha:'b'.repeat(40)});
  for(const other of [differentRepo,differentSha]){
    assert.notEqual(other.worktreePath,first.worktreePath);
    assert.notEqual(other.attemptKey,first.attemptKey);
  }
  assert.notEqual(differentRepo.worktreePath,differentSha.worktreePath);
  assert.notEqual(differentRepo.attemptKey,differentSha.attemptKey);
});

test('all grant-valid mission/work/attempt IDs remain valid but safely hashed',()=>{
  for(const id of ['.', '..', 'a.b:c@d-1', 'z'.repeat(160)]) {
    const plan=planWorktree('/tmp/panter-isolated',{...good,missionId:id,workId:id,attemptId:id});
    assert.ok(plan.worktreePath.startsWith('/tmp/panter-isolated/worktrees/'));
    assert.ok(!plan.worktreePath.includes('/../'));
    assert.ok(!plan.worktreePath.includes('/./'));
    assert.ok(plan.attemptKey.includes(digest(id)));
  }
});

test('deny traversal, mutable refs, invalid IDs or unsafe roots',()=>{
  const bad=[
    {missionId:'../../etc'}, {workId:'../outside'}, {attemptId:'a/b'},
    {missionId:'some space'}, {repository:'https://github.com/foo/bar'},
    {repository:'owner/../repo'}, {repository:'foo/bar.git#token'},
    {candidateSha:'main'}, {candidateSha:'A'.repeat(40)}, {candidateSha:'x'.repeat(40)},
    {missionId:'z'.repeat(161)}, {attemptId:'bad\\path'},
  ];
  for(const override of bad)assert.throws(
    ()=>planWorktree('/tmp/panter-isolated',{...good,...override}),UnsafeWorktreePlan,
    JSON.stringify(override));
  assert.throws(()=>planWorktree('/',good),UnsafeWorktreePlan);
  assert.throws(()=>planWorktree('relative/path',good),UnsafeWorktreePlan);
});
test('planner never exposes executable git or mutable branch arguments',()=>{
  const plan=planWorktree('/tmp/panter-isolated',good);
  assert.equal('argv' in plan,false);
  assert.equal('execute' in plan,false);
});
