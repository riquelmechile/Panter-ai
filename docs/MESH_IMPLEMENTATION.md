# Panter-ai A2A mesh (v0.3 alpha)

The main orchestration host is **gpt-a**. A second independently authenticated GPT host (**gpt-b**) and the Grok, Gemini and Claude host surfaces serve as configurable specialists. None is an inference API client.

## Actor credential boundary

`PANTER_TOKEN` is a local administrator token for the legacy alpha control tools. `PANTER_PEER_TOKENS` is a JSON dictionary of **unique**, high-entropy bearer tokens for `gpt-a`, `gpt-b`, `grok`, `gemini` and `claude`. Both are developer/test adapters, **not production OAuth**. Each authenticated peer may call mesh tools only as its own actor; tool-provided actor names are never trusted. GPT-A configures profiles and delegates; targets can only claim and complete their own work. Deploy only on loopback or inside a private network until OAuth 2.1, per-connection scopes, tenant isolation, and replay protections are verified.

## Host profiles and lifecycle

`panter_mesh_profile_set` — GPT-A chooses host, actor label, requested model/effort, roles and revision CAS.
`panter_mesh_delegate` — GPT-A queues a role-scoped unit for a configured host; idempotency is mission+key and payload checked.
`panter_mesh_pending` — authenticated worker reads **its own** queue pointers.
`panter_mesh_claim` — worker claims, returns attempt ID, generation, instructions and lease.
`panter_mesh_heartbeat` — same worker renews a live lease.
`panter_mesh_message` — authenticated host asks or answers a question bound to its actual delegation.
`panter_mesh_complete` — checks actor, attempt, generation and expiry; stores an immutable terminal digest and appends a RESULT message to GPT-A's inbox.
`panter_mesh_inbox` — orchestrator and workers read their own messages and authorized work summary.

A new committed message/result increments an inbox revision and emits a local event. `panter://inbox/<host>` offers an actor-bound, minimal MCP resource projection. These changes support subscription implementation, but **the live MCP `subscriptions/listen` transport is not implemented or validated in this release**. Core notifications and subscription authorization depend on the installed SDK's negotiated protocol and the host's actual support. A successfully opened connection alone does not cause reasoning to resume in an app.

## Deployment limits and next gates

- This alpha persists JSON using single-process atomic replacement. One process only; PostgreSQL transactions, leader epochs, and cross-replica notification bus are not yet available.
- Actor tokens are a test-only bridge. OAuth DCR/PKCE, token revocation, grant evaluation and an actor-identity database are required before public availability.
- No real external event trigger, MCP Tasks listener, official A2A 1.0 server endpoint, model execution or Git/SSH runner is started by this code.
- For `subscriptions/listen`, implement the official SDK transport with streaming POST response, resource subscription checks, ACK/update envelopes, legacy capability negotiation, interruption recovery and actor isolation tests. Keep the Work ledger authoritative, not SSE.
- A tool success is a server receipt; **it does not independently verify the model identity or execution quality**.

## v0.4 listening and UI contract

- Modern MCP `2026-07-28` clients may subscribe to `panter://mesh/changed` with `subscriptions/listen` and `notifications.resourceSubscriptions`. The SDK owns the listen SSE stream and the server calls `handler.notify.resourceUpdated` only after durable state persistence.
- The notification URI and resource content are identical for all hosts and deliberately reveal no actor, mission, result, receipt or pending count. A connected client must call its **authenticated** `panter_mesh_inbox` with `since=<last revision>` to recover work. Reconnect and reconcile; notifications are ephemeral.
- This is **not a model wake guarantee**. A subscribed stream does not start or resume reasoning in a host whose client does not support it. No host-ready or autonomous-wake claim is made until a live acceptance test proves the complete sequence.
- One Node process is supported: the event bus and JSON ledger are not distributed across replicas. Run only one container replica until a transactional DB and shared notification bus are introduced.
- `panter_agent_studio` is an MCP Apps tool linked to a bundled `ui://panter/agent-studio.html` resource. GPT-A configures model/effort **requests** and role routing; other hosts may never modify these settings. HTML contains no auth secrets. Build via `npm run build:ui` before running the MCP server.
- All five host connections still use ALPHA bearer tokens. OAuth 2.1, audience-bound access, real external wakes, A2A v1 Agent Cards, live MCP listen conformance and sandboxed Oracle runners are not certified by these core tests.
