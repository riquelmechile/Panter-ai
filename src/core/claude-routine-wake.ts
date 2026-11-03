/** Claude Code Routines HTTP fire: starts a *subscription-backed* Claude Code
 * cloud session, not a Claude Messages API inference call. A 200 means a
 * session was created, NOT that authenticated Panter pickup or execution ran.
 * https://platform.claude.com/docs/en/api/claude-code/routines-fire
 */
import {type WakeSender} from './grok-routine-wake.js';
export type ClaudeWakeSignal={
  attempted:boolean;accepted:boolean;
  state:'DELIVERY_ONLY'|'SIGNAL_ACCEPTED'|'SIGNAL_FAILED';
  statusCode:number|null;sessionId:string|null;
  adapter:'NONE'|'CLAUDE_CODE_ROUTINE_API';
};
type Response = {status:number;body?:unknown};
export type ClaudeWakeSender=(url:string,body:string,headers:Record<string,string>)=>Promise<Response>;
const sender:ClaudeWakeSender=async(url,body,headers)=>{
  const r=await fetch(url,{method:'POST',redirect:'manual',headers,body,
    signal:AbortSignal.timeout(5000)});
  if(r.status!==200)return {status:r.status};
  // Cap reply size; even a successful endpoint must not become unbounded
  // or let arbitrary JSON contents enter the durable mesh.
  const text=await r.text();
  if(text.length>4096)return {status:200};
  try{return {status:200,body:JSON.parse(text) as unknown};}
  catch{return {status:200};}
};
function signal(attempted:boolean,accepted:boolean,statusCode:number|null,
  sessionId:string|null=null):ClaudeWakeSignal{
  return {attempted,accepted,state:!attempted?'DELIVERY_ONLY':accepted?
    'SIGNAL_ACCEPTED':'SIGNAL_FAILED',statusCode,sessionId,
    adapter:attempted?'CLAUDE_CODE_ROUTINE_API':'NONE'};
}
export class ClaudeRoutineWake {
  readonly configured:boolean;
  private readonly url:string;
  private readonly token:string;
  constructor(url=process.env.PANTER_WAKE_CLAUDE_URL??'',
    token=process.env.PANTER_WAKE_CLAUDE_TOKEN??'',
    private readonly send:ClaudeWakeSender=sender){
    if(Boolean(url)!==Boolean(token))throw Error('Claude Routine requires URL and token');
    this.configured=Boolean(url);this.url=url;this.token=token;
    if(!this.configured)return;
    const u=new URL(url);
    // Only Anthropic's documented routine fire endpoint: never send a
    // bearer to arbitrary host names supplied by profile data.
    if(u.protocol!=='https:'||u.hostname!=='api.anthropic.com'||u.port||u.username||
      u.password||u.search||u.hash||
      !/^\/v1\/claude_code\/routines\/[A-Za-z0-9_-]{8,160}\/fire$/.test(u.pathname))
      throw Error('Claude Routine requires official Anthropic fire URL');
    if(!/^sk-ant-oat01-[A-Za-z0-9_-]{16,}$/.test(token))
      throw Error('Claude Routine requires its per-routine OAuth trigger token');
  }
  async dispatch(workId:string):Promise<ClaudeWakeSignal>{
    if(!this.configured)return signal(false,false,null);
    if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(workId))
      throw Error('Invalid work ID');
    const text=JSON.stringify({source:'panter-ai',event:'workforce_task_ready',work_id:workId});
    try{
      const response=await this.send(this.url,JSON.stringify({text}),{
        'content-type':'application/json',
        'anthropic-version':'2026-10-21',
        authorization:'Bearer '+this.token
      });
      const data=response.body&&typeof response.body==='object'?response.body as Record<string,unknown>:{};
      const valid=response.status===200&&data.type==='routine_fire'&&
        typeof data.claude_code_session_id==='string'&&
        /^session_[A-Za-z0-9_-]{12,200}$/.test(data.claude_code_session_id);
      return signal(true,valid,response.status,valid?String(data.claude_code_session_id):null);
    }catch{
      // Do not leak the URL, token, or network errors.
      return signal(true,false,null);
    }
  }
  describe(){return {configured:this.configured,
    adapter:this.configured?'CLAUDE_CODE_ROUTINE_API':'NONE'};}
}
