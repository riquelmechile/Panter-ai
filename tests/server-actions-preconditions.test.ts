import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile, access, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MeshEngine } from '../src/core/mesh.js';
import { ServerActions } from '../src/core/server-actions.js';
import { ServerDeployGate, DeployGateError, type LocalDeployState } from '../src/core/server-action-preconditions.js';

const sha='a'.repeat(40);
const head='b'.repeat(40);
const earlier='c'.repeat(40);
const repo='example-org/panter';
type Json={ [key:string]:any };
type Scenario={
  compare?:string; repoBranch?:string; prs?:Json[]; runs?:Json[];
  totalRuns?:number; reviews?:Json[]; commits?:Json[]; prCommits?:unknown; failPath?:string;
  local?:LocalDeployState; called?:string[];
};
const pr=()=>({number:9,merged_at:'2026-01-01T00:00:00Z',
  base:{ref:'main'},merge_commit_sha:sha,head:{sha:head},
  user:{login:'author-user'}});
const run=(name:string,id:number,status='completed',conclusion:string|null='success')=>
  ({name,id,status,conclusion,head_sha:sha});
const review=(state:string,commitId=head,id=30,time='2026-01-03T00:00:00Z',login='review-account')=>
  ({id,user:{login},state,commit_id:commitId,submitted_at:time});
