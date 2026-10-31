import assert from 'node:assert/strict';
import {test} from 'node:test';
import {generateKeyPairSync,randomUUID,sign} from 'node:crypto';
import {appendFileSync,mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {RunnerAuditJournal,AuditIntegrityError} from '../src/core/runner-journal.js';
import {stageLegacyAuditCutover} from '../src/core/runner-audit-cutover.js';
import {segmentSealPayload,segmentSealDigest,SegmentIntegrityError,type SegmentSealClaim,type SignedSegmentSeal} from '../src/core/runner-segments.js';
import type {AsyncSealAuthority} from '../src/core/runner-seal-http.js';

const pair=generateKeyPairSync('ed25519');
const pins=new Map([['external',pair.publicKey]]);
const grantDigest='a'.repeat(64),outputDigest='b'.repeat(64);
const event=()=>({requestId:randomUUID(),operation:'git.inspect' as const,
  grantDigest,status:'RESERVED' as const,outputDigest});
class FakeRemote implements AsyncSealAuthority{
  readonly seals=new Map<number,SignedSegmentSeal>();
  failNext=false;
  async latest(){return this.seals.get(this.seals.size)??null;}
  async get(n:number){return this.seals.get(n)??null;}
  async seal(claim:SegmentSealClaim,payload:Buffer){
    if(this.failNext){this.failNext=false;throw new SegmentIntegrityError();}
    if(payload.length!==claim.bytes)throw new SegmentIntegrityError();
    const current=this.seals.get(claim.segment);
    if(current)return current;
    if(claim.segment!==this.seals.size+1)throw new SegmentIntegrityError();
    const previous=this.seals.get(this.seals.size);
    if(claim.previousSealHash!==(previous?segmentSealDigest(previous):'0'.repeat(64)))
      throw new SegmentIntegrityError();
    const seal={keyId:'external',claim,signature:sign(null,segmentSealPayload(claim),
      pair.privateKey).toString('base64url')};
    this.seals.set(claim.segment,seal);
    return seal;
  }
}
test('offline legacy snapshot is copied to sealed segments, original unchanged and restart idempotent',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'runner-cutover-'));
  try{
    const source=join(dir,'legacy'),target=join(dir,'staging'),remote=new FakeRemote();
    const old=new RunnerAuditJournal(source);
    for(let i=0;i<7;i++)old.append(event());
    const original=readFileSync(old.path);
    const report=await stageLegacyAuditCutover(source,target,remote,pins,650);
    assert.equal(report.legacyEntries,7);
    assert.equal(report.segmentEntries,7);
    assert.ok(report.sealedSegments>=2);
    assert.deepEqual(readFileSync(old.path),original);
    assert.equal(JSON.parse(readFileSync(join(target,'cutover-staging.json'),'utf8')).externalSealDigest,
      report.externalSealDigest);
    assert.deepEqual(await stageLegacyAuditCutover(source,target,remote,pins,650),report);
    assert.deepEqual(readFileSync(old.path),original);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('network failure leaves staging recoverable and never changes legacy source',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'runner-cutover-loss-'));
  try{
    const source=join(dir,'legacy'),target=join(dir,'staging'),remote=new FakeRemote();
    const old=new RunnerAuditJournal(source);
    old.append(event());old.append(event());
    const raw=readFileSync(old.path);
    remote.failNext=true;
    await assert.rejects(()=>stageLegacyAuditCutover(source,target,remote,pins,650));
    assert.deepEqual(readFileSync(old.path),raw);
    const receipt=await stageLegacyAuditCutover(source,target,remote,pins,650);
    assert.equal(receipt.segmentEntries,2);
    assert.deepEqual(readFileSync(old.path),raw);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('legacy tail corruption refuses cutover and cannot be silently repaired',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'runner-cutover-corrupt-'));
  try{
    const source=join(dir,'legacy'),target=join(dir,'staging'),remote=new FakeRemote();
    const old=new RunnerAuditJournal(source);old.append(event());
    appendFileSync(old.path,'{"partial":');
    await assert.rejects(()=>stageLegacyAuditCutover(source,target,remote,pins),AuditIntegrityError);
    assert.equal(remote.seals.size,0);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

// The final remote receipt must be verified even if the initial anchor was sound.
test('forged final latest seal refuses publishing cutover staging manifest',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'runner-cutover-forged-latest-'));
  try{
    const source=join(dir,'legacy'),target=join(dir,'staging'),remote=new FakeRemote();
    const old=new RunnerAuditJournal(source);
    old.append(event());
    const latest=remote.latest.bind(remote);
    let reads=0;
    remote.latest=async()=>{
      const receipt=await latest();
      reads++;
      if(reads>=2&&receipt){
        const last=receipt.signature.slice(-1);
        return {...receipt,signature:receipt.signature.slice(0,-1)+(last==='A'?'E':'A')};
      }
      return receipt;
    };
    await assert.rejects(()=>stageLegacyAuditCutover(source,target,remote,pins,650),SegmentIntegrityError);
    assert.equal(remote.seals.size,1);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
