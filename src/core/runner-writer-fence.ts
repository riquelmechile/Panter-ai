/**
 * Durable single-writer admission fence. One writer can ever claim the local
 * ledger in this incremental phase: there is deliberately NO automatic reclaim.
 * Recovery after process death requires separate independently reviewed proof.
 * Not a process killer, dispatcher, or cross-UID security boundary.
 */
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {closeSync,constants,lstatSync,mkdirSync,openSync,statSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {enableSqliteWal,retrySqliteStartup} from './sqlite-startup.js';

const NOFOLLOW=constants.O_NOFOLLOW??0;
export class WriterFenced extends Error{
  constructor(){super('Runner writer not admitted');this.name='WriterFenced';}
}
export class RunnerWriterFence{
  private readonly db:DatabaseSync;
  readonly ownerId:string;
  readonly generation:number;
  private constructor(db:DatabaseSync,ownerId:string,generation:number){
    this.db=db;this.ownerId=ownerId;this.generation=generation;
  }
  static claim(dir:string):RunnerWriterFence{
    const root=resolve(dir);
    mkdirSync(root,{recursive:true,mode:0o700});
    const s=lstatSync(root);
    if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid?.()||(s.mode&0o077)!==0)
      throw new WriterFenced();
    const file=join(root,'runner-writer-fence.sqlite');
    try{
      const fd=openSync(file,constants.O_RDWR|constants.O_CREAT|constants.O_EXCL|NOFOLLOW,0o600);
      closeSync(fd);
    }catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw new WriterFenced();}
    const f=lstatSync(file);
    if(!f.isFile()||f.isSymbolicLink()||f.uid!==process.getuid?.()||(f.mode&0o077)!==0)
      throw new WriterFenced();
    const db=new DatabaseSync(file);
    const ownerId=randomUUID();
    try{
      const deadline=Date.now()+15_000;
      db.exec('PRAGMA busy_timeout=1000');
      enableSqliteWal(db,deadline);
      db.exec('PRAGMA synchronous=FULL');
      retrySqliteStartup(()=>{
        db.exec('BEGIN IMMEDIATE');
        try{
          db.exec('CREATE TABLE IF NOT EXISTS writer_claim (id INTEGER PRIMARY KEY CHECK(id=1),owner_id TEXT NOT NULL,generation INTEGER NOT NULL CHECK(generation>=1))');
          // One-time claim, no takeover even if the prior process died.
          db.prepare('INSERT INTO writer_claim(id,owner_id,generation) VALUES(1,?,1)').run(ownerId);
          db.exec('COMMIT');
        }catch(e){db.exec('ROLLBACK');throw e;}
      },deadline);
      db.exec('PRAGMA busy_timeout=10000');
      return new RunnerWriterFence(db,ownerId,1);
    }catch{
      db.close();
      throw new WriterFenced();
    }
  }
  assertCurrent():void{
    try{
      const r=this.db.prepare('SELECT owner_id,generation FROM writer_claim WHERE id=1')
        .get() as {owner_id:string,generation:number}|undefined;
      if(!r||r.owner_id!==this.ownerId||r.generation!==this.generation)throw new WriterFenced();
    }catch{throw new WriterFenced();}
  }
  close():void{this.db.close();/* durable claim remains; no implicit takeover */ }
}
