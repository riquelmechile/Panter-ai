# Native RDD and no-workforce GPT-A continuity (v0.9)

## GPT-A works with no peers

The remote workforce is **optional**, not a dependency for completing development. Panter exposes a GPT-A-authenticated **durable** ODD ledger via `panter_native_mission_create`, `panter_native_flow_start`, `panter_native_phase_enqueue`, `panter_native_phase_claim`, `panter_native_phase_packet`, `panter_native_phase_complete`, `panter_native_flow_status`, `panter_native_candidate_freeze` and `panter_native_flow_close`. GPT-A may enqueue only scout, designer or builder phases through this surface. A verifier/reviewer cannot be faked by self-reporting; high-risk flows remain blocked for independent verification. Panter also offers `panter_native_plan`, `panter_native_packet`, and `panter_native_odd_instructions` to GPT-A without preexisting remote agent profiles, skill installations or a peer connection. A peer that is not explicitly `CONNECTED` is ineligible; UNKNOWN is not online. Agent Studio stores GPT-A preferences `preferNativeSubagents` and `maxRequestedNativeWorkers` (up to 32). These are only ceilings; `panter_native_plan` intersects them with the runtime capability report. The host supplies a capability report which is only `HOST_REPORTED_UNVERIFIED` and does **not** itself spawn any agents.

- Small, clear, recoverable work: parent GPT-A inline, run focused checks and ordinary repository policy.
- Missing understanding: parent runs a read-only exploration phase inline or with an actual native subagent if exposed by the host; load its MCP skill packet just-in-time.
- Large, multi-step work: maintain the one ODD specification and memory mirror. Preserve original request, task IDs and exact evidence. Execute tasks sequentially if no subagents exist.
- Concurrent native subagents: request only when the host **actually supports** independent agents and work units are independent. Respect the host's observed/conservative concurrency cap and non-overlapping write surfaces. The MCP cannot force workers or model/effort selection.
- Peer returning later does not reassign active writes automatically; uncertain outcomes stay blocked until reconciled.

The orchestrator can read `assets/orchestrator*.md` from the pinned upstream package; Pi-specific commands, identity/persona directives, local process semantics, RDD provider-specific tools, and native review callbacks are informational only and cannot override actual host abilities, tools or permissions. Skills are stored on the MCP and injected only into the relevant packet. No paid inference APIs are used.

## Official native RDD review

**Native review is not a generic model-based 4R.** The authoritative controller is the official `gentle-ai review-integration/v2` Go runtime. It freezes the real Git candidate, assesses risk, verifies actual review evidence, controls consent, correction and final-ack lifecycle. `panter_review_start` is only fanout to remote specialists and **cannot itself approve a change**. `panter_review_evidence` reports whether model outputs are bounded to the exact SHA and contain structured findings; any result remains `EVIDENCE_COLLECTED_UNVERIFIED` at most.

The optional `NativeReviewBridge` invokes the official `gentle-ai` executable only in an operator-pinned local worktree. It supports **read-only** `review capabilities`, `review assess --json` and `review status --contract gentle-ai.review-integration/v2 --next-transition --json`, never raw shell/parameters supplied by the model. It does not execute `review start`, capture, repair, acknowledgement, merge or deployment and never declares a terminal native approval. A runner operating a supported review host (Claude Code, Codex, OpenCode or Pi as supported in upstream) must follow the exact provider-issued transition and human consent. ChatGPT web is not automatically an official `gentle-ai` review host. In its absence, approval remains pending; use normal isolated CI and human review policies rather than forged RDD receipts.

To enable read-only native status on Oracle after installing the actual official binary and preparing a trusted non-user-writable checkout, set:

```dotenv
PANTER_NATIVE_REVIEW_ENABLED=1
PANTER_GENTLE_AI_BIN=/usr/local/bin/gentle-ai
PANTER_NATIVE_REVIEW_WORKTREE=/srv/panter/worktrees/project-review
```

Do **not** expose a general shell tool to models. Verify candidate tree hash and CI on the exact worktree through approved tools. Git repositories managed by a different trust boundary must never be selected via arbitrary tool arguments. The bridge fails closed if the binary/repository are unavailable. Native approval and release are separate decisions; a successful review does not authorize a push, PR merge or deployment.

## Remaining proof gates

- Verify fallback in a real ChatGPT host with no peer connection; confirm actual native subagent creation or ordinary inline completion, never assume it from a declared capability.
- End-to-end `gentle-ai` binary on isolated Oracle worktree, v2 protocol conformance and consent handling; this read-only adapter alone is not the entire native review lifecycle.
- Integrate verified Git candidate evidence, authorized correction transitions and true runtime-identity receipt checks, then wire to protected delivery gate.


## GPT-A maximum-capability contract (v0.10, Xanxittoo parity)

**No remote workforce never means downgraded reasoning.** Operator selection `GPT_A_ONLY` (saved in Agent Studio or supplied per `panter_native_plan` turn) **disables remote A2A dispatch even when peers are CONNECTED**. `AUTO` uses remote specialists only when they are explicitly connected and assigned. If no eligible peers are present, GPT-A operates alone automatically. This choice is independent of request quality and native fanout.

For **both** conditions Panter explicitly requests the same host control posture as Xanxittoo's `host_policy.py`:
- Root: `gpt-6-astra` (model request), `max` reasoning, `xhigh` fallback **only if the host does not expose `max`**, ordinary root service tier. Do not switch to a weaker model merely because peers are absent.
- Native branches: prefer Fast/priority processing with full model/effort; when Fast is unavailable, standard processing **preserves reasoning quality**.
- Parallelism: request up to 32 native workers, bounded by observed support, independent tasks, and allowed file/worktree isolation. Keep host-native fanout distinct from remote peer count. Never invent workers.
- When no native subagents exist, run ODD inline using the **same maximum-quality root** and available parallel I/O. Preserve scoped write permissions, frozen review candidates and independent verification gates.

`panter_native_plan` returns `capacityContract` and `capacityGaps`. The former is always a `REQUESTED` policy and the latter explicitly identifies observed capability shortfalls; `fullCapacityObserved` is always false until real host-side attestation exists. No MCP server can itself switch a consumer ChatGPT model/tier or create invisible subagents. If it cannot obtain an effective capability, it must disclose this, not silently downgrade or claim full compliance.

A user can select GPT-A-only for one session (`coordinationMode: GPT_A_ONLY`) without changing the saved Agent Studio preference; the saved mode applies to later calls without an explicit per-turn override. The server does not write to other hosts in this mode.
