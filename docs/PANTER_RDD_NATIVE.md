# Status update (v0.15)

**Security correction:** Different host-reported `subagentRunId` values do **not** independently prove execution and can no longer obtain a positive Panter-RDD verdict. Every native reviewer must carry a valid Ed25519 signature from an operator-trusted *runner* covering `panter.review-run/v1` and the exact `reviewId`, `slotId`, agent, SHA, packet digest, run ID, evidence and findings. Public keys live in `PANTER_RDD_RUNNER_KEYS_FILE` (operator filesystem), private keys only in an external runner. Missing/invalid signatures cause `NEEDS_RUNNER_ATTESTATION`. A trusted local worktree can replace a GitHub PR only when a protected `PANTER_RDD_LOCAL_WORKTREES_FILE` supplies its fixed checkout and commands; Git HEAD, clean state and required checks are revalidated. **No implementation of a trusted host-runner is claimed by these software-only gates.** For 4R/explicit Judgment Day, authorized corrective changes must use a new SHA and fresh verifier and review. See [`CANONICAL_HARNESS_POLICY.md`](CANONICAL_HARNESS_POLICY.md).

# Panter-RDD — self-hosted review authority (v0.14)

Panter-RDD is **Panter-ai's independent review controller**, inspired by the safety properties of Gentle Shell/Gentle AI. It does not embed the official Gentle AI Go binary, impersonate a provider reviewer or claim official `gentle-ai.review-integration/v2` conformance.

## Purpose and automatic entry

The GPT-A automatic harness chooses the ODD phases and reviewer skills without user agent selection. For risk-classified high-impact changes, the harness routes `DESIGN → IMPLEMENT → VERIFY → REVIEW` and issues four native 4R subagent packets (or configured authenticated A2A reviews). Each packet includes the frozen Git commit SHA, pinned skill content and digest. `Judgment Day` remains explicitly activated, as in Gentle Shell.

The model-host application, not the MCP server, runs subagents, supplies tools and reports a distinct run identity. Panter-ai does not call model-provider inference APIs or falsely claim to create threads.

When reviewers finish, the harness automatically creates or resumes a Panter-RDD transaction and checks the review ledger and GitHub delivery gate. For a successful, exact-SHA, low-finding review with configured PR and verified checks, it records an acknowledged review and advances the ODD flow. No extra command or reviewer selection is required from the user. A receipt is scoped to the frozen candidate.

## State machine

```text
COLLECTING
   ├─ incomplete or non-independent reports → NEEDS_REVIEW_EVIDENCE
   ├─ BLOCKER/CRITICAL finding          → NEEDS_CORRECTION
   ├─ clean reports, GitHub proof absent → NEEDS_GITHUB_PROOF
   └─ clean reports + exact SHA GitHub verification → APPROVED_PENDING_ACK
                                                       └─ ACKNOWLEDGED

New authorized correction creates a different candidate SHA and a fresh review.
The old unacknowledged transaction is marked SUPERSEDED.
```

**Candidate identity and approval requirements:**

- An immutable 40-character Git commit SHA must match the source review ledger. A different PR HEAD invalidates readiness.
- Four 4R slots or both Judgment Day judges must provide complete receipts, frozen packet SHA/digests, concrete evidence and correctly shaped findings.
- Native reviewer run IDs must be distinct from one another, from `gpt-a`, and from the implementing run. These are **host-reported identities**, not cryptographically proven independent processes.
- A BLOCKER or CRITICAL finding blocks approval until a separately authorized correction changes the SHA and undergoes another review.
- Repository/PR must be in the operator allowlist. GitHub is checked server-side for exact HEAD, approved issue, labels, Conventional Commits, allowable review size and required CI on that SHA.
- No approved GitHub evidence, no positive Panter-RDD verdict. An unsupported or unavailable verifier fails closed rather than accepting a model statement.
- Review acknowledgement is NOT authorization for a commit, push, merge, release, deployment, permission escalation or correction scope expansion.

## MCP tools

`panter_harness_tick` automatically performs the review registration, evidence reconciliation and acknowledgement when prerequisites are met. `panter_rdd_status` gives GPT-A the durable status for a run, refreshing source/GitHub evidence; it is not a merge action. `panter_rdd_supersede` retires an unacknowledged review only when a separate fresh-SHA review has already been registered for that same mission; it never edits code or authorizes a correction.

The standalone API is intentionally not a tool that accepts `approved: true`, `testPassed: true` or arbitrary shell commands from a model. Panter-RDD itself obtains trusted GitHub facts using the preconfigured gate.

## Deployment and remaining proof

This is **developer preview** using a single-process atomic JSON store. Do not run multiple replicas on one store. The critical live acceptance tests still must observe an actual ChatGPT native-subagent launch and completion, validate the external GitHub PR/CI on Oracle, and test restart/correction recovery. Native child identity proof is only host-reported. Panter-RDD does not claim to implement the official Gentle AI review-integration protocol or its complete correction/consent/repair state machine.

The existing optional official Go bridge remains available for comparison; Panter-RDD does not require it. In this release, large GitHub PRs without an authorized delivery strategy, missing approved issue, missing `type:*` label or failed checks are intentionally blocked.
