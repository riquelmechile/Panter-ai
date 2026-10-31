import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GrantRejected, RunnerGrantLedger, grantPayload, parseGrant, pinnedRunnerKeys,
  verifyRunnerGrant, type RunnerGrant, type RunnerGrantContext, type SignedRunnerGrant,
} from '../src/core/runner-grants.js';

const sha='a'.repeat(40);
const keys=generateKeyPairSync('ed25519');
const other=generateKeyPairSync('ed25519');
const pinned=pinnedRunnerKeys({'panter-owner-1':keys.publicKey.export({format:'pem',type:'spki'}).toString()});
const now=Date.now();
function claims(override:Partial<RunnerGrant>={}):RunnerGrant {
  return {version:1, grantId:randomUUID(), issuer:'panter-ai', audience:'panter-runner',
    subject:'gpt-a', missionId:'mission-1', workId:'work-1',attemptId:'attempt-1',
    leaseGeneration:1,repository:'riquelmechile/Panter-ai',candidateSha:sha,
    notBefore:now-1000,expiresAt:now+60_000,maxUses:1,operations:['workspace.prepare'],
    paths:['src/core'],effectClass:'WORKTREE_WRITE',...override};
}
function signed(x:RunnerGrant, privateKey=keys.privateKey):SignedRunnerGrant {
  return {keyId:'panter-owner-1',claims:x,signature:sign(null,grantPayload(x),privateKey).toString('base64url')};
}
const ctx:RunnerGrantContext={subject:'gpt-a',missionId:'mission-1',workId:'work-1',
  attemptId:'attempt-1',leaseGeneration:1,repository:'riquelmechile/Panter-ai',
  candidateSha:sha,operation:'workspace.prepare',effectClass:'WORKTREE_WRITE'};
const rejects=(fn:()=>unknown)=>assert.throws(fn,GrantRejected);

test('valid Ed25519 grant reserves once and survives SQLite restart',()=>{
  const dir=mkdtempSync(join(tmpdir(),'runner-grants-'));
  try {
    const grant=signed(claims());
    assert.equal(verifyRunnerGrant(grant,pinned,now).subject,'gpt-a');
    const ledger=new RunnerGrantLedger(dir);
    ledger.reserve(grant,pinned,ctx,randomUUID(),now);
    ledger.close();
    const reopened=new RunnerGrantLedger(dir);
    rejects(()=>reopened.reserve(grant,pinned,ctx,randomUUID(),now));
    reopened.close();
  } finally {rmSync(dir,{recursive:true,force:true})}
});
test('signed READ may permit bounded uses but request ID is single-use',()=>{
  const dir=mkdtempSync(join(tmpdir(),'runner-read-'));
  try {
    const grant=signed(claims({maxUses:2,operations:['git.inspect'],effectClass:'READ'}));
    const readCtx={...ctx,operation:'git.inspect',effectClass:'READ'} as const;
    const db=new RunnerGrantLedger(dir);
    const req=randomUUID();
    db.reserve(grant,pinned,readCtx,req,now);
    rejects(()=>db.reserve(grant,pinned,readCtx,req,now));
    db.reserve(grant,pinned,readCtx,randomUUID(),now);
    rejects(()=>db.reserve(grant,pinned,readCtx,randomUUID(),now));
    db.close();
  } finally {rmSync(dir,{recursive:true,force:true})}
});
test('rejects forged Ed25519, modified claims, mismatched identity/SHA/lease and expiry',()=>{
  const value=claims();
  const env=signed(value);
  rejects(()=>verifyRunnerGrant(signed(value,other.privateKey),pinned,now));
  rejects(()=>verifyRunnerGrant({...env,claims:{...value,subject:'grok'}},pinned,now));
  rejects(()=>verifyRunnerGrant(env,pinned,value.expiresAt));
  rejects(()=>verifyRunnerGrant({...env,keyId:'unknown'},pinned,now));
  const dir=mkdtempSync(join(tmpdir(),'runner-scope-'));
  try {
    const db=new RunnerGrantLedger(dir);
    rejects(()=>db.reserve(env,pinned,{...ctx,subject:'claude'},randomUUID(),now));
    rejects(()=>db.reserve(env,pinned,{...ctx,candidateSha:'b'.repeat(40)},randomUUID(),now));
    rejects(()=>db.reserve(env,pinned,{...ctx,leaseGeneration:2},randomUUID(),now));
    rejects(()=>db.reserve(env,pinned,{...ctx,operation:'release.request',effectClass:'RELEASE'},randomUUID(),now));
    db.reserve(env,pinned,ctx,randomUUID(),now);
    db.close();
  } finally {rmSync(dir,{recursive:true,force:true})}
});
test('fails closed on traversal, unknown fields, implicit shell, mixed effects and inflated uses',()=>{
  const bad=[
    {...claims(),paths:['../../etc']},
    {...claims(),paths:['/etc/passwd']},
    {...claims(),paths:['src\\etc']},
    {...claims(),operations:['sh -c pwd']},
    {...claims(),operations:['git.inspect','test.run'],effectClass:'READ'},
    {...claims(),maxUses:2},
    {...claims(),issuer:'model'},
    {...claims(),extra:'ignored'},
    {...claims(),expiresAt:now+2*60*60*1000},
  ];
  for(const item of bad) rejects(()=>parseGrant(item));
});
test('rejects empty pinset and non-ed25519 keys',()=>{
  rejects(()=>pinnedRunnerKeys({}));
  const rsa=generateKeyPairSync('rsa',{modulusLength:2048});
  rejects(()=>pinnedRunnerKeys({bad:rsa.publicKey.export({format:'pem',type:'spki'}).toString()}));
});
test('does not open a symlinked ledger database',()=>{
  const dir=mkdtempSync(join(tmpdir(),'runner-symlink-'));
  const target=join(dir,'target');
  try {
    writeFileSync(target,'untouched',{mode:0o600});
    symlinkSync(target,join(dir,'runner-grants.sqlite'));
    rejects(()=>new RunnerGrantLedger(dir));
  } finally {rmSync(dir,{recursive:true,force:true})}
});
