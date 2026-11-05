# Changelog

All notable changes to Panter-ai. Versions follow [Semantic Versioning](https://semver.org/). Releases before 1.0 are described in [docs/HISTORY.md](docs/HISTORY.md).

## 1.2.1 (2026-11-05)

- `panter_downstream_call`: reach a downstream server by name (same authorization, write policy, grants and audit as its `panter_ds_<name>` router), also through the `panter_admin` router, so a host whose connector's tool list predates a newly mounted server can use it without reloading.

## 1.2.0 (2026-11-05)

### Downstream gateway
- OAuth client credentials for downstream servers (`oauth` in the config): cached token, renewed before expiry and once on a 401, never shown. Needed to mount servers that only accept OAuth, such as commerce-control.
  A refused write is never replayed (only calls authorized as reads and protocol requests are retried with the new token); it fails alone, without breaking the connection; refusals count toward the circuit breaker once per token. A failed renewal keeps using the current token until it really expires. A token replaced while a call runs stays redacted until it expires, a late 401 for an older token does not discard the newer one, the token endpoint's answer is limited to 64 KB, and Basic credentials are form-encoded (RFC 6749).

## 1.1.0 (2026-11-04)

### Downstream gateway
- Signed actor identity: every forwarded call carries `_meta["panter-ai/actor"]`, an Ed25519-signed assertion of the calling host, its role and mission, bound to the server, tool, arguments and a 120-second lifetime. Public keys at `/.well-known/panter-downstream-keys`; reference verifier in `src/core/actor-assertion.ts`.
- `sensitive` servers: proxied without keeping content (no argument hash, no error text in audit, status or log), every call names its mission, answers are marked sensitive.
- Sensitive missions: a mission that called a sensitive server is never mirrored to Engram, and Panter refuses new text with a personal identifier for it (harness reports, delegated work, results, messages, reviews, memory; heuristic check: RUT, e-mail, +56 phone). Marks are durable and never dropped; `panter_downstream_unmark` (operator) clears one set by mistake.
- The audit records each call's role and mission.

## 1.0.0 (2026-11-04)

The first stable release: the developer-preview features are now the supported product, deployed and running in production.

### Coordination
- Configurable leader (`PANTER_LEAD_HOST`); every other connected host is a worker.
- Automatic ODD harness: phases chosen by risk, run inline, natively or on the bound remote host, with pickup timeouts and native fallback for the host that failed.
- `panter_harness_close` stops a run for good, withdrawing its remote work and revoking its grants.
- Durable mesh and workforce: delegation, claims with leases, heartbeats, results, wake for Claude routines, Grok and Gemini (mail relay).

### Review
- 4R with four lenses on their bound remote hosts, and Judgment Day with two blind judges on bound hosts that did not write the candidate.
- Panter-RDD acknowledges only reviews bound to the exact commit and its CI, with optional transport attestation that also refuses receipts from hosts that wrote the candidate.

### GitHub
- GitHub workforce: write access scoped to one work item, granted on dispatch and revoked when the work ends, with an audit trail.
- Formal approvals come only from a dedicated independent reviewer account on the exact head SHA.

### Tools
- Per-role `tools/list` (leader, worker, operator) and eight domain routers; every tool stays callable by name.
- Downstream MCP gateway: other MCP servers mounted behind Panter, each as one router (`panter_ds_<name>`), with timeouts, a circuit breaker, write grants and audit.

### Operations
- `deploy/deploy.sh` deploys an exact commit of main: build and test in its own release, backup with the service stopped, switch, health check on that revision, automatic rollback.
- `deploy/backup.mjs`: SQLite copy with a restore check, plus the environment and JSON stores; daily backups through a systemd timer.
- Health-check timer that restarts the service after two failed checks, with an optional alert webhook.
- `/health` reports the package version and the release commit.

### Brand
- Panter, the mascot: a panther with a mouse's face. New README, banner and architecture diagram.
