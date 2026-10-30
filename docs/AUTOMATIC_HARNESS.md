# Panter automatic ODD harness — v0.12 developer preview

Panter-ai follows the **organic** work routing of Gentle Shell: GPT-A receives the user objective and **never asks the user to choose an agent, skill, reviewer, review lens, model per task, or how many workers to start**. Agent Studio is for initial *optional* preferences only. The actual work route is selected dynamically according to scope, authorization, risk and observed host capabilities.

## The single GPT-A workflow

1. `panter_harness_start`: pass the exact goal, project, stable idempotency key, whether this user authorized source writes, known edit surfaces (if any), and optional *facts* about complexity. **Do not invent user write permission.** If source paths are unknown, the engine routes first to read-only discovery.
2. `panter_harness_tick`: GPT-A passes actual host-native agent/tool capabilities and optionally observed connected remote peers. This single operation chooses the next bounded ODD phase and the exact centrally versioned specialist/skill packet. When the selected specialist is configured and its host is explicitly connected in `AUTO`, it records a durable A2A delegation without asking the user to choose that specialist. In `GPT_A_ONLY` or peer-unavailable mode it returns GPT-A native child or parent-inline instructions. GPT-A executes the host-native work itself: Panter does **not** launch model inference.
3. `panter_harness_report`: GPT-A reports the real result and concrete evidence (discovery may include observed code paths, implementation may include a frozen commit SHA). This automatically returns the next packet. A remotely completed task with a structured JSON result is also reconciled automatically on a later `tick`; pending/unknown remote outcomes are never blindly retried.
4. `panter_harness_status`: recover the run and phase progress after reconnect or restart. State is stored in `harness.json`, one process only.
5. For high-risk changes, `tick` creates and returns either the automatically selected four native 4R subagent packets or an eligible fully configured remote review fanout. The four reviewers/skills are selected **by Panter-ai**. GPT-A dispatches the host-owned native subagent runs and records each via the existing `panter_native_review_submit`; `tick` reads their durable results. No human agent-picker step exists.

## Automatic risk and workflow

- Read-only work: read-only exploration, never source edits.
- Small, known, recoverable, low-risk change: parent-inline implementation plus applicable focused tests, without costly automatic 4R.
- Unknown source paths: exploration and ODD design, then block edits until a discovery report supplies narrow paths. Unclear/high-risk changes keep an independent SHA-bound verification phase.
- Security, OAuth, authentication, database, migrations, secrets, permissions, billing, deployment, concurrency, or an unknown scope: treat as HIGH; schedule design, implementation, independent verification and all four 4R lenses. Unresolved uncertainty is not permission to skip a gate.
- Judgment Day is **not** an automatic response to every task in Gentle Shell. Activate it only when the user explicitly requests it (the host forwards `judgmentDayRequested=true`). The engine selects the two blind judges automatically; no judge is manually picked.
- For any implementation/review: exact scope and frozen candidate, no overlapping writers, no self-verifier acceptance. A run/receipt identifier is *host-reported*, not cryptographic proof of independence.

## Maximum-capacity policy

Same model request as Xanxittoo: `gpt-6-astra`, `max` (fallback `xhigh`), native workers with Fast processing when exposed, observed native capacity up to a planner ceiling of 32. A capability request is not evidence of an actual ChatGPT model switch or of subagent creation. GPT-A continues inline when no subagents exist. A transition to `GPT_A_ONLY` prohibits fresh remote delegations even for a previously created `AUTO` run, without silently reassigning uncertain in-flight remote writes.

## Authority and limitations

- Panter stores exact specifications, versioned packets, host reports and status. It does not execute Git, a shell, local Pi processes, Codex, or external model inference.
- The MCP automatically selects and *prepares* next steps and remote A2A dispatches when available; the host app must actually invoke its native subagents and submit their results. A conversation that never calls the next MCP tool does not autonomously resume.
- Native reviewer slots are independent *by intended routing*, not independently attested by the MCP. Even four valid model reports cannot grant official Gentle AI RDD approval.
- The official Gentle AI Go RDD controller remains an optional read-only bridge; production closure needs an authenticated, consented, provider-issued RDD transaction plus real Git/CI evidence. High-risk `tick` stops at `AWAITING_RDD_AUTHORITY` or `REVIEW_FINDINGS_NEED_CORRECTION`, never claims approval or merges code.
- Human authorization for writes, privilege elevation, merges, releases and deployment remains separate. Never infer it from a skill or result.

## Source mapping

Gentle Shell's `assets/orchestrator.md`, `assets/orchestrator-{delegation,tracking,verification,writer,memory,skills}.md` guide the work-routing logic; Panter adapts, rather than executing, Pi-specific TUI/CLI and process semantics. Specialist/skill content is version-pinned under `vendor/gentle-shell` (MIT). Automatic routing does not load all assets for every task; only selected specialist packets are loaded.
