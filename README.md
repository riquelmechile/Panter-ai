<p align="center">
  <img src="docs/assets/panter-banner.svg" alt="Panter-ai: one leader, every model, every MCP" width="100%">
</p>

<p align="center">
  <a href="LICENSE">MIT</a> ·
  <a href="CHANGELOG.md">Changelog</a> ·
  <a href="docs/OPERATIONS.md">Operations</a> ·
  <a href="docs/CANONICAL_HARNESS_POLICY.md">Policy</a> ·
  <a href="docs/TOOL_SURFACE.md">Tool surface</a> ·
  <a href="docs/DOWNSTREAM_MCP.md">Downstream MCPs</a>
</p>

# Panter-ai

**Panter-ai is an open-source MCP server that lets several AI hosts work as one engineering team.** One host leads. The others take the work it hands out: exploring, implementing, verifying, reviewing. Panter keeps the plan, the evidence and the permissions in one durable ledger, so nobody has to trust a model's word that something was done.

The server never calls a model API. Each host (Claude, ChatGPT, Grok, Gemini) brings its own model and login. Panter holds no model API keys.

## Meet Panter

The mascot is a panther with a mouse's face. The panther is patient and precise and does not let go of a job until it is done. The mouse is small and curious and gets into every corner. Its tail ends in a connector node, because that is how Panter works: every host and every MCP server plugs into it.

<p align="center">
  <img src="docs/assets/panter-mascot.svg" alt="Panter, a black panther with mouse ears, a pink nose and whiskers, and a tail ending in a teal connector" width="180">
</p>

## How it fits together

<p align="center">
  <img src="docs/assets/panter-architecture.svg" alt="AI hosts connect to Panter-ai over MCP. Panter runs the harness, review gate, mesh, GitHub workforce, memory and tool surface, reaches downstream MCP servers through a gateway, and gates merges through GitHub." width="100%">
</p>

- **AI hosts** connect over MCP with OAuth. The leader is set by `PANTER_LEAD_HOST`; every other host is a worker.
- **Panter-ai** runs the work: it picks the next phase, sends it to a host that can do it, records what came back, and refuses to move on without evidence.
- **Downstream MCP servers** (your own projects, each in its own repository and service) sit behind Panter. Hosts reach them through one gate, with per-server tokens, write grants and an audit log.
- **GitHub** is where work lands: pull requests, CI and an independent reviewer account approving the exact commit.

## What it does

| Area | What you get |
|---|---|
| **Automatic harness** | `panter_harness_start` and `panter_harness_tick` run ODD phases (discover, design, implement, verify, review) chosen by risk. The user never picks agents or skills. A run can be closed for good with `panter_harness_close`. |
| **Review gate** | 4R review with four lenses, an optional Judgment Day with two blind judges, and Panter-RDD, which only acknowledges a review bound to the exact commit, its CI and attested transports. Reviews run natively or on their bound remote hosts; Judgment Day never goes to a host that wrote the candidate, and with transport attestation Panter-RDD refuses remote receipts from one. |
| **Mesh and workforce** | Durable delegation, claims with leases, heartbeats, results, wake signals and pickup timeouts with native fallback. Gemini works through a mail relay. |
| **GitHub workforce** | Write access scoped to one work item, granted on dispatch and revoked when the work ends, with an audit trail. |
| **Memory** | Optional Engram project memory, mirrored from the harness ledger. |
| **Tool surface** | Each role sees a short list: the leader 50 tools and a worker 29, the 8 domain routers included. Every tool stays callable by name. See [docs/TOOL_SURFACE.md](docs/TOOL_SURFACE.md). |
| **Downstream gateway** | Register an MCP server once; it appears as one router, `panter_ds_<name>`, with timeouts, a circuit breaker, write grants and audit. See [docs/DOWNSTREAM_MCP.md](docs/DOWNSTREAM_MCP.md). |
| **Operations** | One-command deploy of an exact commit with automatic rollback, a backup with a restore check before every deploy and every day, and a health check that restarts the service. See [docs/OPERATIONS.md](docs/OPERATIONS.md). |

## Ground rules

These are enforced in code, not just written down:

