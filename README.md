# Panter-ai

**An independent, open-source development control plane for AI hosts.**

Panter-ai is an MIT-licensed remote Model Context Protocol (MCP) server. It stores engineering missions, requests host-native reasoning/parallelism, and coordinates durable tasks. **It does not call model inference APIs or require a developer's personal PC.** The connected AI application owns its model, inference, credentials and any native agent threads.

## What works in v0.2.0

- Remote `/mcp` endpoint built with the official MCP TypeScript SDK v2 (modern and legacy-era stateless requests).
- Bearer-token protection, origin/hostname checks and `/health` endpoint.
- Durable missions, optimistic revisions and a bounded lifecycle.
- Durable single-tenant work queue, idempotent enqueue, claim leases and stale-claim fencing.
- Explicit **REQUESTED** model/effort/parallelism policy and unverified host-reported evidence assessment.
- Zero hidden model workers, zero model provider API calls.
- Unit tests, CI and Docker starter (dependency lockfile pending due to unavailable npm registry during initial packaging).

**New in v0.2.0:** A durable, original role-based agent workflow: deterministic inline/read-only/coordinated routing, scout/designer/builder/verifier/reviewer roles, exact specification handoffs, dependency-aware claims, lease renewal, blocking questions, scoped writer admission, frozen candidate SHA, independent verification/review and invalidation when the candidate changes. The AI host still launches and executes its own native agents; **Panter-ai does not start agent model runs or wake sleeping hosts**.

**Not implemented yet:** OAuth 2.1 / multi-tenant actor authorization, native push wake adapters, signed doorbells, automatic external tool discovery, GitHub orchestration, remote shell isolation, cryptographic review receipts or production multi-replica persistence. Queuing a job does not wake a sleeping host. Do not deploy this alpha as an unrestricted public multi-user service.

## Run locally

Requires Node.js 22+.

```sh
npm install
export PANTER_TOKEN="$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))")"
npm start
```

The process listens on `127.0.0.1:8080/mcp` by default. Remote deployments require TLS at the reverse proxy, `PANTER_TOKEN`, `PANTER_BIND_HOST=0.0.0.0` and `PANTER_ALLOWED_HOSTS=your-public-hostname`. Browser clients additionally require explicitly allowed origins.

The MCP endpoint expects `Authorization: Bearer <your-token>`. **Many cloud AI hosts only support OAuth for custom connectors; do not assume this initial bearer-only implementation can be added to every host UI.** OAuth is the next authentication milestone. The token is administrator-wide and therefore initial work target names are not identity credentials.

## Tools

| Tool | What it does |
|---|---|
| `panter_host_policy` | Return requested host posture and optionally assess host-reported claims |
| `panter_mission_create` | Store goal and project |
| `panter_mission_get` / `panter_mission_list` | Read mission state |
| `panter_mission_transition` | Move through DRAFT → READY → RUNNING → VERIFYING → DONE with revision gates |
| `panter_work_enqueue` | Queue a task with stable idempotency key |
| `panter_work_claim` | Claim pending work with server-owned lease generation |
| `panter_work_complete` / `panter_work_get` | Submit and read task result |

## Coordinated agent workflow (v0.2.0)

Start with `panter_flow_route` using explicit request signals. Small, understood, recoverable and low-risk changes remain inline. Unclear code paths get a read-only scout; independent implementation units can be delegated to bounded builders when writing is authorized. High-risk changes require independent verification. Multi-session work stores the exact specification for recovery.

For coordinated work, the host calls `panter_mission_create`, `panter_flow_create`, then queues role-specific tasks using `panter_agent_enqueue`. A participating host calls `panter_agent_claim`, fetches `panter_agent_packet`, performs the work using **its own permitted tools/model**, and returns evidence through `panter_agent_complete`. A blocker can be relayed using `panter_agent_ask` and `panter_agent_answer`. The parent uses `panter_flow_dashboard` and `panter_agent_list` to recover state.

A builder must declare its allowed edit surfaces. Two builders in the same logical workspace cannot reserve overlapping paths, including nested directories. This is a **planning-time conflict guard**, not an actual filesystem sandbox: the host must enforce tools and permissions. For verification, `panter_flow_candidate` freezes a commit SHA; a reviewer or verifier must report that exact SHA and cannot use the same reported worker ID as a completed builder. A later SHA change invalidates previous checks. `panter_flow_close` blocks incomplete high-risk verification or required review.

