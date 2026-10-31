import assert from 'node:assert/strict';
import {test} from 'node:test';
import {planWorktree, UnsafeWorktreePlan} from '../src/core/runner-worktree.js';
const good={repository:'riquelmechile/Panter-ai',candidateSha:'a'.repeat(40),
  missionId:'mission-1',workId:'work-1',attemptId:'attempt-1'};

test('deterministic detached-SHA plan stays inside its configured root',()=>{
  const plan=planWorktree('/tmp/panter-isolated',good);
  assert.equal(plan.detachedSha,good.candidateSha);
  assert.equal(plan.repository,good.repository);
  assert.equal(plan.worktreePath,'/tmp/panter-isolated/worktrees/mission-1/work-1/attempt-1');
  assert.equal(plan.attemptKey,'mission-1:work-1:attempt-1');
});
test('deny traversal, absolute refs, aliases, slashes and unsanitized components',()=>{
  const bad=[
    {missionId:'../../etc'}, {missionId:'..'}, {workId:'../outside'},
    {attemptId:'a/b'}, {attemptId:'.'}, {attemptId:'--/etc'},
    {missionId:'some space'}, {repository:'https://github.com/foo/bar'},
    {repository:'owner/../repo'}, {repository:'foo/bar.git#token'},
    {candidateSha:'main'}, {candidateSha:'A'.repeat(40)}, {candidateSha:'x'.repeat(40)},
  ];
  for(const override of bad)assert.throws(
    ()=>planWorktree('/tmp/panter-isolated',{...good,...override}),UnsafeWorktreePlan,
    JSON.stringify(override));
  assert.throws(()=>planWorktree('/',good),UnsafeWorktreePlan);
  assert.throws(()=>planWorktree('relative/path',good),UnsafeWorktreePlan);
});
test('plan is not an executable git dispatcher',()=>{
  const plan=planWorktree('/tmp/panter-isolated',good);
  assert.equal('argv' in plan,false);
  assert.equal('execute' in plan,false);
});