function githubFake(s:Scenario={}):typeof fetch {
  const fetchFn=async (url:RequestInfo|URL) => {
    const value=String(url);
    s.called?.push(value);
    const path=new URL(value).pathname;
    if(s.failPath && path.includes(s.failPath))return new Response('{}',{status:503});
    const prefix='/repos/'+repo;
    assert.ok(path.startsWith(prefix),'Unexpected URL: '+path);
    const rest=path.slice(prefix.length).replace(/^\//,'');
    const page=Number(new URL(value).searchParams.get('page')??'1');
    const pageSlice=(items:Json[])=>items.slice((page-1)*100,page*100);
    const prs=s.prs??[pr()];
    const runs=s.runs??[run('test',2),run('arm64-image',3)];
    const reviews=s.reviews??[review('APPROVED')];
    const commits=s.commits??[{author:{login:'author-user'},committer:{login:'web-flow'}}];
    let payload:any;
    if(rest==='')payload={default_branch:s.repoBranch??'main'};
    else if(rest.startsWith('compare/'))payload={status:s.compare??'identical'};
    else if(rest==='commits/'+sha+'/pulls')payload=pageSlice(prs);
    else if(rest==='commits/'+sha+'/check-runs')
      payload={total_count:s.totalRuns??runs.length,check_runs:pageSlice(runs)};
    else if(rest==='pulls/9')payload={...(prs.find(p=>p.number===9)??pr()),
      commits:'prCommits' in s?s.prCommits:commits.length};
    else if(rest==='pulls/9/commits')payload=pageSlice(commits);
    else if(rest==='pulls/9/reviews')payload=pageSlice(reviews);
    else throw new Error('Unhandled GitHub API path: '+rest);
    return new Response(JSON.stringify(payload),{status:200,headers:{'content-type':'application/json'}});
  };
  return fetchFn as typeof fetch;
}
const gate=(s:Scenario={})=>new ServerDeployGate({
  repository:repo, checks:'test,arm64-image',independentReviewer:'review-account'
},githubFake(s),async()=>s.local??{revision:earlier,maintenance:false});
const config=(extra:Record<string,string|undefined>={})=>({
  PANTER_SERVER_ACTIONS:'deploy.commit',PANTER_SERVER_DEPLOY_REPOSITORY:repo,
  PANTER_SERVER_DEPLOY_CHECKS:'test,arm64-image',
  PANTER_GITHUB_INDEPENDENT_REVIEWER:'review-account',
  PANTER_SERVER_DEPLOY_SOURCE:'<test-clone>',
  PANTER_SERVER_DEPLOY_STANDING_AUTHORIZATION:'1',
  ...extra
});
const profile={host:'grok' as const,actorId:'fake-grok',
  modelRequest:'host-default',effortRequest:'max',roles:['reviewer' as const]};
async function fixture(fn:(mesh:MeshEngine,server:ServerActions,dir:string)=>Promise<void>,
  scenario:Scenario={},cfg:Record<string,string|undefined>={}) {
  const dir=await mkdtemp(join(tmpdir(),'panter-server-phase1-'));
  const mesh=await MeshEngine.open(dir);
  const server=new ServerActions(mesh,dir,config(cfg),githubFake(scenario),
    async()=>scenario.local??{revision:earlier,maintenance:false});
  try {
    await mesh.setProfile('gpt-a',profile,0);
    await fn(mesh,server,dir);
  } finally { server.close(); await rm(dir,{recursive:true,force:true}); }
}
const delegate=(mesh:MeshEngine)=>mesh.delegate('gpt-a',{missionId:'test-run',target:'grok',
  role:'reviewer',instruction:'Verify a release',idempotencyKey:randomUUID()});
const workerAction=(p:{permitId:string;workId:string},c:{attemptId:string|null;leaseGeneration:number})=>
  ({action:'deploy.commit' as const,args:{sha},permitId:p.permitId,workId:p.workId,
    attemptId:c.attemptId!,leaseGeneration:c.leaseGeneration});

test('compare truth table: identical and ahead eligible; behind/diverged/unknown fail closed', async()=>{
  for(const [status,allowed] of [
    ['identical',true],['ahead',true],['behind',false],['diverged',false],
    ['unknown',false],['',false]] as const) {
    const g=gate({compare:status});
    if(allowed) assert.equal((await g.verify(sha)).length,5,status);
    else await assert.rejects(g.verify(sha),/PRECONDITION_ON_MAIN/,status);
  }
  await assert.rejects(gate({failPath:'/compare/'}).verify(sha),/PRECONDITION_ON_MAIN/);
  await assert.rejects(gate({repoBranch:'master'}).verify(sha),/PRECONDITION_ON_MAIN/);
});

test('strict order: each precondition is evaluated only after its predecessors pass',async()=>{
  for(const [scenario,step] of [
    [{compare:'behind'},'ON_MAIN'],[{prs:[]},'MERGED_PR'],
    [{runs:[run('test',2)]},'GREEN_CHECKS'],
    [{reviews:[review('CHANGES_REQUESTED')]},'INDEPENDENT_REVIEW'],
    [{local:{revision:sha,maintenance:false}},'LOCAL_STATE']
  ] as Array<[Scenario,string]>) {
    const s:Scenario={...scenario,called:[]};
    await assert.rejects(gate(s).verify(sha),new RegExp('PRECONDITION_'+step));
    const paths=s.called!.map(x=>new URL(x).pathname);
    const cursor=['ON_MAIN','MERGED_PR','GREEN_CHECKS','INDEPENDENT_REVIEW','LOCAL_STATE'].indexOf(step);
    if(cursor<2) assert.ok(!paths.some(x=>x.includes('/check-runs')),'No later GitHub checks after an earlier failure');
    if(cursor<3) assert.ok(!paths.some(x=>x.includes('/reviews')),'No review fetch after earlier failure');
  }
});

test('merged-PR gate counts only matching merged PRs; zero, duplicate and unmerged fail',async()=>{
  const cases=[
    [],[({...pr(),merge_commit_sha:head})],
    [{...pr(),merged_at:null}],
    [pr(),{...pr(),number:10}],
    [{...pr(),base:{ref:'release'}}],
  ];
  for(const prs of cases)await assert.rejects(gate({prs}).verify(sha),/PRECONDITION_MERGED_PR/);
  const s={prs:[{...pr(),merged_at:null},pr()]};
  assert.equal((await gate(s).verify(sha)).length,5);
});

test('highest check run ID wins regardless of status: stale successes never prove green',async()=>{
  for(const [status,conclusion,allowed] of [
    ['queued',null,false],['in_progress',null,false],
    ['completed','failure',false],['completed','cancelled',false],
    ['completed','success',true]
  ] as const) {
    const runs=[run('test',10,'completed','success'),run('test',20,status,conclusion),
      run('arm64-image',9)];
    if(allowed) assert.equal((await gate({runs}).verify(sha)).length,5);
    else await assert.rejects(gate({runs}).verify(sha),/PRECONDITION_GREEN_CHECKS/);
  }
  await assert.rejects(gate({runs:[run('arm64-image',2)]}).verify(sha),/PRECONDITION_GREEN_CHECKS/);
  await assert.rejects(gate({runs:[{...run('test',9),head_sha:earlier},run('arm64-image',8)]})
    .verify(sha),/PRECONDITION_GREEN_CHECKS/);
});

test('latest decisive review by submission time only, on final PR head, independent of author',async()=>{
  const rows:[
    string,Scenario,boolean
  ][]=[
    ['approved exact head',{reviews:[review('APPROVED')]},true],
    ['old SHA approved',{reviews:[review('APPROVED',earlier)]},false],
    ['changes requested',{reviews:[review('CHANGES_REQUESTED')]},false],
    ['dismissed',{reviews:[review('DISMISSED')]},false],
    ['no decisive review',{reviews:[review('COMMENTED')]},false],
    ['newest changes requested wins',{reviews:[
      review('CHANGES_REQUESTED',head,40,'2026-01-04T00:00:00Z'),
      review('APPROVED',head,20,'2026-01-01T00:00:00Z')]},false],
    ['COMMENTED later does not revoke',{reviews:[review('APPROVED'),review('COMMENTED',head,50,'2026-01-05T00:00:00Z')]},true],
    ['reviewer authored commit',{commits:[{author:{login:'review-account'}}]},false],
    ['reviewer authored PR',{prs:[{...pr(),user:{login:'review-account'}}]},false],
    ['missing submitted_at',{reviews:[{...review('APPROVED'),submitted_at:null}]},false],
    ['new approval on old head over revoked current approval',{reviews:[
      review('CHANGES_REQUESTED',head,20,'2026-01-01T00:00:00Z'),
      review('APPROVED',earlier,40,'2026-01-04T00:00:00Z')]},false]
  ];
  for(const [label,s,allowed] of rows) {
    if(allowed) assert.equal((await gate(s).verify(sha)).length,5,label);
    else await assert.rejects(gate(s).verify(sha),/PRECONDITION_INDEPENDENT_REVIEW/,label);
  }
});

test('PR, check-run and review pagination caps reject overflow and malformation',async()=>{
  await assert.rejects(gate({prs:Array.from({length:101},(_,i)=>({...pr(),number:i+1}))})
    .verify(sha),/PRECONDITION_MERGED_PR/);
  await assert.rejects(gate({totalRuns:1001}).verify(sha),/PRECONDITION_GREEN_CHECKS/);
  const manyReviews=Array.from({length:1001},(_,i)=>review('COMMENTED',head,i+1));
  await assert.rejects(gate({reviews:manyReviews}).verify(sha),/PRECONDITION_INDEPENDENT_REVIEW/);
  const commits=Array.from({length:1001},()=>({author:{login:'author-user'}}));
  await assert.rejects(gate({commits}).verify(sha),/PRECONDITION_INDEPENDENT_REVIEW/);
  const authored=(n:number)=>Array.from({length:n},()=>({author:{login:'author-user'}}));
  assert.equal((await gate({commits:authored(250)}).verify(sha)).length,5,
    'a complete 250-commit history spans three pages and passes');
  await assert.rejects(gate({commits:authored(250),prCommits:251}).verify(sha),
    /PRECONDITION_INDEPENDENT_REVIEW/,'history beyond what GitHub lists is never trusted');
  await assert.rejects(gate({commits:authored(3),prCommits:4}).verify(sha),
    /PRECONDITION_INDEPENDENT_REVIEW/,'a truncated listing fails closed');
  await assert.rejects(gate({commits:authored(4),prCommits:3}).verify(sha),
    /PRECONDITION_INDEPENDENT_REVIEW/,'a listing longer than the PR count fails closed');
  for(const bad of [undefined,null,0,-1,'3',1.5])
    await assert.rejects(gate({prCommits:bad}).verify(sha),
      /PRECONDITION_INDEPENDENT_REVIEW/,'malformed commit count: '+String(bad));
  const hidden=[...authored(250),{author:{login:'review-account'}}];
  await assert.rejects(gate({commits:hidden.slice(0,250),prCommits:251}).verify(sha),
    /PRECONDITION_INDEPENDENT_REVIEW/,'a reviewer commit past the listing cannot hide');
  await assert.rejects(gate({failPath:'/pulls/9'}).verify(sha),/PRECONDITION_INDEPENDENT_REVIEW/);
  assert.equal((await gate({runs:[
    ...Array.from({length:100},(_,i)=>run('extra',i+1)),
    run('test',200),run('arm64-image',201)
  ]}).verify(sha)).length,5,'multiple check-run pages are read');
});

test('local health already reports SHA or maintenance marker: refuse, never reserve',async()=>{
  await assert.rejects(gate({local:{revision:sha,maintenance:false}}).verify(sha),
    /PRECONDITION_LOCAL_STATE/);
  await assert.rejects(gate({local:{revision:earlier,maintenance:true}}).verify(sha),
    /PRECONDITION_LOCAL_STATE/);
  assert.equal((await gate({local:{revision:null,maintenance:false}}).verify(sha)).length,5);
});

test('disabled tools uniformly return SERVER_ACTIONS_DISABLED (no ledger files created)',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'panter-server-disabled-'));
  const mesh=await MeshEngine.open(dir);
  const disabled=new ServerActions(mesh,dir,config({PANTER_SERVER_ACTIONS:undefined}),githubFake());
  try {
    assert.throws(()=>disabled.authorize('admin',{action:'deploy.commit',sha}),/SERVER_ACTIONS_DISABLED/);
    await assert.rejects(disabled.grant('gpt-a',{workId:randomUUID(),
      action:'deploy.commit',args:{sha}}),/SERVER_ACTIONS_DISABLED/);
    await assert.rejects(disabled.revoke('gpt-a',randomUUID()),/SERVER_ACTIONS_DISABLED/);
    await assert.rejects(disabled.action('gpt-a',{action:'deploy.commit',args:{sha}}),/SERVER_ACTIONS_DISABLED/);
    await assert.rejects(disabled.status('gpt-a'),/SERVER_ACTIONS_DISABLED/);
    await assert.rejects(access(join(dir,'server-actions')),'No extra SQLite directory when disabled');
  } finally { disabled.close(); await rm(dir,{recursive:true,force:true}); }
});

