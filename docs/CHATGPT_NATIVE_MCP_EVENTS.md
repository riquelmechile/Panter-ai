> Compatibility: OpenAI currently documents MCP Events for Work and dots, not ordinary ChatGPT chats. Panter-ai implements events on the existing endpoint and preserves Listen/app_turn. Webhook acceptance is not proof of autonomous wake.

# Native MCP Events for compatible ChatGPT hosts (no CLI or model APIs)

## Purpose

GPT-A and GPT-B remain **separate ChatGPT application accounts**. GPT-B is
connected to Panter-ai with its existing, approved OAuth MCP plugin. This
integration is the **native MCP Events webhook delivery** available in
ChatGPT **Work** cloud chats or dots, not OpenAI Codex, App Server, provider
inference API, GitHub/Gmail/Slack wake, or an Oracle-hosted model.

Source: https://developers.openai.com/plugins/build/mcp-events

The host and server have different responsibilities:

- **GPT-A:** automatically chooses objective/role and delegates only work
  permitted by the existing policy and operator grants.
- **Panter-ai (Oracle MCP):** stores authoritative actor-bound work, signed
  event subscriptions and an idempotent webhook outbox in SQLite.
- **ChatGPT Work (GPT-B):** receives native event, performs MCP
  `panter_workforce_pickup`, executes the work using its own account,
  and commits a fenced terminal result through
  `panter_workforce_complete_and_rearm`.
- **GPT-A:** receives compact receipt and reads result from Panter backend.

No prompt, task instructions, OAuth token or result body is sent inside the
webhook event: only `data.workId`. GPT-B's OAuth principal is verified
again when it calls the MCP pickup tool.

## One-time setup inside GPT-B's ChatGPT application

1. After this PR passes independent SHA-bound review and is deployed, rescan
   the existing Panter-ai custom MCP plugin in GPT-B's account; do not make
   a new OAuth registration or switch to GPT-A's account.
2. In a **Work** cloud chat (or a supported dot), subscribe to the
   `panter.work.ready` event with filter `{"host":"gpt-b"}`.
3. Tell the Work chat how to process the event:

   > On Panter `panter.work.ready` events for GPT-B, access Panter-ai via
   > the already connected MCP plugin as GPT-B. Call
   > `panter_workforce_pickup` to claim at most one authorized task.
   > Execute only its approved scope using your native host tools. Commit
   > the exact lease identifiers and factual result with
   > `panter_workforce_complete_and_rearm`. Deliver results through Panter
   > for GPT-A to read, not in the chat transcript. If blocked, never forge
   > success or retry an uncertain write. Do not delegate to other accounts.

ChatGPT will send `events/subscribe` with its HTTPS callback URL and
`whsec_` signing secret. Panter verifies the callback using a signed
challenge before persisting a renewable subscription of up to 7 days (also
when `ttlMs` is null or omitted). `refreshBefore` is set a quarter of the
granted lifetime before expiry, so ChatGPT renews with margin; delivery
stops only at `expiresAt`. Renewal is still an observed host behaviour:
check that the subscription's expiry moves forward before relying on it.

Only a real subscribed ChatGPT or Gemini app worker (GPT-A, GPT-B or Gemini,
never the configured leader) is eligible for this event wake path.
A connected OAuth registration alone is insufficient. The route is
read-only by default: `implementer` remains subject to separate
authorization/explicit host approval paths and is not cold-started by the
event adapter.

## Native protocol implemented by Panter-ai

- `events/list`: advertises one GPT-B event, `panter.work.ready`.
- `events/subscribe`: verifies callback and stores a durable subscription.
- `events/unsubscribe`: actor-bound removal and cancellation of deliveries.
- `webhook-id`, `webhook-timestamp`, `webhook-signature` and
  `X-MCP-Subscription-Id`: Standard Webhooks signed verification and event.
- `data: {"workId":"UUID"}`: no user instructions or secrets.
- Persistent outbox: bounded concurrency, exponential retry,
  stable event ID, 410/413 terminal, crash recovery.
- Callback URL: HTTPS only, validated public IP at **connection time**,
  TLS hostname verification, no redirects, response size limit.
- `panter_workforce_event_status`: redacted GPT-A read tool for delivery
  counts (does not expose subscriber URL or signing secret).

An HTTP 2xx confirms **signal accepted only**. Until a genuine GPT-B
claim, independent Work-host completion and receipt are demonstrated,
`autonomousWakeVerified=false`.

## Gemini Apps compatibility — same MCP server, conditional feature

The **same** `events/list`, `events/subscribe` and `events/unsubscribe`
methods are also available to Gemini **when its existing MCP-connected
application actually supports them**. Gemini must authenticate as its own
OAuth actor and subscribe to `panter.work.ready` with
`{"host":"gemini"}`. Panter keeps these subscriptions, filters and
signed webhooks strictly separate from GPT-B.

Google's Connected Apps Platform documentation currently confirms standard
MCP protocol up to `2025-11-25`. MCP Events is a draft extension which
can be advertised on 2025 `initialize`, but Google has **not publicly
confirmed** that Gemini Apps issues `events/subscribe` or receives such
webhook callbacks. Do not invent or preconfigure a callback URL for Gemini.

The server now supports the **same event contract** for both hosts,
without changing either existing OAuth account. If Gemini sends a real
subscription request, activate event-driven delivery to that callback.
If it does not, Gemini's native Task + Skill schedule from merged PR #65
continues using the same Mesh queue and fenced result tools.

Reference: https://developers.google.com/connected-apps/mcp/server-optimization

## Security and rollout

- Never expose a model-provider API or add a CLI/worker to Oracle.
- Do not modify other services on the host, current production, or OAuth client
  registrations.
- New event subscription state is saved in Panter's 0600 SQLite file;
  callback URL and signing secret are not returned to ordinary MCP tools.
- Observe delivery and real host execution with **two events** without
  human interaction and no duplicate claims before declaring the wake live.
- CI, independent GitHub review, and Panter-RDD 4R approval on exact SHA
  are required before deployment.

## Revocar una conexión

`panter_oauth_client_revoke` también borra en el acto las suscripciones a eventos de los hosts de ese cliente, y los avisos pendientes quedan `FAILED` (`SUBSCRIPTION_INACTIVE`). Las suscripciones van por host, no por cliente: si el host tiene otra conexión viva, esa conexión debe volver a suscribirse. La respuesta trae esos hosts en `hostsToResubscribe`.

Una suscripción que todavía estaba verificando su callback cuando se revocó la conexión no se guarda: Panter lleva un contador de revocaciones por host y lo compara antes de persistir. El borrado se hace antes y después de revocar, así que una caída a mitad de camino no deja suscripciones de una conexión ya revocada. Además, después de guardar una suscripción, Panter vuelve a validar el token de esa misma request: si la conexión se revocó mientras la request seguía en curso, la suscripción se borra.
