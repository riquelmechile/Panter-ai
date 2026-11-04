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
  // The busy rule is decided atomically with the reservation, so concurrent ticks never ring two works.
  const reserved=await mesh.reserveGrokWake(leader,workId,true);
  if(!reserved.send)return {rung:false,reason:'busy' in reserved&&reserved.busy?'PEER_BUSY':'ALREADY_RUNG'};
  const response=await grok.dispatch(workId);
  await mesh.finishGrokWake(leader,workId,response.accepted,response.statusCode);
  return {rung:true,reason:'RUNG',accepted:response.accepted};
}

/** When the pickup clock of a harness work starts: for Grok (rung one work at a time) at its ring, and not at
 * all while it waits for Grok to be free; for everyone else at creation. */
export async function pickupClockStart(mesh:MeshEngine,grok:RoutineDoorbell,work:{id:string;target:string;createdAt:string}):Promise<string|null>{
  if(work.target!=='grok'||!grok.configured)return work.createdAt;
  const leader=leaderHost();
  const status=await mesh.grokWakeStatus(leader,work.id).catch(()=>null);
  if(status?.reservedAt)return status.reservedAt;
  // Same rule as the exclusive ring: waiting behind another Grok work in progress or rung-and-unclaimed.
  const others=(await mesh.inbox(leader)).works.filter(w=>w.target==='grok'&&w.id!==work.id);
  if(others.some(w=>w.state==='RUNNING'||w.state==='OUTCOME_UNKNOWN'))return null;
  for(const w of others.filter(w=>w.state==='QUEUED'))
    if((await mesh.grokWakeStatus(leader,w.id).catch(()=>null))?.reservedAt)return null;
  return work.createdAt;
}