test('without standing or per-release authorization leader and permit issuer get NOT_AUTHORIZED',()=>
  fixture(async (mesh,server)=>{
    const w=await delegate(mesh);
    await assert.rejects(server.grant('gpt-a',{workId:w.id,action:'deploy.commit',args:{sha}}),
      /NOT_AUTHORIZED/);
    await assert.rejects(server.action('gpt-a',{action:'deploy.commit',args:{sha}}),
      /NOT_AUTHORIZED/);
    assert.throws(()=>server.authorize('gpt-a',{action:'deploy.commit',sha}),/OPERATOR_ONLY/);
    assert.throws(()=>server.authorize('grok',{action:'deploy.commit',sha}),/OPERATOR_ONLY/);
  },{},{PANTER_SERVER_DEPLOY_STANDING_AUTHORIZATION:undefined}));

test('worker permit action dry-run spends once, records all six checks, never invokes system commands',()=>
  fixture(async (mesh,server,dir)=>{
    const w=await delegate(mesh);
    const p=await server.grant('gpt-a',{workId:w.id,action:'deploy.commit',args:{sha}});
    const c=await mesh.claim('grok',w.id);
    // Fakes are deliberately executable and on PATH: no invocation is permitted.
    const bin=join(dir,'bin');await mkdir(bin);
    const marker=join(dir,'called');
    for(const name of ['systemd-run','systemctl','deploy.sh']) {
      const file=join(bin,name);
      await writeFile(file,'#!/bin/sh\necho called >> "'+marker+'"\nexit 1\n',{mode:0o755});
    }
    const original=process.env.PATH;
    try {
      process.env.PATH=bin+':'+(original??'');
      const out=await server.action('grok',workerAction(p,c));
      assert.equal(out.status,'DRY_RUN');
      assert.equal(out.reserved,'RESERVED');
      assert.equal(out.finalState,'DRY_RUN');
      assert.deepEqual(out.checks.map(x=>x.precondition),
        ['AUTHORIZATION','ON_MAIN','MERGED_PR','GREEN_CHECKS','INDEPENDENT_REVIEW','LOCAL_STATE']);
      assert.equal(out.wouldLaunch.command,'systemd-run');
      assert.equal(out.wouldLaunch.argv.at(-1),sha);
      await assert.rejects(access(marker),'No subprocess should ever be invoked');
      const status=await server.status('gpt-a');
      assert.equal(status.actions[0]!.state,'DRY_RUN');
      const filtered=await server.status('gpt-a',out.actionId);
      assert.equal(filtered.actions.length,1);
      assert.equal(filtered.permits.find(x=>x.permitId===p.permitId)?.effectiveState,'SPENT');
      assert.equal(status.permits.find(x=>x.permitId===p.permitId)!.state,'SPENT');
      assert.equal((await server.status('grok')).actions.length,1);
      await assert.rejects(server.action('grok',workerAction(p,c)),/PERMIT_INVALID/);
    } finally { process.env.PATH=original; }
  }));

