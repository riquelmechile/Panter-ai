/**
 * Offline evidence consistency check only. It NEVER freezes a writer, changes
 * the live journal, reclaims a fence, dispatches work or approves cutover.
 * Read-only by design: no AsyncSegmentedRunnerAudit.open (which may write).
 */
import {createHash,type KeyObject} from 'node:crypto';
import {closeSync,constants,fstatSync,lstatSync,openSync,readFileSync,readdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {snapshotRunnerAudit} from './runner-journal.js';
import {RunnerOutcomeLedger} from './runner-outcomes.js';
import type {AsyncSealAuthority} from './runner-seal-http.js';
import {inspectSeal,segmentSealDigest,SegmentIntegrityError,verifySegmentPrefix,
  type SegmentSealClaim} from './runner-segments.js';
import type {RunnerAuditStagingReceipt} from './runner-audit-cutover.js';

const ZERO='0'.repeat(64);
const NOFOLLOW=constants.O_NOFOLLOW??0;
const HEX=/^[0-9a-f]{64}$/;
const FIELDS=['domain','legacySha256','legacyBytes','legacyEntries','legacyLastHash',
  'segmentEntries','sealedSegments','lastHash','externalSealDigest','segmentDirectory'];
export type CutoverPreflightEvidence={
  status:'EVIDENCE_CONSISTENT_NOT_AUTHORIZED';
  legacySha256:string;
  externalSealDigest:string;
  sealedSegments:number;
  entries:number;
  terminalOutcomes:number;
  requiresWriterFreeze:true;
  requiresIndependentEffectReconciliation:true;
  permitsCutover:false;
};
function safeDir(root:string):void{
  const s=lstatSync(root);
  if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid?.()||
     (s.mode&0o077)!==0)throw new SegmentIntegrityError();
}
function readSecure(path:string,maxBytes:number):Buffer{
  const fd=openSync(path,constants.O_RDONLY|NOFOLLOW|constants.O_NONBLOCK);
  try{
    const before=fstatSync(fd);
    if(!before.isFile()||before.uid!==process.getuid?.()||(before.mode&0o077)!==0||
      before.size<0||before.size>maxBytes)throw new SegmentIntegrityError();
    const bytes=readFileSync(fd);
    const after=fstatSync(fd);
    if(bytes.length!==before.size||after.ino!==before.ino||
      after.size!==before.size||after.mtimeMs!==before.mtimeMs)throw new SegmentIntegrityError();
    return bytes;
  }finally{closeSync(fd);}
}
function manifestOf(bytes:Buffer):RunnerAuditStagingReceipt{
  let obj:unknown;
  try{obj=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}
  catch{throw new SegmentIntegrityError();}
  if(obj===null||typeof obj!=='object'||Array.isArray(obj))throw new SegmentIntegrityError();
  const v=obj as Record<string,unknown>;
  if(Object.keys(v).sort().join('|')!==FIELDS.slice().sort().join('|')||
    v.domain!=='panter.runner-audit-cutover-staging/v1'||
    v.segmentDirectory!=='segments'||typeof v.legacySha256!=='string'||!HEX.test(v.legacySha256)||
    typeof v.legacyLastHash!=='string'||!HEX.test(v.legacyLastHash)||
    typeof v.lastHash!=='string'||!HEX.test(v.lastHash)||
    typeof v.externalSealDigest!=='string'||!HEX.test(v.externalSealDigest)||
    !Number.isSafeInteger(v.legacyBytes)||(v.legacyBytes as number)<=0||
    !Number.isSafeInteger(v.legacyEntries)||(v.legacyEntries as number)<=0||
    !Number.isSafeInteger(v.segmentEntries)||(v.segmentEntries as number)<=0||
    !Number.isSafeInteger(v.sealedSegments)||(v.sealedSegments as number)<=0)
    throw new SegmentIntegrityError();
  return v as RunnerAuditStagingReceipt;
}
/** Verify EVERY signed historical segment, plus exactly one empty active file. */
async function inspectAllSegments(dir:string,remote:AsyncSealAuthority,
  pinned:ReadonlyMap<string,KeyObject>,expectedSegments:number){
  safeDir(dir);
  const names=readdirSync(dir).sort();
  const allowed=new Set(['seal-checkpoint.json']);
  for(let i=1;i<=expectedSegments+1;i++)
    allowed.add('segment-'+String(i).padStart(8,'0')+'.jsonl');
  if(names.length<expectedSegments+1||names.some(n=>!allowed.has(n)))
    throw new SegmentIntegrityError();
  if(names.filter(n=>n.startsWith('segment-')).length!==expectedSegments+1)
    throw new SegmentIntegrityError();
  if(names.includes('seal-checkpoint.json'))readSecure(join(dir,'seal-checkpoint.json'),256*1024*1024);
  const latest=await remote.latest();
  if(!latest||latest.claim.segment!==expectedSegments)
    throw new SegmentIntegrityError();
  inspectSeal(latest,pinned,latest.claim);
  let nextSeq=1,lastHash=ZERO,sealHash=ZERO;
  for(let i=1;i<=expectedSegments;i++){
    const buf=readSecure(join(dir,'segment-'+String(i).padStart(8,'0')+'.jsonl'),2*1024*1024);
    if(!buf.length||buf.at(-1)!==10)throw new SegmentIntegrityError();
    const start=nextSeq,priorSeal=sealHash;
    const verified=verifySegmentPrefix(buf,i,start,lastHash,priorSeal);
    if(verified.entries<1)throw new SegmentIntegrityError();
    nextSeq+=verified.entries;lastHash=verified.lastHash;
    const claim:SegmentSealClaim={domain:'panter.segment-seal/v1',segment:i,
      firstSequence:start,lastSequence:nextSeq-1,lastHash,
      previousSealHash:priorSeal,
      contentSha256:createHash('sha256').update(buf).digest('hex'),bytes:buf.length};
    const receipt=await remote.get(i);
    if(!receipt)throw new SegmentIntegrityError();
    sealHash=segmentSealDigest(inspectSeal(receipt,pinned,claim));
  }
  if(sealHash!==segmentSealDigest(latest))throw new SegmentIntegrityError();
  const active=readSecure(join(dir,'segment-'+String(expectedSegments+1).padStart(8,'0')+'.jsonl'),2*1024*1024);
  if(active.length!==0)throw new SegmentIntegrityError();
  const end=await remote.latest();
  if(!end||segmentSealDigest(inspectSeal(end,pinned,end.claim))!==sealHash)
    throw new SegmentIntegrityError();
  return {entries:nextSeq-1,lastHash,sealHash};
}
/**
 * A read-only preflight is not a cutover permit. Kernel proof of writer
 * quiescence, external effect reconciliation and operational approval remain
 * separate mandatory gates even when all evidence is consistent here.
 */
