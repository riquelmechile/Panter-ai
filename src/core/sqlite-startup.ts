/** Shared SQLite WAL startup for first-open races. NEVER retry business effects. */
import type { DatabaseSync } from 'node:sqlite';
function busy(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('errcode' in error)) return false;
  const code=error.errcode;
  // SQLite extended result codes keep the primary code in the low 8 bits.
  return typeof code === 'number' && Number.isInteger(code) && (code & 255) === 5;
}
/** Caller must share one deadline across WAL and schema bootstrap. */
export function retrySqliteStartup(work:()=>void,deadline=Date.now()+15_000):void {
  const gate=new Int32Array(new SharedArrayBuffer(4));
  let attempt=0;
  for(;;){
    try {work();return;}
    catch(error){
      if(!busy(error))throw error;
      const remaining=deadline-Date.now();
      if(remaining<=0)throw error;
      Atomics.wait(gate,0,0,Math.min(remaining,20+Math.min(attempt++,16)*15));
    }
  }
}
export function enableSqliteWal(db:DatabaseSync,deadline:number):void {
  retrySqliteStartup(()=>{
    const mode=db.prepare('PRAGMA journal_mode=WAL').get() as {journal_mode:string};
    if(mode.journal_mode.toLowerCase()!=='wal')throw new Error('SQLite WAL could not be enabled');
  },deadline);
}