test('operator per-release record is bound once and stays BOUND if revoked; direct consumes OPEN',()=>
  fixture(async (mesh,server)=>{
    const record=server.authorize('admin',{action:'deploy.commit',sha});
    assert.equal(record.state,'OPEN');
    const w=await delegate(mesh);
    const p=await server.grant('gpt-a',{workId:w.id,action:'deploy.commit',args:{sha}});
    assert.equal((await server.status('gpt-a')).authorizations?.[0]!.state,'BOUND');
    assert.equal(p.authorizationId,record.id);
    const replay=await server.grant('gpt-a',{workId:w.id,action:'deploy.commit',args:{sha}});
    assert.equal(replay.permitId,p.permitId,'Idempotent grant must not need a new operator record');
    await server.revoke('gpt-a',p.permitId);
    assert.equal((await server.status('gpt-a')).authorizations?.[0]!.state,'BOUND');
    await assert.rejects(server.grant('gpt-a',{workId:w.id,action:'deploy.commit',args:{sha}}),
      /NOT_AUTHORIZED/);
    const next=server.authorize('admin',{action:'deploy.commit',sha});
    const direct=await server.action('gpt-a',{action:'deploy.commit',args:{sha}});
    assert.equal(direct.status,'DRY_RUN');
    assert.equal((await server.status('gpt-a')).authorizations?.find(x=>x.id===next.id)?.state,'CONSUMED');
  },{},{PANTER_SERVER_DEPLOY_STANDING_AUTHORIZATION:undefined}));

