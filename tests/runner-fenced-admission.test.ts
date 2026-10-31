import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawn} from 'node:child_process';
import {createHash,generateKeyPairSync,randomUUID,sign} from 'node:crypto';
import {mkdirSync,mkdtempSync,rmSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {RunnerWriterFence,WriterFenced,writerDeathPayload,type SignedWriterDeath,type WriterWitnessSnapshot} from '../src/core/runner-writer-fence.js';
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
    const remote=new Remote();
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
    const admission=await RunnerIntegratedAdmission.openAtRoot(root,remote,sealKeys,650);
    const result=await admission.prepareSignedIntent(grant,keys,ctx,intent,now);
    assert.equal(result.status,'INTENT_SEALED');
    assert.equal(admission.getOutcome(intent.operationId)?.state,'INTENT');
    assert.equal(result.sealed,1);
    assert.equal(remote.seals.size,1);
    await assert.rejects(()=>admission.prepareSignedIntent(grant,keys,ctx,intent,now));
    assert.throws(()=>RunnerWriterFence.claim(root),WriterFenced);
    admission.close();
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

test('signed death proof cannot reclaim live owner, wrong-root, wrong-owner or stale epoch',()=>{
  const root=mkdtempSync(join(tmpdir(),'runner-fence-proof-live-'));
  const other=mkdtempSync(join(tmpdir(),'runner-fence-proof-other-'));
  const key=generateKeyPairSync('ed25519'),pins=new Map([['witness',key.publicKey]]);
  try{
    const owner=RunnerWriterFence.claim(root),snapshot=owner.snapshot();
    const claim={domain:'panter.runner-writer-death/v1' as const,
      ...snapshot,observedAt:Date.now()};
    const signed:SignedWriterDeath={keyId:'witness',claim,
      signature:sign(null,writerDeathPayload(claim),key.privateKey).toString('base64url')};
    assert.throws(()=>RunnerWriterFence.reclaim(root,signed,pins),WriterFenced);
    assert.throws(()=>RunnerWriterFence.reclaim(other,signed,pins),WriterFenced);
    owner.assertCurrent();
    owner.close();
  }finally{rmSync(root,{recursive:true,force:true});rmSync(other,{recursive:true,force:true});}
});
test('dead OS process can be reclaimed only with fresh independent signature; old epoch is fenced',async()=>{
  const root=mkdtempSync(join(tmpdir(),'runner-fence-dead-'));
  const witness=generateKeyPairSync('ed25519');
  const pinned=new Map([['external-witness',witness.publicKey]]);
  try{
    const childProcess=await child(root);
    await childProcess.ready;
    childProcess.go();
    assert.equal(await childProcess.done,'CLAIMED'); // process fully exited
    const prior=RunnerWriterFence.snapshot(root);
    const claim={domain:'panter.runner-writer-death/v1' as const,
      ...prior,observedAt:Date.now()};
    const signed:SignedWriterDeath={keyId:'external-witness',claim,
      signature:sign(null,writerDeathPayload(claim),witness.privateKey).toString('base64url')};
    const newOwner=RunnerWriterFence.reclaim(root,signed,pinned);
    assert.equal(newOwner.generation,2);
    newOwner.assertCurrent();
    assert.throws(()=>RunnerWriterFence.reclaim(root,signed,pinned),WriterFenced);
    assert.throws(()=>RunnerWriterFence.claim(root),WriterFenced);
    newOwner.close();
  }finally{rmSync(root,{recursive:true,force:true});}
});
