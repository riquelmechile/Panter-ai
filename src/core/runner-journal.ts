/**
 * Runner audit journal v1 — fixed metadata only, never arbitrary stdout,
 * environment variables, tokens, prompt text or client-supplied messages.
 * Single-writer by design. A trusted off-host seal is required for tamper
 * resistance; this local hash chain alone is not an immutable audit log.
 */
import { createHash } from 'node:crypto';
import { closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, statSync, writeSync, fstatSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { RUNNER_OPERATIONS, type RunnerOperation } from './runner-grants.js';

const SHA=/^[0-9a-f]{64}$/;
const REQ=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ZERO='0'.repeat(64);
const O_NOFOLLOW=constants.O_NOFOLLOW??0;

export interface RunnerAuditEvent {
  requestId: string;
  operation: RunnerOperation;
  grantDigest: string;
  status: 'RESERVED'|'DENIED'|'SUCCEEDED'|'FAILED'|'QUARANTINED';
  outputDigest: string;
}
export interface RunnerAuditLine extends RunnerAuditEvent {
  seq: number;
  previousHash: string;
  hash: string;
}
export class AuditIntegrityError extends Error {
  constructor() { super('Runner audit integrity failure'); this.name='AuditIntegrityError'; }
}
function hashBody(row: Omit<RunnerAuditLine,'hash'>): string {
  return createHash('sha256').update(JSON.stringify(row),'utf8').digest('hex');
}
function validateEvent(event: RunnerAuditEvent) {
  if (!event || typeof event !== 'object' ||
    Object.keys(event).sort().join('|') !== ['grantDigest','operation','outputDigest','requestId','status'].sort().join('|') ||
    !REQ.test(event.requestId) || !RUNNER_OPERATIONS.includes(event.operation) ||
    !SHA.test(event.grantDigest) || !SHA.test(event.outputDigest) ||
    !['RESERVED','DENIED','SUCCEEDED','FAILED','QUARANTINED'].includes(event.status)) throw new AuditIntegrityError();
}
function parseAuditText(content: string): RunnerAuditLine[] {
  if (!content) return [];
  if (!content.endsWith('\n') || Buffer.byteLength(content,'utf8')>16*1024*1024) throw new AuditIntegrityError();
  const lines: RunnerAuditLine[]=[];
  let prev=ZERO;
  try {
    for (const entry of content.trimEnd().split('\n')) {
      const line=JSON.parse(entry) as RunnerAuditLine;
      if (!line || typeof line !== 'object' || Array.isArray(line) ||
        Object.keys(line).sort().join('|') !== ['seq','previousHash','hash','requestId','operation','grantDigest','status','outputDigest'].sort().join('|') ||
        !Number.isSafeInteger(line.seq) || line.seq!==lines.length+1 ||
        line.previousHash!==prev || !SHA.test(line.hash)) throw new AuditIntegrityError();
      validateEvent({requestId:line.requestId,operation:line.operation,grantDigest:line.grantDigest,status:line.status,outputDigest:line.outputDigest});
      const {hash,...body}=line;
      if (hashBody(body)!==hash) throw new AuditIntegrityError();
      lines.push(line);
      prev=hash;
    }
  } catch { throw new AuditIntegrityError(); }
  return lines;
}
function parseLines(file: string): RunnerAuditLine[] {
  if (!existsSync(file)) return [];
  return parseAuditText(readFileSync(file,'utf8'));
}

/** Evidence-only crash tail quarantine. Does NOT truncate, repair, or resume the journal. */
export interface QuarantinedRunnerTail {
  status: 'OUTCOME_UNKNOWN';
  originalSha256: string;
  originalBytes: number;
  prefixEntries: number;
  prefixLastHash: string;
  tailSha256: string;
  tailBytes: number;
  quarantinedFile: string;
  receiptFile: string;
}

export function quarantineRunnerAuditTail(dir: string): QuarantinedRunnerTail {
  const root=resolve(dir);
  const owner=statSync(root);
  if (!owner.isDirectory() || owner.uid!==process.getuid?.() || (owner.mode&0o077)!==0) throw new AuditIntegrityError();
  const original=join(root,'runner-audit.jsonl');
  const fd=openSync(original,constants.O_RDONLY|O_NOFOLLOW);
  let bytes:Buffer;
  try {
    const stat=fstatSync(fd);
    if (!stat.isFile() || stat.uid!==process.getuid?.() || (stat.mode&0o077)!==0 || stat.size>16*1024*1024) {
      throw new AuditIntegrityError();
    }
    bytes=readFileSync(fd);
    const after=fstatSync(fd);
    if (after.size!==stat.size || after.mtimeMs!==stat.mtimeMs) throw new AuditIntegrityError();
  } finally {closeSync(fd);}
  if (bytes.length===0 || bytes.at(-1)===10) throw new AuditIntegrityError();
  const lastBreak=bytes.lastIndexOf(10);
  const prefix=bytes.subarray(0,lastBreak+1);
  const tail=bytes.subarray(lastBreak+1);
  if (!tail.length) throw new AuditIntegrityError();
  let completeText:string;
  try {completeText=new TextDecoder('utf-8',{fatal:true}).decode(prefix);}
  catch {throw new AuditIntegrityError();}
  // The entire complete prefix must validate; internal corruption is never treated
  // as a recoverable trailing fragment.
  const validated=parseAuditText(completeText);
  const fullDigest=createHash('sha256').update(bytes).digest('hex');
  const tailDigest=createHash('sha256').update(tail).digest('hex');
  const quarantine=join(root,'quarantine');
  mkdirSync(quarantine,{mode:0o700,recursive:true});
  const qstat=lstatSync(quarantine);
  if (!qstat.isDirectory() || qstat.isSymbolicLink() ||
      qstat.uid!==process.getuid?.() || (qstat.mode&0o077)!==0) throw new AuditIntegrityError();
  const prefixName='runner-tail-'+fullDigest;
  const quarantinedFile=join(quarantine,prefixName+'.bin');
  const receiptFile=join(quarantine,prefixName+'.json');
  const report:QuarantinedRunnerTail={
    status:'OUTCOME_UNKNOWN',originalSha256:fullDigest,originalBytes:bytes.length,
    prefixEntries:validated.length,prefixLastHash:validated.at(-1)?.hash??ZERO,
    tailSha256:tailDigest,tailBytes:tail.length,quarantinedFile,receiptFile,
  };
  /** Return true only if a previously created evidence file is byte-exact. */
  function verifyExisting(target:string,payload:Buffer):boolean {
    let evidenceFd:number;
    try {
      // O_NONBLOCK prevents an attacker-created FIFO from blocking the recovery.
      evidenceFd=openSync(target,constants.O_RDONLY|O_NOFOLLOW|constants.O_NONBLOCK);
    }catch(e){
      if ((e as NodeJS.ErrnoException).code==='ENOENT') return false;
      throw new AuditIntegrityError();
    }
    try {
      const first=fstatSync(evidenceFd);
      if (!first.isFile() || first.isSymbolicLink() ||
          first.uid!==process.getuid?.() || (first.mode&0o777)!==0o400 ||
          first.size!==payload.length) throw new AuditIntegrityError();
      const actual=readFileSync(evidenceFd);
      const after=fstatSync(evidenceFd);
      if (!actual.equals(payload) || first.size!==after.size ||
          first.mtimeMs!==after.mtimeMs) throw new AuditIntegrityError();
      return true;
    }finally{closeSync(evidenceFd);}
  }
  function ensureEvidence(target:string,payload:Buffer):void {
    if (verifyExisting(target,payload)) return;
    let evidenceFd:number;
    try {
      evidenceFd=openSync(target,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|O_NOFOLLOW,0o400);
    }catch(e) {
      // Another writer may have created it; only an exact verified copy is safe.
      if ((e as NodeJS.ErrnoException).code==='EEXIST' && verifyExisting(target,payload)) return;
      throw new AuditIntegrityError();
    }
    try {
      let offset=0;
      while(offset<payload.length){
        const written=writeSync(evidenceFd,payload,offset,payload.length-offset);
        if (written<=0) throw new AuditIntegrityError();
        offset+=written;
      }
      fsyncSync(evidenceFd);
    }finally{closeSync(evidenceFd);}
    if (!verifyExisting(target,payload)) throw new AuditIntegrityError();
  }
  try {
    // The raw tail can contain broken UTF-8; preserve exact bytes, never log it.
    const receiptPayload=Buffer.from(JSON.stringify(report)+'\n','utf8');
    const savedBin=verifyExisting(quarantinedFile,tail);
    const savedReceipt=verifyExisting(receiptFile,receiptPayload);
    // A receipt without its evidence is an inconsistent state, not a crash
    // window we can auto-heal. Refuse silently recreating missing evidence.
    if (savedReceipt && !savedBin) throw new AuditIntegrityError();
    ensureEvidence(quarantinedFile,tail);
    ensureEvidence(receiptFile,receiptPayload);
    const dirFd=openSync(quarantine,constants.O_RDONLY|constants.O_DIRECTORY|O_NOFOLLOW);
    try{fsyncSync(dirFd);}finally{closeSync(dirFd);}
  }catch{throw new AuditIntegrityError();}
  // The active journal remains untouched. It still fails closed on construction/
  // append until an independently reviewed recovery and effect reconciliation.
  return report;
}
export class RunnerAuditJournal {
  readonly path: string;
  constructor(dir:string) {
    const root=resolve(dir);
    mkdirSync(root,{recursive:true,mode:0o700});
    const stat=statSync(root);
    if ((stat.mode&0o077)!==0 || stat.uid!==process.getuid?.()) throw new AuditIntegrityError();
    this.path=join(root,'runner-audit.jsonl');
    try {
      const fd=openSync(this.path,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|O_NOFOLLOW,0o600);
      closeSync(fd);
    } catch(err) {
      if ((err as NodeJS.ErrnoException).code!=='EEXIST') throw new AuditIntegrityError();
    }
    const f=lstatSync(this.path);
    if (!f.isFile() || f.isSymbolicLink() || (f.mode&0o077)!==0 || f.uid!==process.getuid?.()) throw new AuditIntegrityError();
    parseLines(this.path);
  }
  append(event:RunnerAuditEvent):RunnerAuditLine {
    validateEvent(event);
    // Read and recheck before append, so obvious tampering fails closed.
    // Future service must enforce one writer and external journal sealing.
    const existing=parseLines(this.path);
    const body={...event,seq:existing.length+1,previousHash:existing.at(-1)?.hash??ZERO};
    const row={...body,hash:hashBody(body)};
    const fd=openSync(this.path,constants.O_APPEND|constants.O_WRONLY|O_NOFOLLOW);
    try {
      writeSync(fd,JSON.stringify(row)+'\n');
      fsyncSync(fd);
    } catch { throw new AuditIntegrityError(); }
    finally { closeSync(fd); }
    return row;
  }
  verify():{entries:number,lastHash:string} {
    const rows=parseLines(this.path);
    return {entries:rows.length,lastHash:rows.at(-1)?.hash??ZERO};
  }
}
