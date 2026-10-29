# Gentle Shell compatibility in Panter-ai (host-native MCP profile v0.7)

Panter-ai vendors **all ten** Gentle Shell upstream specialist prompt definitions and **all thirteen** upstream `SKILL.md` files from the exact commit in `src/core/gentle-catalog.ts`. The bundled `assets/orchestrator*.md`, review chain and skill references are also available as upstream reference files. They retain their original text and MIT license attribution in `vendor/gentle-shell/LICENSE`.

**Panter is not the Pi shell.** The upstream author runs subagents as local Pi processes, supports shell/TUI/Engram, and uses runtime-owned native review/RDD contracts. Consumer ChatGPT, Claude, Grok and Gemini apps do **not** automatically support those capabilities. Panter adapts agent *roles, task-selection rules, skill content and review intentions* into authenticated MCP work packets; host execution requires that actual connected app to claim and complete the task. Upstream-only CLI instructions have no authority inside Panter, and the dispatch packet explicitly says so.

## Configuring from ChatGPT

1. Connect GPT-A as the orquestator using its own OAuth-approved client. Authenticate GPT-B, Grok, Gemini and Claude separately. The host labels are identities, not interchangeable model names.
2. Invoke `panter_agent_studio` as GPT-A. Configure each host connection and its allowed broad roles (implementer, explorer, verifier, reviewer...).
3. For **each of the ten specialist definitions**, choose its target host, requested model/effort and selected skill IDs from the MCP-hosted catalog, then save with CAS revision. A single host may serve many roles; each role may ask for a different model.
4. GPT-A uses `panter_flow_route` to decide if small work stays inline, needs discovery, or warrants independent verification. Invoke `panter_review_blueprints` to inspect assignments; `panter_review_start` atomically dispatches four 4R lenses or two initially blind Judgment Day judges against one frozen candidate SHA.
5. For coordinated work call `panter_specialist_delegate` with mission, `agentId`, objective and idempotency key. An implementer additionally **requires a narrow set of allowed edit surfaces**, and read-only verification requires the frozen candidate SHA. The server resolves only the selected skills, stores a hash-bound immutable packet and assigns it to the configured authenticated host.
6. A worker sees pointers in `panter_mesh_pending`, claims using `panter_mesh_claim`, receives the frozen specialist definition and its skills, executes only through its own *authorized* tools, and returns `panter_mesh_complete` or `panter_mesh_message`. GPT-A recovers results with `panter_mesh_inbox` and may observe MCP `subscriptions/listen` notifications if the client supports them.

### Available specialists

`gentle-ai-explore`, `gentle-ai-worker`, `gentle-ai-verify`, `review-risk`, `review-readability`, `review-reliability`, `review-resilience`, `jd-judge-a`, `jd-judge-b`, `jd-fix-agent`.

### Available skills

`branch-pr`, `chained-pr`, `cognitive-doc-design`, `comment-writer`, `design`, `gentle-ai`, `issue-creation`, `judgment-day`, `rdd-defect-workflow`, `skill-creator`, `skill-improver`, `skill-registry`, `work-unit-commits`.

## Review semantics and limitations

- The **4R** controller dispatches four lens-specific tasks atomically against the same frozen SHA; GPT-A retrieves their results through `panter_review_status`. A returned review is **reported evidence**, not an independent cryptographic verification of the underlying host model or changed tree.
- **Judgment Day** is *not* a generic automated review. Its two judges must not see each other's findings before both reports are frozen. Scoping fixes and the bounded two-round rejudgment controller remain separate work; the `panter_review_start` method dispatches **exactly two blind judges** and requires different hosts; the conditional correction/final-judgment controller remains unimplemented, so **no autonomous authoritative JD approval** is claimed.
- The catalog is **fixed-version and allowlisted**. Skills are read on demand and embedded inside the exact task that gets persisted. Skill text never grants filesystem access, MCP permissions or a model setting that the host has not confirmed.
- Binding/model requests cannot choose the ChatGPT, Claude, Gemini or Grok consumer app's actual internal model without host support; requested settings are descriptive until verified.
- Upstream dependencies (Pi local process, TUI, Engram memory, native review provider) are not shipped and not emulated. Git worktrees, actual write sandbox, native subagent launch, host-native wake and transactional cross-process persistence remain separate integration gates.
- The existing `panter_agent_*` admin-only planning engine remains available for legacy tests but **must not be used as a second execution authority** alongside mesh A2A for one work item. For external collaboration use `panter_specialist_delegate` and the `panter_mesh_*` claim/complete path exclusively.

## Attribution

Gentle Shell assets: <https://github.com/Gentleman-Programming/gentle-shell>, commit `3210886c79360a9f47ac3ca0cd2c1edf43b2432e`, MIT license. Panter-ai code is an original MCP runtime adapter and does not copy the Pi agent launcher.