test('any failed precondition names the first fault and leaves the worker permit ISSUED',()=>
  fixture(async (mesh,server)=>{
    const w=await delegate(mesh);
    const p=await server.grant('gpt-a',{workId:w.id,action:'deploy.commit',args:{sha}});
    const c=await mesh.claim('grok',w.id);
    await assert.rejects(server.action('grok',workerAction(p,c)),/PRECONDITION_GREEN_CHECKS/);
    const status=await server.status('gpt-a');
    assert.equal(status.actions.length,0);
    assert.equal(status.permits.find(x=>x.permitId===p.permitId)?.state,'ISSUED');
  },{runs:[run('test',1),run('arm64-image',2,'in_progress',null)]}));

test('two overlapping reservations: one RESERVED, one BUSY and its SPENT permit is PERMIT_LOST',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'panter-server-race-'));
  const mesh=await MeshEngine.open(dir);
  await mesh.setProfile('gpt-a',profile,0);
  let release!:()=>void;
  let entered!:()=>void;
  const suspended=new Promise<void>(resolve=>release=resolve);
  const reserved=new Promise<void>(resolve=>entered=resolve);
  let waitCount=0;
  const opts=config();
  const server=new ServerActions(mesh,dir,opts,githubFake(),async()=>({revision:earlier,maintenance:false}),
    async()=>{if(waitCount++===0){entered();await suspended;}});
  try {
    const w1=await delegate(mesh),w2=await delegate(mesh);
    const p1=await server.grant('gpt-a',{workId:w1.id,action:'deploy.commit',args:{sha}});
    const p2=await server.grant('gpt-a',{workId:w2.id,action:'deploy.commit',args:{sha}});
    const c1=await mesh.claim('grok',w1.id),c2=await mesh.claim('grok',w2.id);
    const first=server.action('grok',workerAction(p1,c1));
    await reserved;
    const holding=(await server.status('gpt-a')).actions[0]!;
    assert.equal(holding.state,'RESERVED');
    await assert.rejects(server.action('grok',workerAction(p2,c2)),/BUSY; PERMIT_LOST/);
    const lost=(await server.status('gpt-a')).permits.find(x=>x.permitId===p2.permitId);
    assert.equal(lost?.effectiveState,'PERMIT_LOST');
    release();
    assert.equal((await first).status,'DRY_RUN');
    assert.equal((await server.status('gpt-a')).actions.length,1);
  } finally { release?.();server.close();await rm(dir,{recursive:true,force:true}); }
});

