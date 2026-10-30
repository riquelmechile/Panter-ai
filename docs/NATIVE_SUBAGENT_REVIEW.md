# GPT-A-only native-subagent review (v0.11 developer preview)

Panter-ai can now **prepare and collect** independent 4R or Judgment Day reviewer work with GPT-A as the only authenticated MCP host. Remote GPT-B, Grok, Gemini and Claude connections are not needed. The MCP never creates LLM agents or calls inference APIs: the ChatGPT host launches its own genuinely available native subagents. Model choice, MAX/xhigh effort, Fast and parallelism are requested host-side, not imposed or proven by Panter-ai.

## Procedure

1. GPT-A completes authorized changes and obtains the real Git candidate SHA through its trusted Git tools. `candidateSha` is **host-provided**, not cryptographically verified by this preview.
2. GPT-A invokes `panter_native_review_create` with `missionId`, `objective`, `candidateSha`, unique `idempotencyKey`, and `kind=4r` or `judgment-day`. The server durably freezes four lens slots (`review-risk`, `review-readability`, `review-reliability`, `review-resilience`) or exactly two **blind** judge slots (`jd-judge-a`, `jd-judge-b`). It does not queue any remote A2A work.
3. Call `panter_native_review_batch` with `reviewId` and the **observed** GPT-A native parallel capacity. The tool returns a bounded independent packet per outstanding slot, each containing the pinned Gentle Shell agent definition and selected MCP skills. `concurrentSlots` caps *requested* simultaneous child invocations. If zero native children are available, hold independent review pending; GPT-A cannot self-certify independent review.
4. GPT-A uses its **actual host-native subagent tool** (when exposed), launching one fresh child per slot. Do not share sibling outputs, particularly blind judge reports. Keep implementations and reviews in separate child contexts. Preserve Fast worker preference and MAX reasoning as host-supported requests; never downgrade silently. Child agents may inspect the frozen candidate via their authorized host tools only.
5. Each child returns a structured report: `{ agentId, candidateSha, packetDigest, subagentRunId, evidence: string[], findings: {id,location,severity,claim,proofRefs[]}[] }`. GPT-A calls `panter_native_review_submit` once per slot. The server validates SHA, digest, agent, evidence and finding structure, rejects reused child run IDs, persists an immutable SHA-256 receipt, and allows exact idempotent retries.
6. `panter_native_review_progress` returns remaining reviewers, all findings and severe triage. Only **reported** evidence is aggregated. A complete clean review is `READY_FOR_RDD_CONTROLLER`, not `APPROVED`. Severe findings are `FINDINGS_REQUIRE_TRIAGE`; require explicit authorized corrections and a *fresh* review for a corrected SHA. Judgment Day correction/re-judgment still belongs to an external authorized controller; this preview never automatically issues fix permissions.
7. For official `gentle-ai.review-integration/v2` approval, an **installed and verified** Gentle AI Go runner in a supported Git runtime must perform its provider-issued risk, review, consent, correction, validation and terminal acknowledgement transitions. The existing `NativeReviewBridge` remains read-only. Do not present host-reported child IDs or a Panter digest as official Go evidence.

## MCP tool map

| Tool | Role |
| --- | --- |
| `panter_native_review_create` | Freeze 4R/JD slot definitions with candidate SHA and idempotency |
| `panter_native_review_batch` | Return all pending, separately bounded child/skill packets and requested parallelism |
| `panter_native_review_packet` | Read exactly one child's skill packet (e.g. after context loss) |
| `panter_native_review_submit` | Validate and persist immutable host-reported result/receipt |
| `panter_native_review_progress` | Recover pending work, warnings, severe findings; **never** grants approval |
| `panter_native_review_capabilities / assess / status` | Read-only check against optional official Gentle AI binary |

## Security and execution limits

- All Panter native review tools are **GPT-A principal only**. Native subagent run IDs are reported by GPT-A and are **not independently attested**. Store is atomic JSON for a **single** Panter process; do not scale multiple replicas on the same directory.
- The authority controller must verify the **actual** Git repository, frozen candidate, test evidence and review lifecycle. There is no autonomous model wake, sandbox, Git shell or official review approval in this feature.
- Freeze slots with the current vendored skills. If packaged catalog contents change before retrieval, the digest check rejects stale packets. Produce a **new** review ID and idempotency key for a new candidate. A restart preserves completed reports and pending slots.
- Separate 4R reviewers are not necessarily four different base models; they may be four **distinct native GPT-A host child executions**. Genuine separation is a host property, not a database claim.
- Don't use `panter_review_start` (remote A2A) in GPT_A_ONLY mode. This feature does not mutate `main`, push to GitHub, or deploy Oracle.

## Acceptance not yet demonstrated

- Real ChatGPT host tools exposing native subagents and their actual Fast/MAX parallelism.
- Real Git candidate checks and Go provider-owned native review approval, corrections/validation and acknowledgement.
- Oracle runtime, multi-process persistence, and sandboxed Git worktrees.
