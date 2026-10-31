import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditIntegrityError, RunnerAuditJournal, type RunnerAuditEvent } from '../src/core/runner-journal.js';

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
