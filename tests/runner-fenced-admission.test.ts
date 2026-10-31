import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawn} from 'node:child_process';
import {createHash,generateKeyPairSync,randomUUID,sign} from 'node:crypto';
import {mkdirSync,mkdtempSync,rmSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {RunnerWriterFence,WriterFenced} from '../src/core/runner-writer-fence.js';
import {RunnerIntegratedAdmission} from '../src/core/runner-integrated-admission.js';
import {RunnerGrantLedger,grantPayload,pinnedRunnerKeys,type RunnerGrant,type SignedRunnerGrant,type RunnerGrantContext} from '../src/core/runner-grants.js';
import {RunnerOutcomeLedger,type OutcomeIntent} from '../src/core/runner-outcomes.js';
import {AsyncSegmentedRunnerAudit,type AsyncSealAuthority} from '../src/core/runner-seal-http.js';
import {segmentSealPayload,segmentSealDigest,type SegmentSealClaim,type SignedSegmentSeal} from '../src/core/runner-segments.js';

const pair=generateKeyPairSync('ed25519');
const sealKeys=new Map([['external',pair.publicKey]]);
class Remote implements AsyncSealAuthority{
  seals=new Map<number,SignedSegmentSeal>();
  async latest(){return this.seals.get(this.seals.size)??null;}
  async get(n:number){return this.seals.get(n)??null;}
  async seal(claim:SegmentSealClaim,payload:Buffer){
    if(payload.length!==claim.bytes)throw Error('wrong payload');
    const prev=this.seals.get(this.seals.size);
    if(claim.previousSealHash!==(prev?segmentSealDigest(prev):'0'.repeat(64)))throw Error('seal gap');
    const receipt={keyId:'external',claim,signature:sign(null,segmentSealPayload(claim),
      pair.privateKey).toString('base64url')};
    this.seals.set(claim.segment,receipt);return receipt;
  }
}
async function child(dir:string):Promise<{ready:Promise<void>;done:Promise<string>;go:()=>void;stop:()=>void}>{
  const cp=spawn(process.execPath,['--import','tsx','tests/fixtures/runner-fence-worker.ts'],{stdio:['pipe','pipe','pipe']});
  let out='';
  let ready!:()=>void,readyFail!:(err:Error)=>void;
  const started=new Promise<void>((resolve,reject)=>{ready=resolve;readyFail=reject;});
  cp.stdout.setEncoding('utf8');
  cp.stdout.on('data',(v:string)=>{out+=v;if(out.includes('READY\n'))ready();});
  const done=new Promise<string>((resolve,reject)=>{
    cp.once('error',reject);
    cp.once('close',code=>code===0?resolve(out.trim().split('\n').at(-1)||''):reject(new Error('worker exit '+code)));
  });
  cp.once('error',readyFail);
  return {ready:started,done,go:()=>cp.stdin.end(JSON.stringify(dir)+'\n'),stop:()=>cp.kill()};
}
test('two independent OS writers race; exactly one claims, no silent reclaim after close',async()=>{
  for(let n=0;n<5;n++){
    const root=mkdtempSync(join(tmpdir(),'runner-writer-fence-'));
    try{
      const a=await child(root),b=await child(root);
      const timer=setTimeout(()=>{a.stop();b.stop();},15_000);
      try{
        await Promise.all([a.ready,b.ready]);
        a.go();b.go();
        const values=await Promise.all([a.done,b.done]);
        assert.deepEqual(values.sort(),['CLAIMED','DENIED']);
      }finally{clearTimeout(timer);a.stop();b.stop();}
      assert.throws(()=>RunnerWriterFence.claim(root),WriterFenced);
    }finally{rmSync(root,{recursive:true,force:true});}
  }
});
test('single writer prepares grant, durable intent and off-host signed audit; no effect',async()=>{
  const root=mkdtempSync(join(tmpdir(),'runner-integrated-admission-'));
  try{
    const fence=RunnerWriterFence.claim(join(root,'fence'));
    const grants=new RunnerGrantLedger(join(root,'grants'));
    const outcomes=new RunnerOutcomeLedger(join(root,'outcomes'));
    const remote=new Remote();
    const journal=await AsyncSegmentedRunnerAudit.open(join(root,'segments'),remote,sealKeys,650);
    const signer=generateKeyPairSync('ed25519');
    const keys=pinnedRunnerKeys({owner:signer.publicKey.export({format:'pem',type:'spki'}).toString()});
    const now=Date.now();
    const ctx:RunnerGrantContext={
      subject:'gpt-a',missionId:'mission-one',workId:'work-one',attemptId:'attempt-one',
      leaseGeneration:1,repository:'riquelmechile/Panter-ai',
      candidateSha:'a'.repeat(40),operation:'workspace.prepare',effectClass:'WORKTREE_WRITE',
    };
    const claim:RunnerGrant={version:1,grantId:randomUUID(),issuer:'panter-ai',
      audience:'panter-runner',subject:ctx.subject,missionId:ctx.missionId,
      workId:ctx.workId,attemptId:ctx.attemptId,leaseGeneration:1,
      repository:ctx.repository,candidateSha:ctx.candidateSha,
      notBefore:now-1000,expiresAt:now+60000,maxUses:1,
      operations:['workspace.prepare'],paths:['src/core'],effectClass:'WORKTREE_WRITE'};
    const signature=sign(null,grantPayload(claim),signer.privateKey).toString('base64url');
    const grant:SignedRunnerGrant={keyId:'owner',claims:claim,signature};
    const grantDigest=createHash('sha256').update(grantPayload(claim))
      .update(Buffer.from(signature,'base64url')).digest('hex');
    const intent:OutcomeIntent={operationId:randomUUID(),subject:ctx.subject,
      repository:ctx.repository,candidateSha:ctx.candidateSha,
      missionId:ctx.missionId,workId:ctx.workId,attemptId:ctx.attemptId,
      leaseGeneration:1,operation:'workspace.prepare',grantDigest};
    const admission=new RunnerIntegratedAdmission(fence,grants,outcomes,journal);
    const result=await admission.prepareSignedIntent(grant,keys,ctx,intent,now);
    assert.equal(result.status,'INTENT_SEALED');
    assert.equal(outcomes.get(intent.operationId)?.state,'INTENT');
    assert.equal(result.sealed,1);
    assert.equal(remote.seals.size,1);
    await assert.rejects(()=>admission.prepareSignedIntent(grant,keys,ctx,intent,now));
    assert.throws(()=>RunnerWriterFence.claim(join(root,'fence')),WriterFenced);
    outcomes.close();grants.close();fence.close();
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('writer fence rejects a symlinked root before SQLite access',()=>{
  const dir=mkdtempSync(join(tmpdir(),'runner-fence-symlink-'));
  try{
    const real=join(dir,'real'),alias=join(dir,'alias');
    mkdirSync(real,{mode:0o700});symlinkSync(real,alias);
    assert.throws(()=>RunnerWriterFence.claim(alias),WriterFenced);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
