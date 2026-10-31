/**
 * Phase-2 protocol parser only. No socket/dispatcher/executor is exported.
 * A future privileged transport must derive the actor and peer UID from
 * verified server state (not from this caller-supplied message).
 */
import { RUNNER_OPERATIONS, type RunnerOperation } from './runner-grants.js';

export interface RunnerIntent {
  version: 1;
  requestId: string;
  operation: RunnerOperation;
  repository: string;
  candidateSha: string;
  workId: string;
  attemptId: string;
  arguments: Record<string,never>;
}

export class InvalidRunnerIntent extends Error {
  constructor() { super('Invalid runner intent'); this.name='InvalidRunnerIntent'; }
}
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA=/^[a-f0-9]{40}$/;
const REPO=/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const ID=/^[A-Za-z0-9_.:@-]{1,160}$/;
export const RUNNER_MESSAGE_MAX_BYTES=16*1024;
/** Deny unknown fields and free-form argv. The first slice accepts no operation arguments. */
export function parseRunnerIntent(raw: unknown): RunnerIntent {
  if (typeof raw !== 'string' || Buffer.byteLength(raw,'utf8') > RUNNER_MESSAGE_MAX_BYTES) throw new InvalidRunnerIntent();
  let data: unknown;
  try { data=JSON.parse(raw); } catch { throw new InvalidRunnerIntent(); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new InvalidRunnerIntent();
  const x=data as Record<string,unknown>;
  const fields=['version','requestId','operation','repository','candidateSha','workId','attemptId','arguments'];
  if (Object.keys(x).sort().join('|')!==fields.sort().join('|') ||
      x.version!==1 || typeof x.requestId!=='string' || !UUID.test(x.requestId) ||
      typeof x.operation!=='string' || !RUNNER_OPERATIONS.includes(x.operation as RunnerOperation) ||
      typeof x.repository!=='string' || !REPO.test(x.repository) ||
      typeof x.candidateSha!=='string' || !SHA.test(x.candidateSha) ||
      typeof x.workId!=='string' || !ID.test(x.workId) ||
      typeof x.attemptId!=='string' || !ID.test(x.attemptId) ||
      !x.arguments || typeof x.arguments !== 'object' || Array.isArray(x.arguments) ||
      Object.keys(x.arguments).length !== 0) throw new InvalidRunnerIntent();
  return x as unknown as RunnerIntent;
}
/** An intentional fail-closed placeholder. An effectful dispatch cannot be enabled by a message. */
export function runnerExecutionAvailable(): false { return false; }
