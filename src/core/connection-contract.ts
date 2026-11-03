import type { ActorProfile } from './mesh.js';

/** Per-connection execution contract, appended to the MCP initialize instructions so the host
 * learns at connect time how it must run for this Panter identity. These are requirements the
 * host applies: Panter has no provider access and cannot verify the model, effort, service tier
 * or worker count actually used. */
export function buildConnectionContract(actor: string, leader: boolean, profile: ActorProfile | undefined): string {
  const role = leader ? 'the Panter leader (orchestrator)' : 'a Panter worker';
  if (!profile) return ` CONNECTION CONTRACT: you are connected as ${actor}, ${role}. No execution profile is configured yet.`;
  const x = profile.executionRequest ?? {};
  const parts = [`model ${profile.modelRequest}`, `reasoning effort ${profile.effortRequest}`];
  if (x.serviceTier) parts.push(`service tier ${x.serviceTier}`);
  if (x.stream !== undefined) parts.push(`streaming ${x.stream ? 'on' : 'off'}`);
  if (x.parallelToolCalls !== undefined) parts.push(`parallel tool calls ${x.parallelToolCalls ? 'on' : 'off'}`);
  if (x.maxNativeSubagents !== undefined) parts.push(`up to ${x.maxNativeSubagents} concurrent native subagents`);
  return ` CONNECTION CONTRACT: you are connected as ${actor}, ${role}. This connection REQUIRES ${parts.join(', ')}. `
    + 'Apply these settings in your host for all Panter work on this connection wherever the host lets you select them; '
    + 'each delegated work repeats them in work.executionRequest. In every completion report the model, effort, tier and '
    + 'subagent count you actually used, and never claim values you did not observe.';
}