export async function inspectLegacyCutoverEvidence(
  runnerRoot:string,legacyDir:string,stagingRoot:string,
  remote:AsyncSealAuthority,pinned:ReadonlyMap<string,KeyObject>,
):Promise<CutoverPreflightEvidence>{
  if(pinned.size===0)throw new SegmentIntegrityError();
  const root=resolve(runnerRoot),legacy=resolve(legacyDir),staging=resolve(stagingRoot);
  if(root===legacy||root===staging||legacy===staging)throw new SegmentIntegrityError();
  safeDir(root);safeDir(staging);
  const before=snapshotRunnerAudit(legacy);
  const manifestPath=join(staging,'cutover-staging-'+before.sha256+'.json');
  const manifest=manifestOf(readSecure(manifestPath,8192));
  if(manifest.legacySha256!==before.sha256||manifest.legacyBytes!==before.bytes||
    manifest.legacyEntries!==before.rows.length||manifest.legacyLastHash!==before.lastHash||
    manifest.segmentEntries!==manifest.legacyEntries)
    throw new SegmentIntegrityError();
  const outcome=RunnerOutcomeLedger.openReadonly(join(root,'outcomes'));
  let count=0;
  try{
    const rows=outcome.listAllReadonly();
    if(rows.some(r=>!['SUCCEEDED','FAILED','NO_EFFECT'].includes(r.state)))
      throw new SegmentIntegrityError();
    count=rows.length;
  }finally{outcome.close();}
  const verified=await inspectAllSegments(join(staging,'segments'),remote,pinned,manifest.sealedSegments);
  if(verified.entries!==manifest.segmentEntries||verified.lastHash!==manifest.lastHash||
     verified.sealHash!==manifest.externalSealDigest)
    throw new SegmentIntegrityError();
  const after=snapshotRunnerAudit(legacy);
  if(before.sha256!==after.sha256||before.bytes!==after.bytes||
    before.rows.length!==after.rows.length||before.lastHash!==after.lastHash)
    throw new SegmentIntegrityError();
  return {status:'EVIDENCE_CONSISTENT_NOT_AUTHORIZED',legacySha256:before.sha256,
    externalSealDigest:verified.sealHash,sealedSegments:manifest.sealedSegments,
    entries:verified.entries,terminalOutcomes:count,
    requiresWriterFreeze:true,requiresIndependentEffectReconciliation:true,permitsCutover:false};
}
