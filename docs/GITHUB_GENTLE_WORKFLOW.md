# Status update (v0.15)

GitHub PR proof now flows automatically into the **Panter-RDD** controller, not a mandatory official Go lifecycle. An operator can persist a large-PR strategy through `panter_harness_delivery_strategy_set` (admin only), reused by automatic tick and review. No human consent is inferred from model statements. The original rules below remain applicable to branch naming, approved issue, type label, CI and PR review workload; references to official Go as mandatory are historical.

# Automatic Gentle Shell GitHub policy for Panter-ai (v0.13)

## Scope and authority

This is a **read-only, GitHub-verified destination gate** integrated with the automatic ODD harness. GPT-A chooses the next agent and skill automatically; the user is **never** asked to select a review lens or specialist. It is not an automatic GitHub publisher. Remote commits, push, PR creation, branch deletion, merges, releases, deploys, permission grants and `size:exception` labels remain independent, explicitly authorized operations.

Source-of-policy references (upstream Gentle Shell; do not run Pi-specific process instructions on ChatGPT):

- `skills/branch-pr/SKILL.md` — destination and authorization, approved linked issue, exactly one `type:*` label, branch/Conventional Commit formats, exact required CI.
- `skills/work-unit-commits/SKILL.md` — commit by deliverable behavior with its tests and docs, not by file type.
- `skills/chained-pr/SKILL.md` — about 400 changed lines for reviewability; propose a conscious one-PR vs chain strategy. Never omit tests or code-golf.
- `assets/orchestrator-{tracking,verification,writer}.md` — ODD evidence, actual risk, source-write scopes, independent verification.

The checked-in upstream files are **instructions/catalog**, not authority to bypass repository-specific protected branches, explicit approvals, or GitHub's own rulesets. Some upstream skills are Apache-2.0 licensed even though Gentle Shell's repository root is MIT; preserve individual upstream license metadata and attribution.

## Automatic path

1. GPT-A inspects the authorized `origin`/destination through its GitHub/Git tooling and supplies `githubRepository: owner/repo` to `panter_harness_start` **only when that repo belongs to the operator allowlist**. It may also supply an existing observed `githubPrNumber` and `githubExpectedBase`. These are repository facts, **not** a user agent selection.
2. Panter-ai runs ODD phases. The implementation result for GitHub work **must include the actual 40-character Git commit SHA**. A host-provided SHA is not sufficient proof of a repository or CI result.
3. With an observed PR number, subsequent `panter_harness_tick` automatically reads GitHub's PR HEAD, destination, linked issue, labels, commit messages, total diff size and check runs. Without a PR it returns `AWAITING_GITHUB_PR_EVIDENCE` (it does not create one). On request `panter_harness_github_check` can revalidate the same frozen SHA for an exact PR; the tool cannot substitute a different SHA.
4. For the upstream `branch-pr` policy, every submitted PR must link a real issue labeled `status:approved`, have exactly one recognized `type:*` label, use a `type/description` branch, and contain conventional work-unit commits with no `Co-Authored-By` trailers. Do not assume a GitHub PR is ready merely because some generic CI action is green.
5. Operator declares *actual* required check names in `PANTER_GITHUB_REQUIRED_CHECKS`; Panter checks completed-success runs for the exact SHA. Missing configuration, pagination, permission errors, absent checks or mismatched SHAs fail closed. Branch protection and target-repository rules remain independently binding.
6. When changed lines exceed 400 (or configured budget), prefer coherent review slices; never remove documentation/tests or reformat code to lower the number. If no strategy was authorized, the gate blocks. One large PR requires a separately configured explicit authorization; **no model-provided boolean can assert user consent**. Protected `size:exception` is never auto-applied.
7. `REVIEWABLE` / `GITHUB_EVIDENCE_READY_NO_DELIVERY_AUTHORITY` means the **observed GitHub evidence** passed this configured gate, **not** native RDD approval and never permission to merge. A high-risk run still requires authorized native RDD validation. Always treat GitHub branch/ruleset restrictions as additional gates.

## Deployment configuration

```dotenv
# Read-only GitHub API gate. Nothing is queried outside the allowlist.
PANTER_GITHUB_ALLOWED_REPOS=riquelmechile/Panter-ai
# These are actual check-run names (not arbitrary CI run URLs).
PANTER_GITHUB_REQUIRED_CHECKS=test
# Optional fine-grained read-only token, supplied through secret manager only.
# PANTER_GITHUB_TOKEN=...
# Optional ONLY if human has explicitly authorized an oversize single PR.
# PANTER_GITHUB_SINGLE_PR_APPROVED=1
```

Never put `PANTER_GITHUB_TOKEN` into source, skills, an A2A packet or GitHub work instructions. If an operator hasn't established the required check names, the gate **must not** assert CI readiness. A public PR can be inspected without a token when GitHub allows it; private PR reads need an explicitly scoped read-only token.

## Current Panter-ai PR #1

As inspected on 2026-10-29, the draft PR had no `type:*` label, no approved issue linkage, and more than 8,000 changed lines. The automated gate must report these as outstanding, **not** invent approval or silently change the PR. A coherent delivery split would require an independent choice, not a surprise rewrite of the user's established PR.

## Limits and genuine native RDD

The official Gentle AI Go `review-integration/v2` controller owns review approval and terminal acknowledgement. The optional bridge currently supports **read-only** capabilities/assess/status; the host-side compatible runner and human consent are prerequisites before invoking the Go transition lifecycle. The Panter 4R/JD subagent reports are host-provided evidence, never a Go receipt. This gate does not silently upgrade them to native approval.

A real ChatGPT host may not expose native agent start/stop or the official Gentle AI provider relay. The MCP does not instantiate model workers or create background runs just by returning packets. If no host-native tool exists, continue with GPT-A's available tools and report the missing independent review capability.

### PR created or discovered after the run started

An engineering mission can begin before any PR exists. GPT-A can finish the scoped implementation and retain its exact Git SHA; the harness returns `AWAITING_GITHUB_PR_EVIDENCE`. After a **separately authorized** GitHub operation creates or finds the actual PR, GPT-A calls `panter_harness_github_bind` with that observed PR number, repository, target base and current harness revision. The server checks the operator repository allowlist, prevents reassignment to another repository or PR, and persists the association with optimistic revision fencing. A repeated identical bind is idempotent. Next `panter_harness_tick` checks GitHub automatically; no human agent or skill selection is needed. This call **does not** create a PR or authorize creating one.
