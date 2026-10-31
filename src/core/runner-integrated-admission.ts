/**
 * Integrated admission ONLY, no external effect execution. Combines grant
 * anti-replay, durable intent and independent remote audit seal under a single
 * durable SQLite writer fence. Any crash is fail-closed; no automatic replay.
 */
import {createHash,type KeyObject} from 'node:crypto';
import {grantPayload,verifyRunnerGrant,type RunnerGrantContext,
  type SignedRunnerGrant,RunnerGrantLedger} from './runner-grants.js';
import {RunnerOutcomeLedger,type OutcomeIntent} from './runner-outcomes.js';
import {AsyncSegmentedRunnerAudit} from './runner-seal-http.js';
import {RunnerWriterFence,WriterFenced} from './runner-writer-fence.js';

const ZERO='0'.repeat(64);
export class RunnerIntegratedAdmission{
  constructor(
    private readonly fence:RunnerWriterFence,
    private readonly grants:RunnerGrantLedger,
    private readonly outcomes:RunnerOutcomeLedger,
    private readonly audit:AsyncSegmentedRunnerAudit,
  ){}
  /** Fail-closed pre-effect admission. NEVER execute or issue an effect permit. */
  async prepareSignedIntent(
    grant:SignedRunnerGrant,publicKeys:ReadonlyMap<string,KeyObject>,
    ctx:RunnerGrantContext,intent:OutcomeIntent,now=Date.now(),
  ):Promise<{status:'INTENT_SEALED';operationId:string;sealed:number}>{
    this.fence.assertCurrent();
    const claim=verifyRunnerGrant(grant,publicKeys,now);
    const signature=Buffer.from(grant.signature,'base64url');
    const digest=createHash('sha256').update(grantPayload(claim)).update(signature).digest('hex');
    if(!Number.isSafeInteger(now)||intent.operationId===claim.grantId||
       intent.subject!==ctx.subject||intent.repository!==ctx.repository||
       intent.candidateSha!==ctx.candidateSha||intent.missionId!==ctx.missionId||
       intent.workId!==ctx.workId||intent.attemptId!==ctx.attemptId||
       intent.leaseGeneration!==ctx.leaseGeneration||intent.operation!==ctx.operation||
       intent.grantDigest!==digest||claim.repository!==intent.repository||
       claim.candidateSha!==intent.candidateSha||claim.subject!==intent.subject||
       claim.leaseGeneration!==intent.leaseGeneration||claim.missionId!==intent.missionId||
       claim.workId!==intent.workId||claim.attemptId!==intent.attemptId||
       !claim.operations.includes(intent.operation))throw new WriterFenced();
    // Deny replays first; no retry if any subsequent step has uncertain outcome.
    this.grants.reserve(grant,publicKeys,ctx,intent.operationId,now);
    this.fence.assertCurrent();
    this.outcomes.prepare(intent);
    this.fence.assertCurrent();
    await this.audit.append({requestId:intent.operationId,operation:intent.operation,
      grantDigest:digest,status:'RESERVED',outputDigest:ZERO});
    // Seal before returning. No effect window is opened by this library.
    await this.audit.sealCurrent();
    this.fence.assertCurrent();
    return {status:'INTENT_SEALED',operationId:intent.operationId,
      sealed:this.audit.state().sealed};
  }
}