- **No model APIs.** The server never runs inference and stores no model API keys.
- **Evidence over claims.** A host saying "tests pass" is recorded as reported, not verified. Approval needs the exact commit, CI and an independent reviewer.
- **Authorization is separate.** Writing code, merging and deploying each need their own grant. Reviews never grant them.
- **The host owns the model.** Panter *requests* a model, effort and parallelism ([`src/core/policy.ts`](src/core/policy.ts)); it never claims what a host actually ran.

## Quick start

Requires Node.js 22.16 or later.

```sh
npm ci
npm run build
npm test
export PANTER_TOKEN="$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))")"
npm start
```

The server listens on `127.0.0.1:8080/mcp`. Send `Authorization: Bearer $PANTER_TOKEN`. For real hosts, use embedded OAuth (`PANTER_AUTH_MODE=embedded`, see [docs/OAUTH_EMBEDDED.md](docs/OAUTH_EMBEDDED.md)) behind a TLS proxy. Every setting is listed in [`deploy/panter.env.example`](deploy/panter.env.example).

`GET /health` returns `{"status":"ok","name":"panter-ai","version":"…","revision":"<commit>"}` (`revision` is `null` outside a release installed by `deploy/deploy.sh`).

## Running it in production

The reference deployment is a single ARM64 VM running a `systemd --user` service behind a Cloudflare tunnel:

```sh
PANTER_SOURCE_REPO=<clone of this repo> ~/panter-ai/current/deploy/deploy.sh <full commit sha on main>
```

The script builds and tests that commit, stops the service for a consistent backup, switches to it, and rolls back on its own if `/health` does not report that commit. The rollback covers code, not data (restore from the pre-deploy backup if a release changed it), and the very first deploy has no previous release to go back to. Backups, restore steps and the timers are in [docs/OPERATIONS.md](docs/OPERATIONS.md).

Panter keeps its state in one SQLite ledger plus a few JSON stores. Run **one process** per data directory.

To run your own instance, see [docs/SELF_HOSTING.md](docs/SELF_HOSTING.md): your accounts, domain and secrets live only in your server's `panter.env`, never in this repository.

## Documentation

| Topic | Read |
|---|---|
| Rules that win over everything else | [CANONICAL_HARNESS_POLICY.md](docs/CANONICAL_HARNESS_POLICY.md) |
| Leader and workers | [LEADERSHIP.md](docs/LEADERSHIP.md), [HARNESS_HOSTS.md](docs/HARNESS_HOSTS.md) |
| The harness | [AUTOMATIC_HARNESS.md](docs/AUTOMATIC_HARNESS.md) |
| Reviews | [PANTER_RDD_NATIVE.md](docs/PANTER_RDD_NATIVE.md), [INDEPENDENT_REVIEW_IDENTITY.md](docs/INDEPENDENT_REVIEW_IDENTITY.md) |
| GitHub | [GITHUB_WORKFORCE.md](docs/GITHUB_WORKFORCE.md), [GITHUB_GENTLE_WORKFLOW.md](docs/GITHUB_GENTLE_WORKFLOW.md) |
| Waking hosts | [CLAUDE_ROUTINE_WAKE.md](docs/CLAUDE_ROUTINE_WAKE.md), [GROK_BOT_WAKE.md](docs/GROK_BOT_WAKE.md), [GEMINI_MAIL_WAKE.md](docs/GEMINI_MAIL_WAKE.md) |
| Tools and routers | [TOOL_SURFACE.md](docs/TOOL_SURFACE.md) |
| Downstream MCP servers | [DOWNSTREAM_MCP.md](docs/DOWNSTREAM_MCP.md) |
| Your own instance | [SELF_HOSTING.md](docs/SELF_HOSTING.md), [OWNER_MODE.md](docs/OWNER_MODE.md) |
| Operations | [OPERATIONS.md](docs/OPERATIONS.md), [ORACLE_ARM.md](docs/ORACLE_ARM.md) |
| History (v0.1 to v0.15) | [HISTORY.md](docs/HISTORY.md) |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Hosts and agents working in this repository follow [AGENTS.md](AGENTS.md).

## License

MIT. See [LICENSE](LICENSE). The Gentle Shell agents and skills in `vendor/gentle-shell` keep their own MIT notices.
