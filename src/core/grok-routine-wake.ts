/** Grok Bot Routine wake adapter. A webhook is only a doorbell: no instructions or
 * OAuth credentials leave the authoritative Mesh ledger. HTTP acceptance is
 * never evidence of a worker claim or completed model run.
 */
import {isIP} from 'node:net';

export type WakeSignal = {attempted:boolean;accepted:boolean;state:'DELIVERY_ONLY'|'SIGNAL_ACCEPTED'|'SIGNAL_FAILED';statusCode:number|null;adapter:'NONE'|'GROK_ROUTINE_BEARER'};
export type WakeSender = (url:string,body:string,headers:Record<string,string>)=>Promise<number>;

const defaultSender:WakeSender=async(url,body,headers)=>{
  const response=await fetch(url,{method:'POST',redirect:'manual',headers,body,
    signal:AbortSignal.timeout(5000)});
  return response.status;
};
const signal=(attempted:boolean,accepted:boolean,statusCode:number|null):WakeSignal=>({
  attempted,accepted,statusCode,adapter:attempted?'GROK_ROUTINE_BEARER':'NONE',
  state:!attempted?'DELIVERY_ONLY':accepted?'SIGNAL_ACCEPTED':'SIGNAL_FAILED'
});
export class GrokRoutineWake {
  readonly configured:boolean;
  private readonly url:string;
  private readonly key:string;
  constructor(url=process.env.PANTER_WAKE_GROK_URL??'',
    key=process.env.PANTER_WAKE_GROK_KEY??'',
    private readonly sender:WakeSender=defaultSender){
    if(Boolean(url)!==Boolean(key))throw Error('Grok wake requires both URL and key');
    this.configured=Boolean(url);
    this.url=url;this.key=key;
    if(!this.configured)return;
    const parsed=new URL(url);
    const hostname=parsed.hostname.toLowerCase();
    if(parsed.protocol!=='https:'||!hostname||parsed.username||parsed.password||
      (parsed.port!==''&&parsed.port!=='443')||isIP(hostname)!==0||
      hostname==='localhost'||hostname.endsWith('.localhost')||
      hostname.endsWith('.local')||hostname.endsWith('.internal')||
      hostname.endsWith('.invalid')||hostname.endsWith('.test')||hostname.endsWith('.example')||
      hostname.includes('..')||!hostname.includes('.'))
      throw Error('Grok wake requires an operator-configured public HTTPS hostname');
    if(!/^crsr_[A-Za-z0-9._~-]{16,}$/.test(key))
      throw Error('Grok wake key must use the provider-native crsr_ format');
  }
  /** Never include model prompts, results, actor tokens, or arbitrary host input. */
  async dispatch(workId:string):Promise<WakeSignal>{
    if(!this.configured)return signal(false,false,null);
    if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(workId))
      throw Error('Invalid work ID');
    const body=JSON.stringify({source:'panter-ai',event:'workforce_task_ready',work_id:workId});
    try{
      const code=await this.sender(this.url,body,{
        'content-type':'application/json',
        authorization:'Bearer '+this.key
      });
      return signal(true,code>=200&&code<300,code);
    }catch{
      // Do not include fetch exceptions: they may contain sensitive URLs.
      return signal(true,false,null);
    }
  }
  describe(){return {configured:this.configured,adapter:this.configured?'GROK_ROUTINE_BEARER':'NONE'};}
}