This initial agent surface is **single tenant and statically token-protected**. Reported worker IDs, test results, diff hashes, Git commit SHAs and approvals are **not independently authenticated or remotely checked**. Do not use it for unattended, untrusted public contributors until identity, Git evidence and permissions are implemented.

## Host capabilities

The default ChatGPT profile **requests** `gpt-6-astra` with effort `max`, fallback `xhigh`, standard root processing and Fast worker processing when the host exposes it. It requests the maximum available native independent workers, with a **planning ceiling** of 32. The ceiling is **not** a claim that 32 workers actually exist. An alternate `host-native` profile leaves model identity with the connected host. Compatible repository-aware tools may also read the optional `.codex` configuration.

Panter-ai never changes the host's model selection itself. Every invocation should distinguish `REQUESTED`, `HOST_REPORTED_UNVERIFIED` and future host-verified evidence.

## Security and operating assumptions

- One server process owns the JSON store; **do not scale replicas over the same directory**.
- All MCP operations are protected by one strong token; this alpha is **single-tenant only**.
- Keep secrets out of Git, logs and task instructions.
- No arbitrary command execution is exposed.
- HTTPS/TLS must terminate at a trusted proxy on public deployments.
- Treat model output and worker instructions as untrusted data.
- Human authorization for destructive changes will be implemented before write-enabled downstream tools are added.

## Roadmap

See [docs/ROADMAP.md](docs/ROADMAP.md) and [docs/AGENT_WORKFLOW.md](docs/AGENT_WORKFLOW.md).

## License

MIT. See [LICENSE](LICENSE). Original implementation maintained under the Panter-ai project.

## v0.4: MCP inbox listening and Agent Studio

- MCP 2026-07-28 `subscriptions/listen` delivery for the generic `panter://mesh/changed` resource (when the client actually subscribes); events are published through the official SDK notification API after a durable ledger commit.
- `panter_mesh_inbox` uses per-actor **revision cursors** (`since`) to recover messages after reconnect without depending on a live event stream.
- An MCP Apps UI for GPT-A: invoke `panter_agent_studio` to configure profiles for GPT-A, GPT-B, Grok, Gemini and Claude. The view is bundled into a single HTML file during `npm run build`. Model and effort are preference requests and cannot force the host's underlying model.
- The listener is **not** an external wake mechanism. Do not claim that GPT automatically resumes reasoning or that five applications are already connected without host-native acceptance testing.
- Beta deployment still requires real OAuth 2.1 and validation of single-tenant actor identity, per-host grants and session authorization; the alpha bearer-token boundary is NOT appropriate for public production.

See [mesh implementation notes](docs/MESH_IMPLEMENTATION.md).

## v0.5: external OAuth authorization boundary (developer preview)

An optional `PANTER_AUTH_MODE=external-jwt` mode validates externally issued RS256 JWT access tokens, their issuer/audience/expiry/scopes, and per-app `(subject, client_id)` to host mappings. This permits separate GPT-A and GPT-B client identities without using model-provider inference APIs. An external identity provider handles consent, PKCE and client registration; Panter-ai does **not** provide those OAuth authorization-server operations. [Setup and outstanding production gates](docs/OAUTH_EXTERNAL.md).

Verification: `npm run smoke:oauth` tests signed fixture tokens and an actual two-client HTTP MCP interaction. It is **not** evidence that any live AI web app can be awakened or re-enters its reasoning session automatically.

## v0.6: embedded OAuth authorization (developer preview)

`PANTER_AUTH_MODE=embedded` enables self-hosted OAuth 2.1 authorization endpoints: `/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource`, `/register`, `/authorize`, `/oauth/consent`, `/token` and `/revoke`. The operator approves each app client and chooses its host (GPT-A, GPT-B, Grok, Gemini or Claude). Clients use authorization code + PKCE S256 and exact allowlisted HTTPS callbacks. Access and refresh token digests are stored in a private file; refresh rotates and reuse revokes the family. See [embedded OAuth guide](docs/OAUTH_EMBEDDED.md).

The previous external-JWT mode remains optional. **Neither mode is evidence of a real GPT-A autonomous wake or production safety**. Validate real host onboarding, SDK compatibility, revocation after restart, security review and proxy configurations before internet exposure.

## v0.7: centrally hosted Gentle Shell agent and skill catalog

