/**
 * Per-instance batch/time seal barrier. Admission receipts resolve ONLY after
 * the independent Ed25519 seal was received and verified by the journal.
 * Failure poisons this instance; ambiguous effects are NEVER retried.
 */
import {AsyncSegmentedRunnerAudit} from './runner-seal-http.js';
import {SegmentIntegrityError,type SegmentedEvent,type SegmentInspection} from './runner-segments.js';

type Waiter={resolve:(s:SegmentInspection)=>void,reject:(error:Error)=>void};
export class RunnerAuditSealBatcher{
  private readonly maxEvents:number;
  private readonly maxDelayMs:number;
  private readonly journal:AsyncSegmentedRunnerAudit;
  private queue:Promise<void>=Promise.resolve();
  private waiters:Waiter[]=[];
  private timer:ReturnType<typeof setTimeout>|undefined;
  private failed=false;
  constructor(journal:AsyncSegmentedRunnerAudit,
    options:{maxEvents?:number,maxDelayMs?:number}={}){
    const maxEvents=options.maxEvents??8,maxDelayMs=options.maxDelayMs??250;
    if(!Number.isSafeInteger(maxEvents)||maxEvents<2||maxEvents>1000||
      !Number.isSafeInteger(maxDelayMs)||maxDelayMs<10||maxDelayMs>10_000)
      throw new SegmentIntegrityError();
    this.journal=journal;this.maxEvents=maxEvents;this.maxDelayMs=maxDelayMs;
  }
  private poison(error:unknown){
    if(this.failed)return;
    this.failed=true;
    if(this.timer!==undefined){clearTimeout(this.timer);this.timer=undefined;}
    const failure=error instanceof Error?error:new SegmentIntegrityError();
    for(const waiter of this.waiters.splice(0))waiter.reject(failure);
  }
  private async sealPending():Promise<void>{
    if(this.timer!==undefined){clearTimeout(this.timer);this.timer=undefined;}
    if(this.failed)throw new SegmentIntegrityError();
    if(this.waiters.length===0)return;
    const result=await this.journal.sealCurrent();
    for(const waiter of this.waiters.splice(0))waiter.resolve(result);
  }
  private schedule(){
    if(this.timer!==undefined)return;
    this.timer=setTimeout(()=>{void this.flush().catch(()=>{});},this.maxDelayMs);
  }
  /**
   * Each caller waits for an actual remote seal, never merely local fsync.
   * Enqueues are serialized to protect AsyncSegmentedRunnerAudit single-writer.
   */
  appendAndSeal(event:SegmentedEvent):Promise<SegmentInspection>{
    return new Promise((resolve,reject)=>{
      const task=this.queue.then(async()=>{
        if(this.failed)throw new SegmentIntegrityError();
        await this.journal.append(event);
        this.waiters.push({resolve,reject});
        if(this.waiters.length>=this.maxEvents)await this.sealPending();
        else this.schedule();
      });
      this.queue=task.catch(error=>{this.poison(error);reject(error);});
    });
  }
  flush():Promise<void>{
    const task=this.queue.then(()=>this.sealPending());
    this.queue=task.catch(error=>{this.poison(error);});
    return task;
  }
  close():void{this.poison(new SegmentIntegrityError());}
}
