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

/** Ring the oldest queued Grok work that was never rung, when Grok is free. Any queued Grok work counts (directed
 * panter_mesh_delegate, delegate_auto or harness phases): before, directed work was never rung and waited forever,
 * and an earlier unrung work kept Grok looking busy. Called after a directed delegate and on a periodic sweep;
 * the exclusive reservation keeps it to one outstanding ring at a time. */
export async function ringNextGrokWork(mesh:MeshEngine,grok:RoutineDoorbell,minAgeMs=0):Promise<RingOutcome&{workId?:string}>{
  if(!grok.configured)return {rung:false,reason:'NOT_CONFIGURED'};
  // The sweep skips work younger than minAgeMs: its creator may still be attaching a GitHub grant.
  const now=Date.now();
  const queued=(await mesh.pending('grok')).filter(w=>now-Date.parse(w.createdAt)>=minAgeMs)
    .sort((a,b)=>a.createdAt.localeCompare(b.createdAt));
  for(const w of queued){
    const r=await ringGrokForWork(mesh,grok,w.workId);
    if(r.reason==='ALREADY_RUNG'||r.reason==='NOT_QUEUED')continue;
    return {...r,workId:w.workId};
  }
  return {rung:false,reason:'NOT_QUEUED'};
}

/** How many pickup limits a Grok work may wait, unrung, behind other Grok work before it ages anyway (so a stuck
 * blocker, e.g. a work left RUNNING or OUTCOME_UNKNOWN, can never stall a harness phase forever). */
export const GROK_MAX_WAIT_LIMITS=4;
/** When the pickup clock of a harness work starts. Grok (rung one work at a time): at its ring; while not yet rung
 * it does not age (it is rung on a later tick once Grok is free), up to GROK_MAX_WAIT_LIMITS limits since creation.
 * Everyone else: at creation. */
export async function pickupClockStart(mesh:MeshEngine,grok:RoutineDoorbell,work:{id:string;target:string;createdAt:string},limitMs:number):Promise<string|null>{
  if(work.target!=='grok'||!grok.configured)return work.createdAt;
  const status=await mesh.grokWakeStatus(leaderHost(),work.id).catch(()=>null);
  if(status?.reservedAt)return status.reservedAt;
  if(Date.now()-Date.parse(work.createdAt)>GROK_MAX_WAIT_LIMITS*limitMs)return work.createdAt;
  return null;
}
