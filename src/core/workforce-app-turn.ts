import { LISTEN_WAIT_SECONDS } from './workforce-long-poll.js';
/** Native in-app workforce entrypoint for ChatGPT and Gemini. The MODEL/HOST
 * initiates this MCP call using its own approved OAuth connection: Panter has
 * no provider API, CLI runner, background model process, or authority to make
 * an inactive chat autonomously generate a new turn.
 */
import { leaderLabel, isAppEventHost } from './leadership.js';
import type {Host,MeshEngine} from './mesh.js';

type ProtocolEra='2025-11-25'|'2026-07-28';

export async function appWorkforceTurn(mesh:MeshEngine,caller:Host,
  protocolEra:ProtocolEra,leaseSeconds=900){
  if(!isAppEventHost(caller))
    throw Error('Native ChatGPT/Gemini app OAuth worker required');
  if(!Number.isInteger(leaseSeconds)||leaseSeconds<30||leaseSeconds>3600)
    throw Error('Invalid lease');
  // Authenticated client call, not a self-reported scheduler/listener.
  await mesh.workforcePoll(caller,{protocolEra,deliveryMode:'DELIVERY_ONLY'});
  const pickup=await mesh.pickup(caller,leaseSeconds);
  if(pickup.status==='EMPTY')return {
    status:'EMPTY' as const,actor:caller,
    instruction:'No work assigned. Do not invent completion. If you run as a standing Panter worker, call panter_workforce_wait next: it blocks on the server until work arrives or the wait times out, so it is not a tight loop. Otherwise stop.',
    nextTool:'panter_workforce_wait' as const,
    nextArguments:{protocolEra,waitSeconds:LISTEN_WAIT_SECONDS},
    transport:'IN_APP_MCP_TOOL' as const,autonomousWakeVerified:false as const
  };
  if(pickup.status==='OUTCOME_UNKNOWN')return {
    ...pickup,actor:caller,transport:'IN_APP_MCP_TOOL' as const,
    instruction:`Uncertain outcome; stop. ${leaderLabel()} must reconcile before any replay.`,
    autonomousWakeVerified:false as const
  };
  return {
    status:'CLAIMED' as const,actor:caller,transport:'IN_APP_MCP_TOOL' as const,
    work:pickup.work,
    nextTool:'panter_workforce_complete_and_rearm' as const,
    instruction:'Perform only the claimed objective using host-native tools; when genuinely finished, submit the fenced result with the exact workId, attemptId and leaseGeneration. Do not claim completion just because MCP returned.',
    autonomousWakeVerified:false as const
  };
}
