import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { appendFileSync, chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditIntegrityError, RunnerAuditJournal, quarantineRunnerAuditTail, type RunnerAuditEvent } from '../src/core/runner-journal.js';

const digest='c'.repeat(64);
const event=():RunnerAuditEvent=>({
  requestId:randomUUID(), operation:'git.inspect', grantDigest:digest,
  outputDigest:'0'.repeat(64), status:'RESERVED'
});
test('append-only audit survives reopen, maintains sequence/hash and redacts output by schema',()=>{
  const dir=mkdtempSync(join(tmpdir(),'runner-audit-'));
  try {
    const journal=new RunnerAuditJournal(dir);
    const first=journal.append(event()), second=journal.append(event());
    assert.equal(first.seq,1);
    assert.equal(second.seq,2);
    assert.equal(second.previousHash,first.hash);
    assert.equal(journal.verify().entries,2);
    assert.equal(new RunnerAuditJournal(dir).verify().lastHash,second.hash);
    assert.ok(!readFileSync(journal.path,'utf8').includes('password'));
  } finally {rmSync(dir,{recursive:true,force:true})}
});
test('tampered audit fails closed, never quietly rewrites history',()=>{
  const dir=mkdtempSync(join(tmpdir(),'runner-audit-tamper-'));
  try{
    const journal=new RunnerAuditJournal(dir);
    journal.append(event());
    const old=readFileSync(journal.path,'utf8');
    writeFileSync(journal.path,old.replace('"RESERVED"','"SUCCEEDED"'));
    assert.throws(()=>journal.verify(),AuditIntegrityError);
    assert.throws(()=>journal.append(event()),AuditIntegrityError);
    assert.throws(()=>new RunnerAuditJournal(dir),AuditIntegrityError);
  }finally{rmSync(dir,{recursive:true,force:true})}
});
test('arbitrary unredacted messages and unexpected metadata are rejected',()=>{
  const dir=mkdtempSync(join(tmpdir(),'runner-audit-reject-'));
  try{
    const journal=new RunnerAuditJournal(dir);
    const bad={...event(),secret:'TOKEN_SHOULD_NEVER_LOG'};
    assert.throws(()=>journal.append(bad as unknown as RunnerAuditEvent),AuditIntegrityError);
    assert.equal(journal.verify().entries,0);
  }finally{rmSync(dir,{recursive:true,force:true})}
});
test('symlink journal path is denied',()=>{
  const dir=mkdtempSync(join(tmpdir(),'runner-audit-link-'));
  try{
    writeFileSync(join(dir,'target'),'{}',{mode:0o600});
    symlinkSync(join(dir,'target'),join(dir,'runner-audit.jsonl'));
    assert.throws(()=>new RunnerAuditJournal(dir),AuditIntegrityError);
  }finally{rmSync(dir,{recursive:true,force:true})}
});

test('crash-truncated final record is quarantined byte-for-byte; active journal stays locked',()=>{
  const dir=mkdtempSync(join(tmpdir(),'runner-journal-crash-'));
  try {
    const j=new RunnerAuditJournal(dir);
    const prior=j.append(event());
    const fragment=Buffer.from('{"seq":2,"requestId":"INCOMPLETE_SECRET_CANARY');
    appendFileSync(j.path,fragment);
    assert.throws(()=>new RunnerAuditJournal(dir),AuditIntegrityError);
    const before=readFileSync(j.path);
    const evidence=quarantineRunnerAuditTail(dir);
    assert.equal(evidence.status,'OUTCOME_UNKNOWN');
    assert.equal(evidence.prefixEntries,1);
    assert.equal(evidence.prefixLastHash,prior.hash);
    assert.equal(evidence.tailBytes,fragment.length);
    assert.deepEqual(readFileSync(evidence.quarantinedFile),fragment);
    assert.deepEqual(readFileSync(j.path),before);
    assert.equal(statSync(evidence.quarantinedFile).mode&0o777,0o400);
    assert.equal(statSync(evidence.receiptFile).mode&0o777,0o400);
    const receipt=JSON.parse(readFileSync(evidence.receiptFile,'utf8'));
    assert.equal(receipt.originalSha256,evidence.originalSha256);
    assert.ok(!JSON.stringify(receipt).includes('INCOMPLETE_SECRET_CANARY'));
    assert.throws(()=>new RunnerAuditJournal(dir),AuditIntegrityError);
    assert.throws(()=>j.append(event()),AuditIntegrityError);
    // Exact evidence names prevent repeated silent quarantines.
    assert.throws(()=>quarantineRunnerAuditTail(dir),AuditIntegrityError);
  }finally{rmSync(dir,{recursive:true,force:true})}
});
test('internally tampered entries are not quarantinable as a crash tail',()=>{
  const dir=mkdtempSync(join(tmpdir(),'runner-journal-interior-'));
  try{
    const j=new RunnerAuditJournal(dir);
    j.append(event());
    const original=readFileSync(j.path,'utf8');
    writeFileSync(j.path,original.replace('"RESERVED"','"SUCCEEDED"')+'{"partial":true');
    assert.throws(()=>quarantineRunnerAuditTail(dir),AuditIntegrityError);
    assert.equal(readFileSync(j.path,'utf8').includes('"SUCCEEDED"'),true);
  }finally{rmSync(dir,{recursive:true,force:true})}
});
test('clean journal and unrelated malformed complete record are not crash-tail candidates',()=>{
  const dir=mkdtempSync(join(tmpdir(),'runner-journal-clean-'));
  try{
    const j=new RunnerAuditJournal(dir);
    j.append(event());
    assert.throws(()=>quarantineRunnerAuditTail(dir),AuditIntegrityError);
    appendFileSync(j.path,'{"malformed":true}\n');
    assert.throws(()=>quarantineRunnerAuditTail(dir),AuditIntegrityError);
  }finally{rmSync(dir,{recursive:true,force:true})}
});