test('server-action tools preserve router operation names and worker/leader listing caps',async()=>{
  const {readFile}=await import('node:fs/promises');
  const {DOMAINS,workflowTools,toolDomain,operationName,listedFor}=
    await import('../src/core/tool-surface.js');
  const content=await readFile(new URL('../src/server.ts',import.meta.url),'utf8');
  const registered=[...new Set([...content.matchAll(/server\.registerTool\('(panter_[a-z_]+)'/g)]
    .map(m=>m[1]!) )];
  const names=['authorize','grant','revoke','action','status'].map(x=>'panter_server_'+x);
  for(const name of names) {
    assert.ok(registered.includes(name),name+' registered');
    assert.equal(toolDomain(name),'admin');
    assert.equal(operationName(name),'server_'+name.slice('panter_server_'.length));
  }
  assert.ok(listedFor('panter_server_action','worker'));
  assert.ok(!listedFor('panter_server_action','leader'));
  for(const name of names.filter(x=>x!=='panter_server_action')) assert.equal(listedFor(name,'worker'),false);
  assert.ok(workflowTools('leader').length+DOMAINS.length<=50);
  assert.equal(workflowTools('worker').length+DOMAINS.length,32);
});

test('release of an undelivered transport claim and OUTCOME_UNKNOWN writer both revoke permits',()=>
  fixture(async (mesh,server)=>{
    const readOnly=await delegate(mesh);
    const c=await mesh.claim('grok',readOnly.id);
    const p=await server.grant('gpt-a',{workId:readOnly.id,action:'deploy.commit',args:{sha}});
    await mesh.releaseUnsentClaim('grok',readOnly.id,c.attemptId!,c.leaseGeneration);
    assert.equal((await server.status('gpt-a')).permits.find(x=>x.permitId===p.permitId)?.state,
      'REVOKED');

    await mesh.setProfile('gpt-a',{...profile,roles:['implementer']},1);
    mesh.setWriteGuard(async()=>{});
    const writer=await mesh.delegate('gpt-a',{missionId:'writer-mission',target:'grok',
      role:'implementer',instruction:'Carry out approved change',idempotencyKey:randomUUID()});
    const claim=await mesh.claim('grok',writer.id,30);
    const wp=await server.grant('gpt-a',{workId:writer.id,action:'deploy.commit',args:{sha}});
    const original=Date.now;
    try {
      Date.now=()=>original()+31_000;
      const uncertain=await mesh.claim('grok',writer.id,30);
      assert.equal(uncertain.state,'OUTCOME_UNKNOWN');
      assert.equal((await server.status('gpt-a')).permits.find(x=>x.permitId===wp.permitId)?.state,
        'REVOKED');
      await assert.rejects(server.action('grok',workerAction(wp,claim)),/PERMIT_INVALID/);
    } finally { Date.now=original; }
  }));
