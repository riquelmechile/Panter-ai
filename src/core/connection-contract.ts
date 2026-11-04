import type { ActorProfile } from './mesh.js';

/** Quote a stored value so it can never be read as an instruction, even if it predates validation. */
const q = (v: string) => JSON.stringify(v);

/** Per-connection execution contract, appended to the MCP initialize instructions so the host
 * learns at connect time how it must run for this Panter identity. These are requirements the
 * host applies: Panter has no provider access and cannot verify the model, effort, service tier
 * or worker count actually used. Only identifiers, numbers and booleans are interpolated. */
export function buildConnectionContract(actor: string, leader: boolean, profile: ActorProfile | undefined,
  leaderPolicy?: { model: string; reasoningEffort: string }): string {
  if (leader) {
    const policy = leaderPolicy ? ` Request model ${q(leaderPolicy.model)} with reasoning effort ${q(leaderPolicy.reasoningEffort)} in your own host.` : '';
    return ` CONNECTION CONTRACT: you are connected as ${q(actor)}, the Panter leader (orchestrator). You delegate work and read results; you never claim or complete worker work.${policy}`;
  }
  if (!profile) return ` CONNECTION CONTRACT: you are connected as ${q(actor)}, a Panter worker. No execution profile is configured yet.`;
  const x = profile.executionRequest ?? {};
  const parts = [`model ${q(profile.modelRequest)}`, `reasoning effort ${q(profile.effortRequest)}`];
  if (x.serviceTier) parts.push(`service tier ${q(x.serviceTier)}`);
  if (x.stream !== undefined) parts.push(`streaming ${x.stream ? 'on' : 'off'}`);
  if (x.parallelToolCalls !== undefined) parts.push(`parallel tool calls ${x.parallelToolCalls ? 'on' : 'off'}`);
  if (x.maxNativeSubagents !== undefined) parts.push(`up to ${Number(x.maxNativeSubagents)} concurrent native subagents`);
  return ` CONNECTION CONTRACT: you are connected as ${q(actor)}, a Panter worker. This connection REQUIRES ${parts.join(', ')}. `
    + 'Apply these settings in your host for all Panter work on this connection wherever the host lets you select them; '
    + 'each delegated work repeats them in work.executionRequest. In every completion, report the model, effort, tier and '
    + 'subagent count you actually used, and never claim values you did not observe.';
}