The [Gentle Shell MCP compatibility guide](docs/GENTLE_SHELL_COMPAT.md) explains the exact upstream MIT-pinned catalog of **10 specialists** and **13 skills**, individual agent-to-host assignments in Agent Studio, host-specific requested models, immutable on-demand skill packets, and A2A completion into GPT-A's inbox. All five hosts may share specialist definitions; no provider inference API is used. The review 4R/Judgment Day blueprints are **planning and delegated contracts**, not a claim that the native Pi review engine has been ported.

## v0.8: upstream Engram memory (opt-in)

Panter-ai can run the official Engram memory server over local stdio MCP,
with a dedicated persistent project and no inference API. GPT-A alone may
search/recover curated project knowledge or store verified decisions; other
hosts return candidate discoveries as A2A messages/receipts. The official
Engram ARM64 binary must be installed separately; the bridge does not share
Xanxittoo's database or make unsupported autonomous-memory claims.
See [docs/ENGRAM_MEMORY.md](docs/ENGRAM_MEMORY.md).


## v0.9: native RDD gate and GPT-A no-workforce fallback

GPT-A can continue Gentle Shell ODD when all other hosts are disconnected. `panter_native_plan` selects remote A2A when explicitly connected, host-native subagents only when actually available, or parent-inline execution. `panter_native_packet` loads any centrally hosted specialist and skills for parent/native-subagent execution without any remote binding. This is planning and context delivery, **not** a claim that the MCP server starts inference or native workers.

`panter_review_evidence` checks strict SHA-bound reviewer evidence while keeping approval **false**. Optional `panter_native_review_capabilities`, `panter_native_review_assess` and `panter_native_review_status` consult the **official Gentle AI Go RDD** review controller read-only on an operator-configured checkout; they are disabled by default and do not substitute for genuine native review consent/capture/acknowledgement. Details: [docs/NATIVE_RDD_FALLBACK.md](docs/NATIVE_RDD_FALLBACK.md).

## v0.11: GPT-A-only native-subagent review (developer preview)

GPT-A can prepare and collect **four independent 4R reviews** or **two initially blind Judgment Day judges** from its **host-native** subagents even with zero connected remote peers. All original Gentle Shell agent/skill assets are served as SHA-bound packets via Panter's central MCP catalog. `panter_native_review_create` freezes review slots; `panter_native_review_batch` returns all outstanding handoffs with the host-reported concurrency limit; `panter_native_review_submit` stores structured, immutable receipts; `panter_native_review_progress` survives restart and exposes severe findings. Authenticated to GPT-A only, no provider inference APIs. **The MCP does not launch model workers, verify real Git state, or grant official Gentle AI RDD approval.** See [native review guide](docs/NATIVE_SUBAGENT_REVIEW.md).

## v0.12: automatic Gentle Shell-style ODD harness (developer preview)

GPT-A now begins with **one objective**, not manually chosen specialist IDs or skills. `panter_harness_start` computes the conservative route, `panter_harness_tick` selects the next ODD specialist, MCP-hosted skills and native/remote execution lane, and `panter_harness_report` advances after real evidence. A full configured/connected remote specialist can be delegated automatically; in GPT_A_ONLY/no-peer mode, native subagent or parent-inline packets preserve maximum requested reasoning/speed. High-risk changes automatically schedule independent verification and 4R; the exact candidate is required. Judgment Day remains explicitly triggered, as upstream requires. There is no automatic model inference on the server and no automatic official RDD approval. See [automatic harness](docs/AUTOMATIC_HARNESS.md).

## v0.13: automatic GitHub evidence gate (developer preview)

GitHub-bound engineering runs can supply an allowlisted `githubRepository`, observed `githubPrNumber` and `githubExpectedBase` to `panter_harness_start`. A GitHub implementation requires an exact 40-character candidate SHA. The final `panter_harness_tick` checks PR HEAD, approved issue, exactly one type label, branch naming, Conventional Commits, review workload and operator-configured required CI on that exact candidate; `panter_harness_github_check` rechecks it explicitly. Missing issue, checks, approvals or consent are blockers, not signals to silently modify the user's PR. The control is strictly read-only: **evidence readiness never grants permission to create commits, push, label, merge or deploy**, and official Gentle AI RDD authority remains separate. See [GitHub delivery policy](docs/GITHUB_GENTLE_WORKFLOW.md).
