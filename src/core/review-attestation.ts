/** Trusted runner attests a real subagent invocation; the model must not own the private key.
 * Ed25519 signatures cover the exact immutable review slot and reported evidence.
 * A distinct subagentRunId without a valid signature is NOT independent execution proof.
 */
import { verify, createPublicKey } from 'node:crypto';
export type RunnerAttestation={keyId:string;signature:string};
export type AttestedReviewSubject={reviewId:string;slotId:string;agentId:string;candidateSha:string;
  packetDigest:string;subagentRunId:string;evidence:string[];findings:unknown[]};
export function attestedMessage(s:AttestedReviewSubject){return Buffer.from(JSON.stringify({schema:'panter.review-run/v1',...s}),'utf8');}
export function verifyRunnerSignature(s:AttestedReviewSubject,proof:RunnerAttestation|undefined,keys:Readonly<Record<string,string>>){
  if(!proof||!Object.prototype.hasOwnProperty.call(keys,proof.keyId)||!/^[-_A-Za-z0-9]{64,128}$/.test(proof.signature))return false;
  try{const key=createPublicKey(keys[proof.keyId]!);if(key.asymmetricKeyType!=='ed25519')return false;
    return verify(null,attestedMessage(s),key,Buffer.from(proof.signature,'base64url'));}catch{return false;}
}
