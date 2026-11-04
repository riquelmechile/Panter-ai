/** Doorbells for harness-dispatched work. The harness dispatches phases and review lenses through the mesh
 * directly, so hosts woken only by an operator-configured routine webhook (Grok) would otherwise never be rung:
 * only panter_mesh_delegate_auto rang them. A ring is a pointer, never instructions or credentials. */
import { leaderHost } from './leadership.js';
import { type MeshEngine } from './mesh.js';

export type RoutineDoorbell={configured:boolean;dispatch(workId:string):Promise<{accepted:boolean;statusCode:number|null}>};
export type RingOutcome={rung:boolean;reason:'NOT_CONFIGURED'|'NOT_QUEUED'|'PEER_BUSY'|'ALREADY_RUNG'|'RUNG';accepted?:boolean};

/** Ring Grok's routine for one queued harness work. One ring per work, and only when Grok has no other work in
 * progress or already rung and waiting (a ring that arrives while its routine is busy can be lost), so queued
 * lenses are rung one after another: the harness calls this again on every waiting tick. */
export async function ringGrokForWork(mesh:MeshEngine,grok:RoutineDoorbell,workId:string):Promise<RingOutcome>{
  if(!grok.configured)return {rung:false,reason:'NOT_CONFIGURED'};
  const leader=leaderHost();
  const target=await mesh.workTarget(leader,workId).catch(()=>null);
  if(!target||target.target!=='grok'||target.state!=='QUEUED')return {rung:false,reason:'NOT_QUEUED'};
  const own=await mesh.grokWakeStatus(leader,workId);
  if(own.state!=='DELIVERY_ONLY')return {rung:false,reason:'ALREADY_RUNG'};
  const others=(await mesh.inbox(leader)).works.filter(w=>w.target==='grok'&&w.id!==workId);
  if(others.some(w=>w.state==='RUNNING'||w.state==='OUTCOME_UNKNOWN'))return {rung:false,reason:'PEER_BUSY'};
  for(const w of others.filter(w=>w.state==='QUEUED'))
    if((await mesh.grokWakeStatus(leader,w.id)).state!=='DELIVERY_ONLY')return {rung:false,reason:'PEER_BUSY'};
  const reserved=await mesh.reserveGrokWake(leader,workId);
  if(!reserved.send)return {rung:false,reason:'ALREADY_RUNG'};
  const response=await grok.dispatch(workId);
  await mesh.finishGrokWake(leader,workId,response.accepted,response.statusCode);
  return {rung:true,reason:'RUNG',accepted:response.accepted};
}
