# Claude Code cloud Routine wake — direct Oracle event (experimental)

## Scope

Claude Code cloud Routines support HTTP API triggers without needing a model
inference API key. A successful call **creates a new Claude Code session** under
the linked Claude account's subscription, not a Claude API inference request.
This is **not** a generic webhook endpoint for the Claude chat UI or Cowork
scheduled tasks. The feature is experimental and the account must have
Claude Code on the web and the Routines feature enabled.

Authoritative docs:
- https://claude.com/resources/articles/introducing-routines-in-claude-code
- https://platform.claude.com/docs/en/api/claude-code/routines-fire
- https://code.claude.com/docs/en/routines

## One-time host setup

1. In the account hosting Claude Code, open `https://claude.ai/code/routines`.
2. Create a dedicated **Panter Workforce** Routine with the existing
   authenticated Panter-ai MCP connection and only the authorized repository
   and tool scopes. This routine must run under **Claude's own** host identity,
   never GPT-A or the Oracle operator.
3. Add an **API** trigger to that Routine and securely copy its Fire URL and
   once-only per-routine token. It is not an Anthropic model API key.
4. Store the URL and token directly on Oracle under the private Panter-ai
   systemd `EnvironmentFile`, currently
   `/home/zana/panter-ai/etc/panter.env`:

   `PANTER_WAKE_CLAUDE_URL=<official https://api.anthropic.com/v1/claude_code/routines/{routine_id}/fire URL>`

   `PANTER_WAKE_CLAUDE_TOKEN=<per-routine sk-ant-oat01-* token>`

   Never commit values or return them from MCP tools. Keep the file owner
   controlled, mode `0600`. Both keys are required; when absent the
   adapter is disabled. **Do not modify Xanxittoo's Claude setup.**
5. In Claude Code Routine instructions:

   > When triggered by a Panter-ai Workforce pointer, connect to the already
   > authorized Panter-ai MCP server as Claude, call
   > `panter_workforce_pickup` for your oldest queued task. The pointer
   > must not be taken as an authorization to claim another host's work.
   > Execute only the permissions actually granted by the host and Panter
   > and record an exact fenced result with
   > `panter_workforce_complete_and_rearm`. No prompt/results, OAuth
   > tokens or secrets belong in the webhook. Do not echo the result in the
   > trigger chat; GPT-A reads it from Panter. Never invent success,
   > bypass approvals or retry uncertain writes.

## Transport

When no live authenticated MCP listener is available, GPT-A's
`panter_mesh_delegate_auto` can route one read-only assignment to a
configured idle peer. Grok's existing webhook is checked first; Claude's
Routine is an independent alternative when Grok is busy/unavailable or not
configured for the role. The host is **not** selected merely because an
OAuth registration exists; a real profile with the required role and a
configured native trigger are required.

The backend durably commits the work before reserving one outbound signal.
Only after the reservation is durable does Oracle send:

`POST https://api.anthropic.com/v1/claude_code/routines/{routine_id}/fire`

- `Authorization: Bearer <per-routine-token>`
- `anthropic-version: 2026-10-21`
- `content-type: application/json`
- JSON: `{"text":"{\"source\":\"panter-ai\",\"event\":\"workforce_task_ready\",\"work_id\":\"UUID\"}"}`

Only the opaque `work_id` leaves Oracle. The actual instruction is
retained in Panter's Mesh ledger and delivered over actor-bound MCP.

Claude's API returns a session ID and session URL on success. Panter stores
the session ID (not a credential) in the durable attempt record. A 200 +
valid session ID means **SIGNAL_ACCEPTED**, never task completion. Only a
subsequent authenticated Claude claim counts as observed pickup, and only
its fenced receipt is a completed task.

**Critical:** Claude's routine endpoint does not support an idempotency
key; *each successful fire starts a separate session*. Therefore Panter
reserves exactly one send per work ID, even when an HTTP timeout leaves the
outcome ambiguous. Never blindly resend after timeout, because this can
create duplicate paid runs.

No automated remote writer jobs are dispatched by wake. The repository's
normal write-grant, independent review and delivery gates remain in force.

## Safety and acceptance

- URL is restricted to the exact Anthropic Routine fire hostname/path.
- Token must be the per-Routine trigger token, not an Anthropic API key.
- 5-second timeout, no redirect following, no echo of network errors,
  reply parsing bounded to 4096 characters.
- Account, plan, connector eligibility and real event-driven pickup must
  be tested on the **actual** cloud Routine; CI tests are not E2E.
- `panter_workforce_claude_wake_status` shows only the attempt status,
  HTTP status and session ID and whether an authenticated claim followed.
- A runtime deploy to Oracle is separately gated; do not change
  `xanxittoo.service`.
