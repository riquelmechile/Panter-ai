/**
 * Runner audit journal v1 — fixed metadata only, never arbitrary stdout,
 * environment variables, tokens, prompt text or client-supplied messages.
 * Single-writer by design. A trusted off-host seal is required for tamper
 * resistance; this local hash chain alone is not an immutable audit log.
 */
import { createHash } from 'node:crypto';
import { closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, statSync, writeSync } from 'node:fs';
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
function parseLines(file: string): RunnerAuditLine[] {
  if (!existsSync(file)) return [];
  const content=readFileSync(file,'utf8');
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
