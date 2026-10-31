import assert from 'node:assert/strict';
import {test} from 'node:test';
import {generateKeyPairSync,randomUUID,sign} from 'node:crypto';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {RunnerOutcomeLedger,OutcomeRejected,outcomeClaimPayload,independentOutcomeKeys,
 type OutcomeIntent,type OutcomeClaim} from '../src/core/runner-outcomes.js';
const pair=generateKeyPairSync('ed25519');
const wrong=generateKeyPairSync('ed25519');
const keys=independentOutcomeKeys({independent:pair.publicKey.export({format:'pem',type:'spki'}).toString()});
const baseline=():OutcomeIntent=>({
  operationId:randomUUID(),subject:'gpt-a',repository:'riquelmechile/Panter-ai',
  candidateSha:'a'.repeat(40),missionId:'mission-1',workId:'work-1',attemptId:'attempt-1',
  leaseGeneration:5,operation:'workspace.prepare',grantDigest:'b'.repeat(64),
});
const receipt=(claim:OutcomeClaim,other=false)=>({
  keyId:'independent',claim,signature:sign(null,outcomeClaimPayload(claim),
    other?wrong.privateKey:pair.privateKey).toString('base64url'),
});
const rejects=(fn:()=>unknown)=>assert.throws(fn,OutcomeRejected);

test('INTENT and expired EFFECT_WINDOW become OUTCOME_UNKNOWN after restart, never automatically retried',async()=>{
  const root=mkdtempSync(join(tmpdir(),'runner-outcome-restart-'));
  try{
    const db=new RunnerOutcomeLedger(root);
    const first=baseline(),second=baseline();
    assert.equal(db.prepare(first).state,'INTENT');
    assert.equal(db.prepare(second).state,'INTENT');
    assert.equal(db.enterEffectWindow(first.operationId,5,Date.now()+50).state,'EFFECT_WINDOW');
    rejects(()=>db.enterEffectWindow(first.operationId,5,Date.now()+50));
    rejects(()=>db.enterEffectWindow(second.operationId,6,Date.now()+50));
    db.close();
    await new Promise(r=>setTimeout(r,65));
    const reopened=new RunnerOutcomeLedger(root);
    assert.equal(reopened.get(first.operationId)?.state,'OUTCOME_UNKNOWN');
    assert.equal(reopened.get(second.operationId)?.state,'OUTCOME_UNKNOWN');
    rejects(()=>reopened.enterEffectWindow(first.operationId,5,Date.now()+50));
    rejects(()=>reopened.prepare(first));
    reopened.close();
  }finally{rmSync(root,{recursive:true,force:true});}
});
test('separate Ed25519 signed observation resolves a single UNKNOWN outcome; same receipt idempotent',async()=>{
  const root=mkdtempSync(join(tmpdir(),'runner-outcome-reconcile-'));
  try{
    let db=new RunnerOutcomeLedger(root);
    const intent=baseline();
    const snap=db.prepare(intent);
    db.enterEffectWindow(intent.operationId,intent.leaseGeneration,Date.now()+50);
    db.close();
    await new Promise(r=>setTimeout(r,65));
    db=new RunnerOutcomeLedger(root);
    const claim:OutcomeClaim={domain:'panter.outcome-reconciliation/v1',
      operationId:intent.operationId,intentDigest:snap.intentDigest,leaseGeneration:5,
      outcome:'SUCCEEDED',evidenceDigest:'c'.repeat(64),observedAt:Date.now()};
    rejects(()=>db.reconcile(receipt(claim,true),keys));
    rejects(()=>db.reconcile(receipt({...claim,leaseGeneration:6}),keys));
    rejects(()=>db.reconcile({...receipt(claim),claim:{...claim,operationId:randomUUID()}},keys));
    assert.equal(db.reconcile(receipt(claim),keys).state,'SUCCEEDED');
    assert.equal(db.reconcile(receipt(claim),keys).state,'SUCCEEDED');
    rejects(()=>db.reconcile(receipt({...claim,outcome:'FAILED'}),keys));
    db.close();
    const again=new RunnerOutcomeLedger(root);
    assert.equal(again.get(intent.operationId)?.state,'SUCCEEDED');
    rejects(()=>again.prepare(intent));
    again.close();
  }finally{rmSync(root,{recursive:true,force:true});}
});
test('signed NO_EFFECT never retries automatically and requires a new distinct operation identifier',()=>{
  const root=mkdtempSync(join(tmpdir(),'runner-outcome-noeffect-'));
  try{
    let db=new RunnerOutcomeLedger(root);
    const intent=baseline();const snap=db.prepare(intent);
    db.close();db=new RunnerOutcomeLedger(root);
    const claim:OutcomeClaim={domain:'panter.outcome-reconciliation/v1',operationId:intent.operationId,
      intentDigest:snap.intentDigest,leaseGeneration:5,outcome:'NO_EFFECT',evidenceDigest:'d'.repeat(64),
      observedAt:Date.now()};
    assert.equal(db.reconcile(receipt(claim),keys).state,'NO_EFFECT');
    rejects(()=>db.prepare(intent));
    rejects(()=>db.enterEffectWindow(intent.operationId,5,Date.now()+50));
    const newIntent={...intent,operationId:randomUUID()};
    assert.equal(db.prepare(newIntent).state,'INTENT');
    db.close();
  }finally{rmSync(root,{recursive:true,force:true});}
});
test('reconciler cannot preapprove while effect window remains active',()=>{
  const root=mkdtempSync(join(tmpdir(),'runner-outcome-premature-'));
  try{
    const db=new RunnerOutcomeLedger(root),intent=baseline(),snap=db.prepare(intent);
    const claim:OutcomeClaim={domain:'panter.outcome-reconciliation/v1',operationId:intent.operationId,
      intentDigest:snap.intentDigest,leaseGeneration:5,outcome:'SUCCEEDED',evidenceDigest:'e'.repeat(64),
      observedAt:Date.now()};
    rejects(()=>db.reconcile(receipt(claim),keys));
    db.enterEffectWindow(intent.operationId,5,Date.now()+50);
    rejects(()=>db.reconcile(receipt(claim),keys));
    db.close();
  }finally{rmSync(root,{recursive:true,force:true});}
});
test('invalid operation, mutable SHA, mixed fields and unsafe SQLite symlink fail closed',()=>{
  const root=mkdtempSync(join(tmpdir(),'runner-outcome-bad-'));
  try{
    const db=new RunnerOutcomeLedger(root),intent=baseline();
    rejects(()=>db.prepare({...intent,candidateSha:'main'}));
    rejects(()=>db.prepare({...intent,operation:'bash -c whoami' as OutcomeIntent['operation']}));
    rejects(()=>db.prepare({...intent,extra:'unsafe'} as OutcomeIntent));
    db.close();
  }finally{rmSync(root,{recursive:true,force:true});}
  const dir=mkdtempSync(join(tmpdir(),'runner-outcome-symlink-'));
  try{
    writeFileSync(join(dir,'target'),'unchanged',{mode:0o600});
    symlinkSync(join(dir,'target'),join(dir,'runner-outcomes.sqlite'));
    rejects(()=>new RunnerOutcomeLedger(dir));
  }finally{rmSync(dir,{recursive:true,force:true});}
});


