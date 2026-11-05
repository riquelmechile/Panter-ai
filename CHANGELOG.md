# Changelog

All notable changes to Panter-ai. Versions follow [Semantic Versioning](https://semver.org/). Releases before 1.0 are described in [docs/HISTORY.md](docs/HISTORY.md).

## 1.0.0

The first stable release: the developer-preview features are now the supported product, deployed and running in production.

### Coordination
- Configurable leader (`PANTER_LEAD_HOST`); every other connected host is a worker.
- Automatic ODD harness: phases chosen by risk, run inline, natively or on the bound remote host, with pickup timeouts and native fallback for the host that failed.
- `panter_harness_close` stops a run for good, withdrawing its remote work and revoking its grants.
- Durable mesh and workforce: delegation, claims with leases, heartbeats, results, wake for Claude routines, Grok and Gemini (mail relay).

### Review
- 4R with four lenses on remote hosts that did not write the candidate, and Judgment Day with two blind judges on their bound hosts.
- Panter-RDD acknowledges only reviews bound to the exact commit and its CI, with optional transport attestation for remote receipts.

### GitHub
- GitHub workforce: write access scoped to one work item, granted on dispatch and revoked when the work ends, with an audit trail.
- Formal approvals come only from a dedicated independent reviewer account on the exact head SHA.

### Tools
- Per-role `tools/list` (leader, worker, operator) and eight domain routers; every tool stays callable by name.
- Downstream MCP gateway: other MCP servers mounted behind Panter with prefixed tools, timeouts, a circuit breaker, write grants and audit.

### Operations
- `deploy/deploy.sh` deploys an exact commit of main: build and test in its own release, backup with the service stopped, switch, health check on that revision, automatic rollback.
- `deploy/backup.mjs`: SQLite copy with a restore check, plus the environment and JSON stores; daily backups through a systemd timer.
- Health-check timer that restarts the service after two failed checks, with an optional alert webhook.
- `/health` reports the package version and the release commit.

### Brand
- Panter, the mascot: a panther with a mouse's face. New README, banner and architecture diagram.
