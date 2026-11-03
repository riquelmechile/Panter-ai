# Native ChatGPT Work wake through MCP Events (no CLI, no model APIs)

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
challenge before persisting a 24-hour renewable subscription. ChatGPT
refreshes the subscription before expiration.

Only a real subscribed GPT-B actor is eligible for this event wake path.
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

## Gemini Apps compatibility

The **same** work queue and `panter_workforce_pickup` /
`panter_workforce_complete_and_rearm` tools are shared with Gemini's
existing connected MCP application. However, Google's Connected Apps
Platform documentation currently confirms MCP protocol through
`2025-11-25`, not that Gemini Apps accepts native ChatGPT-style
`events/subscribe` callbacks. Do not invent a Gemini event endpoint.
Use the native Gemini Tasks + Skill schedule introduced in PR #65 as
the available host-owned wake; upgrade to identical MCP Events only
if the Gemini host actually negotiates and proves it.

Reference: https://developers.google.com/connected-apps/mcp/server-optimization

## Security and rollout

- Never expose a model-provider API or add a CLI/worker to Oracle.
- Do not modify `xanxittoo.service`, current production, or OAuth client
  registrations.
- New event subscription state is saved in Panter's 0600 SQLite file;
  callback URL and signing secret are not returned to ordinary MCP tools.
- Observe delivery and real host execution with **two events** without
  human interaction and no duplicate claims before declaring the wake live.
- CI, independent GitHub review, and Xanxito 4R approval on exact SHA
  are required before deployment.
