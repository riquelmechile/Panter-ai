/** Durable UNKNOWN-outcome coordinator. Never executes effects or issues grants. */
import {createHash,createPublicKey,verify,type KeyObject} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {closeSync,constants,lstatSync,mkdirSync,openSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {RUNNER_OPERATIONS,type RunnerOperation} from './runner-grants.js';
import {enableSqliteWal,retrySqliteStartup} from './sqlite-startup.js';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA=/^[0-9a-f]{40}$/;
const HEX=/^[0-9a-f]{64}$/;
const ID=/^[A-Za-z0-9_.:@-]{1,160}$/;
const REPO=/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const NOFOLLOW=constants.O_NOFOLLOW??0;
export class OutcomeRejected extends Error{constructor(){super('Runner outcome rejected');this.name='OutcomeRejected';}}
export type OutcomeState='INTENT'|'EFFECT_WINDOW'|'OUTCOME_UNKNOWN'|'SUCCEEDED'|'FAILED'|'NO_EFFECT';
export type OutcomeIntent={
  operationId:string;subject:string;repository:string;candidateSha:string;
  missionId:string;workId:string;attemptId:string;leaseGeneration:number;
  operation:RunnerOperation;grantDigest:string;
};
export type OutcomeClaim={
  domain:'panter.outcome-reconciliation/v1';
  operationId:string;intentDigest:string;leaseGeneration:number;
  outcome:'SUCCEEDED'|'FAILED'|'NO_EFFECT';
  evidenceDigest:string;observedAt:number;
};
export type SignedOutcome={keyId:string;claim:OutcomeClaim;signature:string};
export type OutcomeSnapshot={operationId:string;state:OutcomeState;intentDigest:string;leaseGeneration:number;receiptDigest:string|null;effectDeadline:number|null};

function exact(x:unknown,names:string[]):x is Record<string,unknown>{
  return x!==null&&typeof x==='object'&&!Array.isArray(x)&&
    Object.keys(x).sort().join('\0')===[...names].sort().join('\0');
}
function intentOK(x:unknown):x is OutcomeIntent{
  if(!exact(x,['operationId','subject','repository','candidateSha','missionId','workId','attemptId','leaseGeneration','operation','grantDigest']))return false;
  return typeof x.operationId==='string'&&UUID.test(x.operationId)&&
    typeof x.subject==='string'&&ID.test(x.subject)&&
    typeof x.repository==='string'&&REPO.test(x.repository)&&
    typeof x.candidateSha==='string'&&SHA.test(x.candidateSha)&&
    [x.missionId,x.workId,x.attemptId].every(s=>typeof s==='string'&&ID.test(s))&&
    Number.isSafeInteger(x.leaseGeneration)&&(x.leaseGeneration as number)>0&&
    typeof x.operation==='string'&&RUNNER_OPERATIONS.includes(x.operation as RunnerOperation)&&
    typeof x.grantDigest==='string'&&HEX.test(x.grantDigest);
}
function claimOK(x:unknown):x is OutcomeClaim{
  if(!exact(x,['domain','operationId','intentDigest','leaseGeneration','outcome','evidenceDigest','observedAt']))return false;
  return x.domain==='panter.outcome-reconciliation/v1'&&
    typeof x.operationId==='string'&&UUID.test(x.operationId)&&
    typeof x.intentDigest==='string'&&HEX.test(x.intentDigest)&&
    Number.isSafeInteger(x.leaseGeneration)&&(x.leaseGeneration as number)>0&&
    ['SUCCEEDED','FAILED','NO_EFFECT'].includes(String(x.outcome))&&
    typeof x.evidenceDigest==='string'&&HEX.test(x.evidenceDigest)&&
    Number.isSafeInteger(x.observedAt)&&(x.observedAt as number)>0;
}
export function outcomeIntentPayload(x:OutcomeIntent):Buffer{
  if(!intentOK(x))throw new OutcomeRejected();
  return Buffer.from(JSON.stringify(['panter.outcome-intent/v1',x.operationId,x.subject,x.repository,x.candidateSha,
    x.missionId,x.workId,x.attemptId,x.leaseGeneration,x.operation,x.grantDigest]));
}
export function outcomeClaimPayload(x:OutcomeClaim):Buffer{
  if(!claimOK(x))throw new OutcomeRejected();
  return Buffer.from(JSON.stringify(['panter.outcome-reconciliation/v1',x.operationId,x.intentDigest,x.leaseGeneration,
    x.outcome,x.evidenceDigest,x.observedAt]));
}
function hash(x:Buffer):string{return createHash('sha256').update(x).digest('hex');}
export function independentOutcomeKeys(pems:Record<string,string>):ReadonlyMap<string,KeyObject>{
  if(!Object.keys(pems).length)throw new OutcomeRejected();
  const keys=new Map<string,KeyObject>();
  for(const [id,pem] of Object.entries(pems)){
    if(!/^[A-Za-z0-9_.-]{1,64}$/.test(id)||typeof pem!=='string'||
       !/^-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+-----END PUBLIC KEY-----\r?\n?$/.test(pem))
      throw new OutcomeRejected();
    try{const key=createPublicKey(pem);if(key.asymmetricKeyType!=='ed25519')throw new Error();keys.set(id,key);}
    catch{throw new OutcomeRejected();}
  }
  return keys;
}
function receiptOK(value:unknown,keys:ReadonlyMap<string,KeyObject>):SignedOutcome{
  if(!exact(value,['keyId','claim','signature'])||
    typeof value.keyId!=='string'||typeof value.signature!=='string'||
    !/^[A-Za-z0-9_-]{86}$/.test(value.signature)||!claimOK(value.claim))throw new OutcomeRejected();
  const key=keys.get(value.keyId);
  if(!key||key.asymmetricKeyType!=='ed25519')throw new OutcomeRejected();
  const sig=Buffer.from(value.signature,'base64url');
  if(sig.length!==64||sig.toString('base64url')!==value.signature||
    !verify(null,outcomeClaimPayload(value.claim),key,sig))throw new OutcomeRejected();
  return value as unknown as SignedOutcome;
}
/**
 * The epoch fences stale writer API calls. It does NOT kill an already-running
 * external effect. EFFECT_WINDOW is preserved until its signed-grant deadline;
 * external process termination at that deadline is a separate runner gate.
 */
export class RunnerOutcomeLedger{
  private readonly db:DatabaseSync;
  private readonly writerEpoch:number;
  private readonly readonlyMode:boolean;
  static openReadonly(dir:string):RunnerOutcomeLedger{
    return new RunnerOutcomeLedger(dir,{readonly:true});
  }
  constructor(dir:string,options:{readonly?:boolean}={}){
    this.readonlyMode=options.readonly===true;
    const root=resolve(dir);
    if(!this.readonlyMode)mkdirSync(root,{recursive:true,mode:0o700});
    let s:ReturnType<typeof lstatSync>;
    try{s=lstatSync(root);}catch{throw new OutcomeRejected();}
    if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid?.()||(s.mode&0o077)!==0)throw new OutcomeRejected();
    const file=join(root,'runner-outcomes.sqlite');
    if(!this.readonlyMode){
      try{const fd=openSync(file,constants.O_CREAT|constants.O_EXCL|constants.O_RDWR|NOFOLLOW,0o600);closeSync(fd);}
      catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw new OutcomeRejected();}
    }
    let f:ReturnType<typeof lstatSync>;
    try{f=lstatSync(file);}catch{throw new OutcomeRejected();}
    if(!f.isFile()||f.isSymbolicLink()||f.uid!==process.getuid?.()||(f.mode&0o077)!==0)throw new OutcomeRejected();
    this.db=new DatabaseSync(file,{readOnly:this.readonlyMode});
    if(this.readonlyMode){
      // Read-only inspection performs ZERO writes, PRAGMA WAL changes or epochs.
      this.writerEpoch=0;
      return;
    }
    try{
      const deadline=Date.now()+15_000;
      this.db.exec('PRAGMA busy_timeout=1000');
      enableSqliteWal(this.db,deadline);
      this.db.exec('PRAGMA synchronous=FULL');
      this.writerEpoch=retryStartupEpoch(this.db,deadline);
      this.db.exec('PRAGMA busy_timeout=10000');
    }catch(e){this.db.close();throw e;}
  }
  private assertWriter():void{
    if(this.readonlyMode)throw new OutcomeRejected();
    const row=this.db.prepare('SELECT epoch FROM outcome_writer_epoch WHERE id=1').get() as {epoch:number}|undefined;
    if(!row||row.epoch!==this.writerEpoch)throw new OutcomeRejected();
  }
  prepare(intent:OutcomeIntent):OutcomeSnapshot{
    const intentDigest=hash(outcomeIntentPayload(intent));
    if(this.readonlyMode)throw new OutcomeRejected();
    this.db.exec('BEGIN IMMEDIATE');
    try{
      this.assertWriter();
      this.db.prepare("INSERT INTO outcomes(operation_id,intent_digest,lease_generation,state,receipt_digest,writer_epoch,effect_deadline) VALUES(?,?,?,'INTENT',NULL,?,NULL)")
        .run(intent.operationId,intentDigest,intent.leaseGeneration,this.writerEpoch);
      this.db.exec('COMMIT');
    }catch{this.db.exec('ROLLBACK');throw new OutcomeRejected();}
    return this.get(intent.operationId)!;
  }
  /**
   * The deadline MUST be the verified grant.expiresAt. The caller must check
   * grant identity and terminate the actual effect process by this time.
   */
  enterEffectWindow(id:string,generation:number,effectDeadline:number):OutcomeSnapshot{
    const now=Date.now();
    if(this.readonlyMode||!UUID.test(id)||!Number.isSafeInteger(generation)||generation<1||
      !Number.isSafeInteger(effectDeadline)||effectDeadline<=now||
      effectDeadline>now+60*60*1000)throw new OutcomeRejected();
    this.db.exec('BEGIN IMMEDIATE');
    try{
      this.assertWriter();
      const row=this.db.prepare("UPDATE outcomes SET state='EFFECT_WINDOW',effect_deadline=? WHERE operation_id=? AND lease_generation=? AND writer_epoch=? AND state='INTENT'")
        .run(effectDeadline,id,generation,this.writerEpoch);
      if(row.changes!==1)throw new OutcomeRejected();
      this.db.exec('COMMIT');
    }catch{this.db.exec('ROLLBACK');throw new OutcomeRejected();}
    return this.get(id)!;
  }
  reconcile(raw:unknown,pinned:ReadonlyMap<string,KeyObject>):OutcomeSnapshot{
    if(this.readonlyMode)throw new OutcomeRejected();
    const env=receiptOK(raw,pinned),claim=env.claim;
    // No signed observation may claim to be more than 5 minutes in the future.
    // Validate even on idempotent replay so time skew cannot bypass this gate.
    if(claim.observedAt>Date.now()+5*60*1000)throw new OutcomeRejected();
    const receiptDigest=hash(Buffer.concat([outcomeClaimPayload(claim),Buffer.from(env.signature,'base64url')]));
    this.db.exec('BEGIN IMMEDIATE');
    try{
      this.assertWriter();
      let current=this.get(claim.operationId);
      if(!current||current.intentDigest!==claim.intentDigest||
        current.leaseGeneration!==claim.leaseGeneration)throw new OutcomeRejected();
      // Idempotent replay is permitted only for the EXACT same signed receipt.
      if(current.state===claim.outcome&&current.receiptDigest===receiptDigest){
        this.db.exec('COMMIT');return current;
      }
      const now=Date.now();
      if(current.effectDeadline===null||now<current.effectDeadline||
        claim.observedAt<current.effectDeadline)throw new OutcomeRejected();
      // An active writer can reconcile its own expired EFFECT_WINDOW, too.
      // A second writer cannot alter a live window; both paths require the
      // independently signed receipt and have passed the deadline checks.
      if(current.state==='EFFECT_WINDOW'){
        const m=this.db.prepare("UPDATE outcomes SET state='OUTCOME_UNKNOWN' WHERE operation_id=? AND writer_epoch<=? AND state='EFFECT_WINDOW' AND effect_deadline<=?")
          .run(claim.operationId,this.writerEpoch,now);
        if(m.changes!==1)throw new OutcomeRejected();
        current=this.get(claim.operationId)!;
      }
      if(current.state!=='OUTCOME_UNKNOWN')throw new OutcomeRejected();
      const result=this.db.prepare("UPDATE outcomes SET state=?,receipt_digest=? WHERE operation_id=? AND state='OUTCOME_UNKNOWN' AND effect_deadline<=?")
        .run(claim.outcome,receiptDigest,claim.operationId,now);
      if(result.changes!==1)throw new OutcomeRejected();
      this.db.exec('COMMIT');
    }catch{this.db.exec('ROLLBACK');throw new OutcomeRejected();}
    return this.get(claim.operationId)!;
  }
  /**
   * One consistent read-only SQLite snapshot for offline cutover preflight.
   * Never opens a writer epoch, mutates a row or silently truncates results.
   */
  listAllReadonly(maxEntries=10_000):OutcomeSnapshot[]{
    if(!this.readonlyMode||!Number.isSafeInteger(maxEntries)||
      maxEntries<1||maxEntries>100_000)throw new OutcomeRejected();
    this.db.exec('BEGIN');
    try{
      const rows=this.db.prepare('SELECT operation_id,intent_digest,lease_generation,state,receipt_digest,effect_deadline FROM outcomes ORDER BY operation_id LIMIT ?')
        .all(maxEntries+1) as Array<{operation_id:string,intent_digest:string,lease_generation:number,
          state:OutcomeState,receipt_digest:string|null,effect_deadline:number|null}>;
      if(rows.length>maxEntries)throw new OutcomeRejected();
      const result:OutcomeSnapshot[]=rows.map(row=>{
        if(!UUID.test(row.operation_id)||!HEX.test(row.intent_digest)||
          !Number.isSafeInteger(row.lease_generation)||row.lease_generation<1||
          !['INTENT','EFFECT_WINDOW','OUTCOME_UNKNOWN','SUCCEEDED','FAILED','NO_EFFECT'].includes(row.state)||
          (row.receipt_digest!==null&&!HEX.test(row.receipt_digest))||
          (row.effect_deadline!==null&&(!Number.isSafeInteger(row.effect_deadline)||row.effect_deadline<=0))||
          (['SUCCEEDED','FAILED','NO_EFFECT'].includes(row.state)&&
            (row.receipt_digest===null||row.effect_deadline===null)))
          throw new OutcomeRejected();
        return {operationId:row.operation_id,state:row.state,intentDigest:row.intent_digest,
          leaseGeneration:row.lease_generation,receiptDigest:row.receipt_digest,
          effectDeadline:row.effect_deadline};
      });
      this.db.exec('COMMIT');
      return result;
    }catch{
      this.db.exec('ROLLBACK');
      throw new OutcomeRejected();
    }
  }
  get(id:string):OutcomeSnapshot|null{
    if(!UUID.test(id))throw new OutcomeRejected();
    const row=this.db.prepare('SELECT operation_id,intent_digest,lease_generation,state,receipt_digest,effect_deadline FROM outcomes WHERE operation_id=?')
      .get(id) as {operation_id:string,intent_digest:string,lease_generation:number,state:OutcomeState,receipt_digest:string|null,effect_deadline:number|null}|undefined;
    return row?{operationId:row.operation_id,intentDigest:row.intent_digest,leaseGeneration:row.lease_generation,state:row.state,receiptDigest:row.receipt_digest,effectDeadline:row.effect_deadline}:null;
  }
  close():void{this.db.close();}
}
/** Startup is idempotent; atomic epoch promotion fences prior writers. */
function retryStartupEpoch(db:DatabaseSync,deadline:number):number{
  let current=0;
  retrySqliteStartup(()=>{
    db.exec('BEGIN IMMEDIATE');
    try{
      db.exec("CREATE TABLE IF NOT EXISTS outcomes (operation_id TEXT PRIMARY KEY,intent_digest TEXT NOT NULL,lease_generation INTEGER NOT NULL,state TEXT NOT NULL CHECK(state IN ('INTENT','EFFECT_WINDOW','OUTCOME_UNKNOWN','SUCCEEDED','FAILED','NO_EFFECT')),receipt_digest TEXT,writer_epoch INTEGER NOT NULL DEFAULT 0,effect_deadline INTEGER)");
      const fields=db.prepare('PRAGMA table_info(outcomes)').all() as {name:string}[];
      if(!fields.some(x=>x.name==='writer_epoch'))db.exec('ALTER TABLE outcomes ADD COLUMN writer_epoch INTEGER NOT NULL DEFAULT 0');
      if(!fields.some(x=>x.name==='effect_deadline'))db.exec('ALTER TABLE outcomes ADD COLUMN effect_deadline INTEGER');
      db.exec('CREATE TABLE IF NOT EXISTS outcome_writer_epoch (id INTEGER PRIMARY KEY CHECK(id=1),epoch INTEGER NOT NULL CHECK(epoch>=0))');
      db.exec('INSERT OR IGNORE INTO outcome_writer_epoch(id,epoch) VALUES(1,0)');
      db.exec('UPDATE outcome_writer_epoch SET epoch=epoch+1 WHERE id=1');
      current=(db.prepare('SELECT epoch FROM outcome_writer_epoch WHERE id=1').get() as {epoch:number}).epoch;
      if(!Number.isSafeInteger(current)||current<1)throw new OutcomeRejected();
      const now=Date.now();
      // INTENT cannot turn into an effect after fencing its old writer.
      db.prepare("UPDATE outcomes SET state='OUTCOME_UNKNOWN',effect_deadline=COALESCE(effect_deadline,?) WHERE writer_epoch<? AND state='INTENT'").run(now,current);
      // NEVER classify a possibly live effect as UNKNOWN before its deadline.
      // Legacy EFFECT_WINDOW rows without a deadline remain blocked closed.
      db.prepare("UPDATE outcomes SET state='OUTCOME_UNKNOWN' WHERE writer_epoch<? AND state='EFFECT_WINDOW' AND effect_deadline IS NOT NULL AND effect_deadline<=?")
        .run(current,now);
      db.exec('COMMIT');
    }catch(error){db.exec('ROLLBACK');throw error;}
  },deadline);
  return current;
}
