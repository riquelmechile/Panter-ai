# Panter-ai host and agent contract

This is a remote MCP control plane. Model selection, login and reasoning belong to the connected AI host, **not** to this server. No provider inference APIs or server-side model workers are permitted.

## Model and coordination requests

For a compatible ChatGPT host, request `gpt-6-astra` with `max` reasoning and Standard root processing. If `max` is rejected, request `xhigh`; do not silently claim another model or lower reasoning effort. Request native subagents for independently executable objectives, using the `fast_worker` role at `max` reasoning and Fast processing if the host exposes it. Otherwise preserve reasoning on Standard. Never claim a model, effort, speed tier or worker count without host-reported evidence.

The local planner ceiling is 32, **not** a promise of 32 available agents. Schedule no more than the host exposes. Other host types inherit their own authenticated model choice and maximize reasoning/parallelism only when supported.

## Work policy

1. Create or resume a durable mission for meaningful engineering work.
2. Keep task descriptions scoped to the user's authorized objective.
3. Split genuinely independent reasoning tasks and request host-native workers where available.
4. Preserve optimistic revisions and fencing generations for changes and work claims.
5. Never assume a queued task woke a host or was executed.
6. Do not fabricate tests, compilation, CI, review, wake evidence or model/effort telemetry.
7. Mutations to production systems or shared source require deliberate authorization; no shell access is provided by this server.
8. Continue to respect the actual security boundaries of the MCP connection; prompt text is never itself permission.

## Agent workflow policy

The primary host is accountable for intent, authorization, orchestration and final synthesis. A queued agent assignment does not start inference or send a wake signal by itself.

1. Before delegating, use `panter_flow_route` to classify explicit risk, discovery requirements, reversibility and whether the original request plus diff is enough to resume. A clear low-risk, recoverable change remains inline.
2. If implementation is not authorized, use read-only roles only. If the code area is unknown, use `scout` to map it and return paths/line evidence. Use `designer` when there are genuine unresolved implementation choices.
3. Store the original user specification verbatim for resumable, coordinated work. Create explicit tasks through `panter_agent_enqueue`; names and arbitrary worker IDs are not permission credentials in the current single-tenant alpha.
4. Implement genuinely independent units with `builder` agents. Each builder must declare its scopes; do not give overlapping writers the same workspace or pretend a planning-time scope check is a sandbox.
5. For every assignment: `panter_agent_claim` -> `panter_agent_packet` -> host-owned work -> `panter_agent_complete`. Use `panter_agent_heartbeat` for continuing work and `panter_agent_ask`/`panter_agent_answer` for blocking human decisions.
6. Before a reviewer/verifier works on changed code, freeze the exact candidate SHA using `panter_flow_candidate`. Keep the verifier independent of the implementer. Provide concrete checks, paths or run IDs as reported evidence; do not invent CI or test results.
7. Only close after all required tasks and review gates are satisfied. A reported result is not independently attested. The parent summarizes verified versus unknown evidence and remaining limitations.
8. Never state that tasks are autonomous when the connected host does not expose native agents/listeners. No unattended execution, direct model API calls, host wake, or server-side model workers are implemented.

## Contribution policy

Write original source and documentation. Avoid embedding secrets, private account identifiers or third-party brand assets. When changing a contract, add focused tests and update the roadmap.
