import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { grantPayload, type RunnerGrant, type RunnerGrantContext } from '../src/core/runner-grants.js';
import { SqliteLedger } from '../src/core/sqlite-ledger.js';

// True separate OS processes, racing on fresh directories before WAL exists.
type WorkerResult = { code: number | null; output: string; stderr: string };
function worker() {
  const cp = spawn(process.execPath, ['--import', 'tsx', 'tests/fixtures/runner-grant-worker.ts'], {
    cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '', stderr = '', started = false;
  let readyResolve!: () => void;
  let readyReject!: (reason: Error) => void;
  const ready = new Promise<void>((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
  cp.stdout.setEncoding('utf8');
  cp.stderr.setEncoding('utf8');
  cp.stdout.on('data',(chunk:string)=>{
    output += chunk;
    if (!started && output.includes('READY\n')) { started=true;readyResolve(); }
  });
  cp.stderr.on('data',(chunk:string)=>{stderr+=chunk;});
  const done = new Promise<WorkerResult>((resolve,reject)=>{
    cp.on('error',(err)=>{if(!started){started=true;readyReject(err);}reject(err);});
    cp.on('close',(code)=>{
      if(!started){started=true;readyReject(new Error('Worker died before barrier: '+stderr));}
      resolve({code,output,stderr});
    });
  });
  return {
    ready,done,
    send:(msg:unknown)=>{cp.stdin.write(JSON.stringify(msg)+'\n');cp.stdin.end();},
    stop:()=>cp.kill(),
  };
}
async function racePair(messages:[unknown,unknown]):Promise<WorkerResult[]> {
  const first=worker(), second=worker();
  const timer=setTimeout(()=>{first.stop();second.stop();},15_000);
  try {
    await Promise.all([first.ready,second.ready]);
    first.send(messages[0]);
    second.send(messages[1]);
    return await Promise.all([first.done,second.done]);
  } finally {
    clearTimeout(timer);
    first.stop();second.stop();
  }
}
test('two OS processes concurrently initialize a new WAL and reserve the same one-use grant', async()=>{
  const pair=generateKeyPairSync('ed25519');
  const publicKey=pair.publicKey.export({format:'pem',type:'spki'}).toString();
  const now=Date.now(),sha='a'.repeat(40);
  const ctx:RunnerGrantContext={
    subject:'gpt-a',missionId:'mission-test',workId:'work-test',attemptId:'attempt-test',
    leaseGeneration:1,repository:'riquelmechile/Panter-ai',
    candidateSha:sha,operation:'workspace.prepare',effectClass:'WORKTREE_WRITE',
  };
  for(let iteration=0;iteration<4;iteration++){
    const dir=mkdtempSync(join(tmpdir(),'runner-two-process-'));
    try {
      const claims:RunnerGrant={
        version:1,grantId:randomUUID(),issuer:'panter-ai',audience:'panter-runner',
        subject:ctx.subject,missionId:ctx.missionId,workId:ctx.workId,
        attemptId:ctx.attemptId,leaseGeneration:ctx.leaseGeneration,
        repository:ctx.repository,candidateSha:ctx.candidateSha,
        notBefore:now-1000,expiresAt:now+60_000,maxUses:1,
        operations:['workspace.prepare'],paths:['src/core'],effectClass:'WORKTREE_WRITE',
      };
      const grant={keyId:'test-owner',claims,signature:sign(null,grantPayload(claims),pair.privateKey).toString('base64url')};
      const msg={kind:'runner',dir,grant,ctx,publicKey,now};
      const results=await racePair([{...msg,requestId:randomUUID()},{...msg,requestId:randomUUID()}]);
      assert.deepEqual(results.map(x=>x.code),[0,0],JSON.stringify(results));
      assert.deepEqual(results.map(x=>x.output.trim().split('\n').at(-1)).sort(),['REJECTED','SUCCESS'],JSON.stringify(results));
      assert.ok(results.every(x=>!x.output.includes('database is locked')),JSON.stringify(results));
    } finally {rmSync(dir,{recursive:true,force:true});}
  }
});
test('two OS processes concurrently initialize panter.sqlite and retain both commits', async()=>{
  for(let iteration=0;iteration<3;iteration++){
    const dir=mkdtempSync(join(tmpdir(),'panter-two-process-'));
    try {
      const results=await racePair([{kind:'sqlite',dir},{kind:'sqlite',dir}]);
      assert.deepEqual(results.map(x=>x.code),[0,0],JSON.stringify(results));
      assert.ok(results.every(x=>x.output.includes('SUCCESS')),JSON.stringify(results));
      const db=SqliteLedger.open(dir);
      assert.equal(db.read('state',{version:1,count:0}).count,2);
      db.close();
    } finally {rmSync(dir,{recursive:true,force:true});}
  }
});
