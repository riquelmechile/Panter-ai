import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {LocalGitVerifier} from '../src/core/local-git-verifier.js';

test('trusted local worktree requires an exact clean SHA and operator-configured deterministic checks',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'panter-git-proof-'));
 try{
  const root=join(dir,'checkout');await mkdir(root);
  const git=(...args:string[])=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();
  git('init','-q');git('config','user.email','test@localhost');git('config','user.name','Test Runner');
  await writeFile(join(root,'source.txt'),'content\n');git('add','.');git('commit','-qm','feat: seed local Git fixture');
  const sha=git('rev-parse','HEAD');
  const config=join(dir,'operator.json');
  await writeFile(config,JSON.stringify({'app/local':{root,checks:[['node','-e','process.exit(0)']]}}));
  const verifier=await LocalGitVerifier.open(config);
  const ok=await verifier.inspect('app/local',sha);assert.equal(ok.state,'REVIEWABLE');assert.equal(ok.checkDigests.length,1);
  assert.equal((await verifier.inspect('app/local','a'.repeat(40))).state,'BLOCKED');
  await writeFile(join(root,'unknown.txt'),'untracked');
  const dirty=await verifier.inspect('app/local',sha);assert.equal(dirty.state,'BLOCKED');
  assert.match(dirty.blockers.join(' '),/uncommitted|untracked/);
  const outside=await verifier.inspect('other/project',sha);assert.equal(outside.state,'BLOCKED');
 }finally{await rm(dir,{recursive:true,force:true});}
});
