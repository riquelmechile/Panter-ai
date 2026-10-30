# Claude review and Oracle release candidate — 31 October 2026

**Scope:** PR [#1](https://github.com/riquelmechile/Panter-ai/pull/1), repository `riquelmechile/Panter-ai`, base `main`. This document prepares a **conditional** review/merge/private deployment. It is NOT a CI approval, a runner attestation, a merge authorization, or a guarantee that Claude will be connected tomorrow. Read the **live head SHA** before doing anything.

## Non-negotiable requirements

- Do not modify `src/core/policy.ts`: the GPT-A request stays `gpt-6-astra`, effort `max` / `xhigh` fallback, Fast native workers if supported, highest independent host parallelism up to planner ceiling 32. No inference-provider APIs.
- The issue #2 and bootstrap `single-pr` exception are operator approved. Preserve the entire app, tests, upstream skill licenses, Conventional Commits and exactly one `type:*` label.
- Claude must do an **actual independent review**, not sign off on GPT-A's solo four-lens self-review. If an attested native Panter-RDD review is required, provision a separate trusted runner whose Ed25519 private key is never accessible to models or checked into Git. A Claude PR review is not automatically a signed Panter-RDD receipt.
- Never auto-merge on a green build alone. Never deploy or modify the existing Xanxittoo Oracle service. A public-facing endpoint requires real-client OAuth/PKCE, a trusted operator channel, network isolation and a security review.

## Before Claude starts

1. Open PR #1 and record `head.sha`, `base=main`, `draft=false`, linked issue #2 with `status:approved`, exactly one `type:feature`, Conventional Commits and GitHub Actions on the **same SHA**. If the SHA changes during review, restart the SHA-bound approval.
2. Inspect all active review threads and issue #3. The historical Codex findings must be resolved individually only after verifying their code paths and regressions; do not treat comments as proof.
3. Review specifically: OAuth embedded/external and admin loopback identities; A2A writer grants and idempotent overlap; lease expiry; all candidate author IDs excluded from 4R; native/solo/Judgment Day separation; SHA binding and runner signatures; GitHub single-PR authorization; Engram persistence; Docker/Oracle isolation; OAuth/DCR cleanup.
4. From a trusted clean checkout of the exact branch SHA, run `npm run check`, `npm run build`, `npm test`, `npm run smoke:http`, `npm run smoke:oauth`, `npm run smoke:embedded`. Report the observed pass counts and compiler version. Tests demonstrate logic, not production host execution.
5. Review the committed `package-lock.json` generated from a clean GitHub Actions npm install on Node 22. CI and Docker must use `npm ci` and verify the exact lock hash. A moving Docker base tag and vulnerability/supply-chain review remain independent release checks. Never invent a lockfile.
6. Post review findings linked to the reviewed SHA; request changes on blockers. For a clean review, Claude may submit review APPROVE through its connected GitHub identity, subject to GitHub's author/branch rules and reviewer independence.

## Conditional merge gate

Only **after** all of the following are true: no unresolved blocking comments, fresh green checks (`test` and `arm64-image`) on the reviewed SHA, explicit favorable independent Claude review, dependency/build security requirements resolved, real trusted RDD evidence if the selected release policy requires it, repository rulesets satisfied, and the operator has confirmed the production release target and authorized merge. Use GitHub's actual merge action then confirm merged SHA. Never invent approval from Claude or force a merge past branch protection.

## Oracle private canary (do not confuse with Xanxittoo)

Panter is a separate MCP service; start with a **private loopback-only** canary on Oracle ARM64, not a public endpoint and not replacing any Xanxittoo container or tunnel.

Prerequisites: operator SSH and separate credentials, enough free memory/disk, free `PANTER_HOST_PORT` (default **18080**) and `PANTER_BIND_HOST` internal 0.0.0.0. Do not publish the Docker port in OCI firewall. Compose service must run as one replica with its own named volume.

```sh
# On the operator-controlled Oracle VM, once release authorization has been given:
git clone https://github.com/riquelmechile/Panter-ai.git panter-ai
cd panter-ai
git fetch --tags origin
git checkout main
git pull --ff-only origin main
git rev-parse HEAD                 # MUST equal authorized merged SHA
cp .env.example .env
chmod 600 .env
# Operator fills .env locally, including distinct secrets; never echo or commit it.
# Check collisions before deployment:
ss -lnt | grep -E ':18080[[:space:]]' && echo 'Pick another PANTER_HOST_PORT before proceeding'
docker compose -p panter-ai -f compose.dev.yml config --quiet
docker compose -p panter-ai -f compose.dev.yml up -d --build
docker compose -p panter-ai -f compose.dev.yml ps
curl --fail --silent --show-error http://127.0.0.1:18080/health
```

Check the health JSON reports Panter-ai rather than Xanxittoo. Confirm `/mcp` without credentials is unauthorized; verify MCP SDK connectivity, read-only query, and actor separation on the private endpoint. In OAuth mode the `PANTER_OPERATOR_TOKEN` admin path is **strictly TCP-loopback** from the server's point of view: a Docker bridge/proxy can change the observed source address. Test an actual operator MCP session in its deployed network context; do not weaken authentication to make the canary pass. Do not claim live ChatGPT/Claude connection, independent native subagent attestation, or Engram ARM64 integration from a health=200 response.

**Backup/rollback:** Stop the Panter container before capturing its named `panter_data` Docker volume as a versioned tar archive in an operator-controlled encrypted destination, or use an equivalent verified volume snapshot. Preserve the exact prior image digest and commit SHA. If the canary fails, stop/remove **only** the Panter Compose project, restore its own volume snapshot as appropriate and run the previous image. For a first deployment, rollback means removing only Panter and returning to the pre-deployment state. Do not delete or restart Xanxittoo's containers or volumes. Backup/restore should be tested before any release upgrade.

## Public rollout (separate future gate)

After private canary: confirm exact domain/subdomain selected by the operator, HTTPS/TLS, OAuth2.1 discovery and PKCE, client allowlists, consent, operator-only admin access, request origin/host checks, Cloudflare policy and end-to-end tests with ChatGPT/Claude. Confirm trusted signed runner and isolated worktree execution. Only then consider publishing an MCP endpoint. **Do not put a shared bearer or an admin token on an Internet-facing URL.**

## Handoff / outcome report

Record: reviewed SHA; Claude reviewer identity and actual GitHub review URL; unresolved issue/thread count; exact CI check URLs and results; RDD independence signature status; approved merged SHA if applicable; Oracle machine and project name (not its secrets); canary `/health` and OAuth statuses; data backup location or reference; rollback test; remaining blockers. If any gate fails, **stop before merge/deploy and report the evidence**, rather than silently overriding it.
