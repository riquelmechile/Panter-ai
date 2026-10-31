import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
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
    // A complete retry verifies both files and returns the identical receipt.
    assert.deepEqual(quarantineRunnerAuditTail(dir),evidence);
    assert.deepEqual(readFileSync(j.path),before);
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

function damagedJournal(dir:string):{journal:string,tail:Buffer} {
  const j=new RunnerAuditJournal(dir);
  j.append(event());
  const tail=Buffer.from('{"seq":2,"broken":"INCOMPLETE');
  appendFileSync(j.path,tail);
  return {journal:j.path,tail};
}
test('retry after crash between raw bin and JSON receipt completes matching evidence',()=>{
  const dir=mkdtempSync(join(tmpdir(),'runner-quarantine-crash-between-'));
  try {
    const {journal}=damagedJournal(dir);
    const original=readFileSync(journal);
    const evidence=quarantineRunnerAuditTail(dir);
    unlinkSync(evidence.receiptFile);
    const retry=quarantineRunnerAuditTail(dir);
    assert.deepEqual(retry,evidence);
    assert.equal(existsSync(retry.receiptFile),true);
    assert.deepEqual(readFileSync(journal),original);
    assert.throws(()=>new RunnerAuditJournal(dir),AuditIntegrityError);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
test('corrupted partial or replaced bin fails closed without writing receipt',()=>{
  for(const damage of ['short','mismatch','symlink']) {
    const dir=mkdtempSync(join(tmpdir(),'runner-quarantine-corrupt-bin-'));
    try {
      const {journal}=damagedJournal(dir);
      const initial=readFileSync(journal);
      const evidence=quarantineRunnerAuditTail(dir);
      unlinkSync(evidence.receiptFile);
      if(damage==='symlink') {
        unlinkSync(evidence.quarantinedFile);
        symlinkSync(journal,evidence.quarantinedFile);
      } else {
        chmodSync(evidence.quarantinedFile,0o600);
        const original=readFileSync(evidence.quarantinedFile);
        const bytes=damage==='short'?original.subarray(0,-1):Buffer.from(original);
        if(damage==='mismatch')bytes[0]=bytes[0]===0x61?0x62:0x61;
        writeFileSync(evidence.quarantinedFile,bytes);
        chmodSync(evidence.quarantinedFile,0o400);
      }
      assert.throws(()=>quarantineRunnerAuditTail(dir),AuditIntegrityError,damage);
      assert.equal(existsSync(evidence.receiptFile),false);
      assert.deepEqual(readFileSync(journal),initial);
    }finally{rmSync(dir,{recursive:true,force:true});}
  }
});
test('tampered or missing receipt never gets accepted or replaced silently',()=>{
  for(const damage of ['receipt modified','receipt symlink','bin removed']) {
    const dir=mkdtempSync(join(tmpdir(),'runner-quarantine-receipt-tamper-'));
    try {
      const {journal}=damagedJournal(dir);
      const original=readFileSync(journal);
      const evidence=quarantineRunnerAuditTail(dir);
      if(damage==='receipt modified') {
        chmodSync(evidence.receiptFile,0o600);
        writeFileSync(evidence.receiptFile,'{"forged":true}\n');
        chmodSync(evidence.receiptFile,0o400);
      } else if(damage==='receipt symlink') {
        unlinkSync(evidence.receiptFile);
        symlinkSync(journal,evidence.receiptFile);
      } else {
        unlinkSync(evidence.quarantinedFile);
      }
      assert.throws(()=>quarantineRunnerAuditTail(dir),AuditIntegrityError,damage);
      assert.deepEqual(readFileSync(journal),original);
    }finally{rmSync(dir,{recursive:true,force:true});}
  }
});

test('orphan temporary files from interrupted publication never prevent safe retries',()=>{
  const dir=mkdtempSync(join(tmpdir(),'runner-quarantine-temp-crash-'));
  try{
    const {journal}=damagedJournal(dir);
    const before=readFileSync(journal);
    const receipt=quarantineRunnerAuditTail(dir);
    unlinkSync(receipt.receiptFile); // model crash after final bin link
    const orphan=join(dir,'quarantine','.pending-'+randomUUID().replaceAll('-',''));
    writeFileSync(orphan,Buffer.from('incomplete temporary evidence'),{mode:0o400});
    const repeated=quarantineRunnerAuditTail(dir);
    assert.deepEqual(repeated,receipt);
    assert.equal(existsSync(orphan),true); // never silently purge alleged evidence
    assert.deepEqual(readFileSync(journal),before);
    assert.throws(()=>new RunnerAuditJournal(dir),AuditIntegrityError);
    assert.deepEqual(quarantineRunnerAuditTail(dir),receipt);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('publishing evidence leaves only complete final files, not pending names',()=>{
  const dir=mkdtempSync(join(tmpdir(),'runner-quarantine-atomic-'));
  try{
    damagedJournal(dir);
    const report=quarantineRunnerAuditTail(dir);
    assert.deepEqual(readdirSync(join(dir,'quarantine')).sort(),[
      report.quarantinedFile.split('/').at(-1)!, report.receiptFile.split('/').at(-1)!,
    ].sort());
    assert.equal(statSync(report.quarantinedFile).mode&0o777,0o400);
    assert.equal(statSync(report.receiptFile).mode&0o777,0o400);
    assert.deepEqual(quarantineRunnerAuditTail(dir),report);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('zero-byte or partially written FINAL bin and JSON remain tamper evidence and fail closed',()=>{
  for(const kind of ['bin','json'] as const){
    for(const partial of [false,true]){
      const dir=mkdtempSync(join(tmpdir(),'runner-quarantine-unsafe-final-'));
      try{
        const {journal}=damagedJournal(dir);
        const original=readFileSync(journal);
        const report=quarantineRunnerAuditTail(dir);
        const victim=kind==='bin'?report.quarantinedFile:report.receiptFile;
        chmodSync(victim,0o600);
        const originalEvidence=readFileSync(victim);
        const damaged=partial?originalEvidence.subarray(0,Math.max(1,originalEvidence.length>>1)):Buffer.alloc(0);
        writeFileSync(victim,damaged);
        chmodSync(victim,0o400);
        assert.throws(()=>quarantineRunnerAuditTail(dir),AuditIntegrityError);
        assert.deepEqual(readFileSync(victim),damaged);
        assert.deepEqual(readFileSync(journal),original);
      }finally{rmSync(dir,{recursive:true,force:true});}
    }
  }
});