test('two separate OS processes racing for the same intent ID commit only once',async()=>{
  const root=mkdtempSync(join(tmpdir(),'runner-outcome-race-'));
  try{
    for(let iteration=0;iteration<3;iteration++){
      const intent=baseline();
      function child(){
        const cp=spawn(process.execPath,['--import','tsx','tests/fixtures/runner-outcome-worker.ts'],{
          cwd:process.cwd(),stdio:['pipe','pipe','pipe'],
        });
        let output='',errors='';
        cp.stdout.setEncoding('utf8');cp.stderr.setEncoding('utf8');
        cp.stdout.on('data',(x:string)=>{output+=x;});
        cp.stderr.on('data',(x:string)=>{errors+=x;});
        let readyResolve!:()=>void,readyReject!:(e:Error)=>void;
        const ready=new Promise<void>((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
        cp.stdout.on('data',(x:string)=>{if(x.includes('READY\n'))readyResolve();});
        cp.once('error',readyReject);
        const done=new Promise<{code:number|null,out:string}>((resolve,reject)=>{
          cp.once('error',reject);
          cp.once('close',code=>resolve({code,out:output}));
        });
        return {ready,done,send:()=>cp.stdin.end(JSON.stringify({root,intent})+'\n'),stop:()=>cp.kill()};
      }
      const a=child(),b=child();
      const timeout=setTimeout(()=>{a.stop();b.stop();},15000);
      try{
        await Promise.all([a.ready,b.ready]);
        a.send();b.send();
        const result=await Promise.all([a.done,b.done]);
        assert.deepEqual(result.map(x=>x.code),[0,0],JSON.stringify(result));
        assert.deepEqual(result.map(x=>x.out.trim().split('\n').at(-1)).sort(),['REJECTED','SUCCESS']);
      }finally{clearTimeout(timeout);a.stop();b.stop();}
    }
    const ledger=new RunnerOutcomeLedger(root);
    ledger.close();
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('writer takeover preserves live EFFECT_WINDOW; readonly inspector never mutates or steals epoch',async()=>{
  const root=mkdtempSync(join(tmpdir(),'runner-outcome-epoch-'));
  try{
    const a=new RunnerOutcomeLedger(root),intent=baseline(),snap=a.prepare(intent);
    const deadline=Date.now()+180;
    a.enterEffectWindow(intent.operationId,5,deadline);
    const observer=RunnerOutcomeLedger.openReadonly(root);
    assert.equal(observer.get(intent.operationId)?.state,'EFFECT_WINDOW');
    rejects(()=>observer.prepare(baseline()));
    rejects(()=>observer.enterEffectWindow(intent.operationId,5,Date.now()+100));
    observer.close();
    const b=new RunnerOutcomeLedger(root);
    assert.equal(b.get(intent.operationId)?.state,'EFFECT_WINDOW');
    assert.equal(a.get(intent.operationId)?.state,'EFFECT_WINDOW');
    rejects(()=>a.prepare(baseline())); // epoch A is fenced
    rejects(()=>a.enterEffectWindow(intent.operationId,5,Date.now()+100));
    const early:OutcomeClaim={domain:'panter.outcome-reconciliation/v1',
      operationId:intent.operationId,intentDigest:snap.intentDigest,leaseGeneration:5,
      outcome:'NO_EFFECT',evidenceDigest:'f'.repeat(64),observedAt:deadline+1};
    rejects(()=>b.reconcile(receipt(early),keys)); // future-dated receipt cannot bypass wall clock
    assert.equal(b.get(intent.operationId)?.state,'EFFECT_WINDOW');
    await new Promise(r=>setTimeout(r,200));
    const late={...early,observedAt:Date.now()};
    assert.equal(b.reconcile(receipt(late),keys).state,'NO_EFFECT');
    assert.equal(a.get(intent.operationId)?.state,'NO_EFFECT');
    b.close();a.close();
  }finally{rmSync(root,{recursive:true,force:true});}
});
test('reconciliation requires observedAt at or after exact effect deadline',async()=>{
  const root=mkdtempSync(join(tmpdir(),'runner-outcome-deadline-'));
  try{
    const a=new RunnerOutcomeLedger(root),intent=baseline(),snap=a.prepare(intent);
    const deadline=Date.now()+65;
    a.enterEffectWindow(intent.operationId,5,deadline);a.close();
    await new Promise(r=>setTimeout(r,85));
    const b=new RunnerOutcomeLedger(root);
    const early:OutcomeClaim={domain:'panter.outcome-reconciliation/v1',operationId:intent.operationId,
      intentDigest:snap.intentDigest,leaseGeneration:5,outcome:'SUCCEEDED',
      evidenceDigest:'e'.repeat(64),observedAt:deadline-1};
    rejects(()=>b.reconcile(receipt(early),keys));
    assert.equal(b.reconcile(receipt({...early,observedAt:deadline}),keys).state,'SUCCEEDED');
    b.close();
  }finally{rmSync(root,{recursive:true,force:true});}
});
test('independent outcome verifier rejects a private PEM and invalid deadline grants',()=>{
  rejects(()=>independentOutcomeKeys({private:pair.privateKey.export({format:'pem',type:'pkcs8'}).toString()}));
  const root=mkdtempSync(join(tmpdir(),'runner-outcome-deadline-bad-'));
  try{
    const db=new RunnerOutcomeLedger(root),intent=baseline();
    db.prepare(intent);
    rejects(()=>db.enterEffectWindow(intent.operationId,5,Date.now()-1000));
    rejects(()=>db.enterEffectWindow(intent.operationId,5,Date.now()+60*60*1000+60_000));
    assert.equal(db.get(intent.operationId)?.state,'INTENT');
    db.close();
  }finally{rmSync(root,{recursive:true,force:true});}
});
