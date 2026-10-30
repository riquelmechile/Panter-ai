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

## Organic harness default (v0.12)

Do not ask the user to choose specialist agents, skills, RDD lenses, or per-task worker counts. For a new engineering objective, GPT-A **must** call `panter_harness_start`, `panter_harness_tick`, run the selected host-native/native-subagent phase, and call `panter_harness_report` to continue. Re-query `tick` after a remote A2A completion or native review receipt. Derive the route from actual scope/risk evidence, never untrusted claims of a model being online. Older `panter_agent_*` and `panter_native_*` tools remain available for diagnostics/backward compatibility, not as required user-facing steps. Human consent is still required for source writes and deployment. See `docs/AUTOMATIC_HARNESS.md`.

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


## Panter MCP-hosted Gentle Shell catalog (v0.7)

GPT-A is the sole coordinator. Before first multi-host development, request user selection of host and desired model/effort for each of the ten specialist agents via `panter_agent_studio`. Agent descriptions and thirteen skills are version-pinned MIT assets in `vendor/gentle-shell`; the GPT-A tool `panter_gentle_catalog` enumerates them. Do not download or silently execute unapproved skills or assume the host uses the requested model.

For external-host work use `panter_specialist_delegate`, `panter_mesh_claim`, `panter_mesh_complete`, and the inbox. Keep `panter_agent_*` for legacy admin-only workflow planning; it must not be treated as a second authority for the same delegated work. The ODD classifier is `panter_odd_route`, 4R/Judgment Day atomic fanout is `panter_review_start`, and review results are reported (not independently attested) through `panter_review_status`. Implementers require narrow planned edit surfaces; runtime filesystem/tool enforcement remains a separate gate.

## GitHub destination policy (v0.13)

GPT-A applies the upstream Gentle Shell branch-pr, work-unit-commits and chained-pr policies automatically when the task is bound to GitHub. Derive `githubRepository` and any existing PR number from an operator-authorized, verified destination; users do not choose per-task agents or skills. Use conventional work-unit commits (behavior plus tests/docs), `type/description` branches and the actual target repo base. Require a target-approved linked issue, one valid `type:*` label, exact-SHA CI check results and GitHub branch/ruleset restrictions. Exceeding 400 changed lines prompts a conscious delivery strategy, not deleted comments, compressed code, missing documentation or skipped tests.

`panter_harness_tick` automatically queries GitHub for a bound completed run, and `panter_harness_github_check` verifies it again on demand. Neither operation mutates GitHub or grants permission to create commits, push, open a PR, apply labels, merge or deploy. Never treat model-reported test output, a GitHub URL or 4R subagent output as official Gentle AI Go RDD approval. Preserve missing or failed evidence and request only genuinely necessary approvals.

If a PR is created or discovered after implementation, call `panter_harness_github_bind` with its observed number and the same allowlisted repository. Never infer permission to create a PR from the ability to bind one. Resume automatic CI/diff inspection via `panter_harness_tick`.
