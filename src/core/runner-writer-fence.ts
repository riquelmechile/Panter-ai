/**
 * Single-writer SQLite admission fence with independent signed death proofs.
 * No automatic reclaim: a separate privileged witness MUST first attest the
 * exact process identity has exited. Kernel /proc identity is rechecked during
 * atomic epoch promotion. No executor or process killing is implemented.
 */
import {createHash,randomUUID,verify,type KeyObject} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {closeSync,constants,lstatSync,mkdirSync,openSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {enableSqliteWal,retrySqliteStartup} from './sqlite-startup.js';

const NOFOLLOW=constants.O_NOFOLLOW??0;
const HEX=/^[a-f0-9]{64}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export class WriterFenced extends Error{
  constructor(){super('Runner writer not admitted');this.name='WriterFenced';}
}
export type WriterWitnessSnapshot={
  ownerId:string;generation:number;pid:number;startTicks:string;
  bootId:string;rootDigest:string;
};
export type WriterDeathClaim={
  domain:'panter.runner-writer-death/v1';
  rootDigest:string;ownerId:string;generation:number;pid:number;
  startTicks:string;bootId:string;observedAt:number;
};
export type SignedWriterDeath={keyId:string;claim:WriterDeathClaim;signature:string};
function rootDigest(root:string):string{
  return createHash('sha256').update('panter.runner-writer-root/v1\0'+root).digest('hex');
}
function secureRoot(dir:string):string{
  const root=resolve(dir);
  try{mkdirSync(root,{recursive:true,mode:0o700});
    const s=lstatSync(root);
    if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid?.()||
      (s.mode&0o077)!==0)throw new WriterFenced();
    return root;
  }catch{throw new WriterFenced();}
}
function fileName(root:string):string{
  const file=join(root,'runner-writer-fence.sqlite');
  try{
    const fd=openSync(file,constants.O_RDWR|constants.O_CREAT|constants.O_EXCL|NOFOLLOW,0o600);
    closeSync(fd);
  }catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw new WriterFenced();}
  try{
    const f=lstatSync(file);
    if(!f.isFile()||f.isSymbolicLink()||f.uid!==process.getuid?.()||
      (f.mode&0o077)!==0)throw new WriterFenced();
  }catch{throw new WriterFenced();}
  return file;
}
function bootId():string{
  try{
    const s=readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim();
    if(!UUID.test(s))throw new WriterFenced();
    return s;
  }catch{throw new WriterFenced();}
}
function processStart(pid:number):string|null{
  if(!Number.isSafeInteger(pid)||pid<1)throw new WriterFenced();
  let raw:string;
  try{raw=readFileSync('/proc/'+pid+'/stat','utf8');}
  catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;
    throw new WriterFenced();}
  const idx=raw.lastIndexOf(') ');
  if(idx<0)throw new WriterFenced();
  const fields=raw.slice(idx+2).trim().split(/\s+/);
  const ticks=fields[19]; // 22nd /proc/<pid>/stat field: process starttime.
  if(!ticks||!/^\d+$/.test(ticks))throw new WriterFenced();
  return ticks;
}
function selfIdentity(root:string):Omit<WriterWitnessSnapshot,'ownerId'|'generation'>{
  const startTicks=processStart(process.pid);
  if(!startTicks)throw new WriterFenced();
  return {pid:process.pid,bootId:bootId(),startTicks,rootDigest:rootDigest(root)};
}
function schema(db:DatabaseSync):void{
  db.exec("CREATE TABLE IF NOT EXISTS writer_claim (id INTEGER PRIMARY KEY CHECK(id=1),owner_id TEXT NOT NULL,generation INTEGER NOT NULL CHECK(generation>=1),owner_pid INTEGER NOT NULL,boot_id TEXT NOT NULL,start_ticks TEXT NOT NULL,root_digest TEXT NOT NULL)");
}
function inspect(db:DatabaseSync):WriterWitnessSnapshot{
  const v=db.prepare('SELECT owner_id,generation,owner_pid,boot_id,start_ticks,root_digest FROM writer_claim WHERE id=1')
    .get() as {owner_id:string,generation:number,owner_pid:number,boot_id:string,start_ticks:string,root_digest:string}|undefined;
  if(!v||!UUID.test(v.owner_id)||!Number.isSafeInteger(v.generation)||v.generation<1||
    !Number.isSafeInteger(v.owner_pid)||v.owner_pid<1||!/^\d+$/.test(v.start_ticks)||
    !UUID.test(v.boot_id)||!HEX.test(v.root_digest))throw new WriterFenced();
  return {ownerId:v.owner_id,generation:v.generation,pid:v.owner_pid,
    bootId:v.boot_id,startTicks:v.start_ticks,rootDigest:v.root_digest};
}
function validClaim(x:unknown):x is WriterDeathClaim{
  if(!x||typeof x!=='object'||Array.isArray(x))return false;
  const r=x as Record<string,unknown>;
  const names=['domain','rootDigest','ownerId','generation','pid','startTicks','bootId','observedAt'];
  return Object.keys(r).sort().join('|')===names.sort().join('|')&&
    r.domain==='panter.runner-writer-death/v1'&&typeof r.rootDigest==='string'&&HEX.test(r.rootDigest)&&
    typeof r.ownerId==='string'&&UUID.test(r.ownerId)&&
    Number.isSafeInteger(r.generation)&&(r.generation as number)>0&&
    Number.isSafeInteger(r.pid)&&(r.pid as number)>0&&
    typeof r.startTicks==='string'&&/^\d+$/.test(r.startTicks)&&
    typeof r.bootId==='string'&&UUID.test(r.bootId)&&
    Number.isSafeInteger(r.observedAt)&&(r.observedAt as number)>0;
}
export function writerDeathPayload(claim:WriterDeathClaim):Buffer{
  if(!validClaim(claim))throw new WriterFenced();
  return Buffer.from(JSON.stringify(['panter.runner-writer-death/v1',claim.rootDigest,
    claim.ownerId,claim.generation,claim.pid,claim.startTicks,claim.bootId,claim.observedAt]));
}
function deathOK(signed:unknown,pinned:ReadonlyMap<string,KeyObject>):WriterDeathClaim{
  if(!signed||typeof signed!=='object'||Array.isArray(signed))throw new WriterFenced();
  const v=signed as Record<string,unknown>;
  if(Object.keys(v).sort().join('|')!=='claim|keyId|signature'||
    typeof v.keyId!=='string'||typeof v.signature!=='string'||
    !/^[A-Za-z0-9_-]{86}$/.test(v.signature)||!validClaim(v.claim))throw new WriterFenced();
  const key=pinned.get(v.keyId);
  if(!key||key.type!=='public'||key.asymmetricKeyType!=='ed25519')throw new WriterFenced();
  const sig=Buffer.from(v.signature,'base64url');
  if(sig.length!==64||sig.toString('base64url')!==v.signature||
    !verify(null,writerDeathPayload(v.claim),key,sig))throw new WriterFenced();
  return v.claim;
}
function openDb(root:string):DatabaseSync{
  const db=new DatabaseSync(fileName(root));
  try{
    const deadline=Date.now()+15_000;
    db.exec('PRAGMA busy_timeout=1000');
    enableSqliteWal(db,deadline);
    db.exec('PRAGMA synchronous=FULL');
    retrySqliteStartup(()=>schema(db),deadline);
    db.exec('PRAGMA busy_timeout=10000');
    return db;
  }catch{db.close();throw new WriterFenced();}
}
export class RunnerWriterFence{
  readonly ownerId:string;
  readonly generation:number;
  readonly root:string;
  private constructor(private readonly db:DatabaseSync,root:string,
    ownerId:string,generation:number){
    this.root=root;this.ownerId=ownerId;this.generation=generation;
  }
  static claim(dir:string):RunnerWriterFence{
    const root=secureRoot(dir),db=openDb(root),ownerId=randomUUID(),self=selfIdentity(root);
    try{
      db.exec('BEGIN IMMEDIATE');
      try{
        db.prepare('INSERT INTO writer_claim(id,owner_id,generation,owner_pid,boot_id,start_ticks,root_digest) VALUES(1,?,1,?,?,?,?)')
          .run(ownerId,self.pid,self.bootId,self.startTicks,self.rootDigest);
        db.exec('COMMIT');
      }catch{db.exec('ROLLBACK');throw new WriterFenced();}
      return new RunnerWriterFence(db,root,ownerId,1);
    }catch{db.close();throw new WriterFenced();}
  }
  static snapshot(dir:string):WriterWitnessSnapshot{
    const root=secureRoot(dir),db=new DatabaseSync(fileName(root),{readOnly:true});
    try{
      const v=inspect(db);
      if(v.rootDigest!==rootDigest(root))throw new WriterFenced();
      return v;
    }catch{throw new WriterFenced();}finally{db.close();}
  }
  /** Requires an independent Ed25519 death witness, plus kernel death check. */
  static reclaim(dir:string,signed:SignedWriterDeath,pinned:ReadonlyMap<string,KeyObject>,
    now=Date.now()):RunnerWriterFence{
    const root=secureRoot(dir);
    const claim=deathOK(signed,pinned);
    if(!Number.isSafeInteger(now)||claim.observedAt>now+300_000||
      claim.observedAt<now-300_000||claim.rootDigest!==rootDigest(root)||
      claim.bootId!==bootId())throw new WriterFenced();
    const db=openDb(root),ownerId=randomUUID(),self=selfIdentity(root);
    try{
      db.exec('BEGIN IMMEDIATE');
      try{
        const prior=inspect(db);
        if(prior.ownerId!==claim.ownerId||prior.generation!==claim.generation||
          prior.pid!==claim.pid||prior.startTicks!==claim.startTicks||
          prior.bootId!==claim.bootId||prior.rootDigest!==claim.rootDigest)
          throw new WriterFenced();
        // Missing /proc entry or PID reuse with different starttime proves that
        // this *exact PID + start ticks* is no longer active. Any ambiguity denies.
        const start=processStart(claim.pid);
        if(start===claim.startTicks)throw new WriterFenced();
        const next=prior.generation+1;
        if(!Number.isSafeInteger(next))throw new WriterFenced();
        const out=db.prepare('UPDATE writer_claim SET owner_id=?,generation=?,owner_pid=?,boot_id=?,start_ticks=?,root_digest=? WHERE id=1 AND owner_id=? AND generation=?')
          .run(ownerId,next,self.pid,self.bootId,self.startTicks,self.rootDigest,prior.ownerId,prior.generation);
        if(out.changes!==1)throw new WriterFenced();
        db.exec('COMMIT');
        return new RunnerWriterFence(db,root,ownerId,next);
      }catch{db.exec('ROLLBACK');throw new WriterFenced();}
    }catch{db.close();throw new WriterFenced();}
  }
  snapshot():WriterWitnessSnapshot{
    this.assertCurrent();
    return inspect(this.db);
  }
  assertCurrent():void{
    try{
      const v=inspect(this.db);
      if(v.ownerId!==this.ownerId||v.generation!==this.generation||
        v.rootDigest!==rootDigest(this.root))throw new WriterFenced();
    }catch{throw new WriterFenced();}
  }
  close():void{this.db.close();/* retain the durable claim until verified reclaim */ }
}
