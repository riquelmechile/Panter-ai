# MCP Tasks native wire interoperability — phase 3A

## What actually works

Panter runs an SDK 2.x server that already supports modern
`subscriptions/listen` (2026-07-28). This phase adds
`panter_workforce_listen`, an authenticated 0–3600 second **live tool call**.
Unlike `panter_workforce_wait`, it obtains the 2025/2026 protocol era from
the SDK exchange, not from user-controlled tool arguments.

Native MCP request method handlers `tasks/get` and `tasks/cancel` now
project existing durable bridge listener handles in their **observed era**.
Legacy (2025-11-25) additionally serves `tasks/list` (25/page) and
`tasks/result`. All methods require authenticated actor ownership.
The bridge listener is **not** authority to execute work: the owner still
needs `panter_workforce_pickup`/fenced claim. Cancellation of the transport
listener never cancels an authoritative queued work.

Modern `tasks/get` returns a detailed task with `ttlMs` and terminal
`result` containing only an opaque queue pointer, and `tasks/cancel`
returns an empty SDK-stamped acknowledgement. Legacy methods use the
2025 `ttl` and status envelope. The SDK owns framing/validation.

## What is NOT yet implemented

This is **method-level wire interoperability** for existing bridge tasks.
It does **not** yet implement native `tools/call` task creation with
`resultType:task` and client extension negotiation; neither the complete
2026 Draft extension (`tasks/update` and task-ID subscription notifications)
nor legacy task augmentation are advertised. Unlike the 2025 methods, the
2026 Tasks extension is separate from the MCP core.

No hosted GPT-A/GPT-B, Grok, Claude or Gemini Argon 4 client has been
validated E2E on this commit. `autonomousWakeVerified` remains false;
a successful HTTP/MCP listen does **not** prove an offline app woke.
Do not configure provider webhooks, Gmail/Slack/GitHub doorbells or model
API keys as prerequisites for Tasks/Listen. Reuse the backend-only receipt
and rearm contract already shipped in PR #60.

References: official
`modelcontextprotocol/ext-tasks/specification/2026-07-28/tasks.md`.
