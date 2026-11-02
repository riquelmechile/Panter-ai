# GPT-A orchestration with standing peer wake — phase 3B

## Contract

GPT-A remains the only orchestrator. GPT-B, Grok, Claude and Gemini are
**host-operated workers**; the Panter MCP backend never invokes model-provider APIs
or starts models. The durable Mesh SQLite ledger remains the single authority
for tasks, leases, write grants, terminal results and receipts.

Use `panter_mesh_delegate_auto` when GPT-A has chosen an objective and role but
should not manually select a peer. Backend selection is deterministic:

1. Reuse an existing `(missionId, idempotencyKey)` work item. Never reroute it.
2. Consider only configured peers with the requested role, an authenticated
   poll within the previous 120 seconds, and a reported standing
   `LONG_POLL` or Tasks/bridge delivery route.
3. Choose the fewest outstanding QUEUED/RUNNING/OUTCOME_UNKNOWN tasks;
   break ties by host name. Specialist-specific selection still uses the
   existing pinned agent/skill binding workflow.
4. If nobody qualifies or GPT-A has `GPT_A_ONLY`, return
   `LOCAL_FALLBACK_REQUIRED` with no queued work. GPT-A then performs
   the objective itself or uses **genuine host-native subagents**, never
   an invisible server-side inference fallback.

Workers independently keep a real MCP host session connected, listen with
`panter_workforce_listen` or a negotiated task transport, then call
`panter_workforce_pickup` to obtain the *authoritative, fenced* work attempt.
The server transport signal only carries an opaque work pointer. The worker's
host executes the approved instructions. The worker calls
`panter_workforce_complete_and_rearm`: SQLite commits the terminal receipt
before arming its next transport handle. GPT-A sees the compact receipt through
`panter_workforce_receipts` and retrieves the full result exclusively through
`panter_workforce_result_get`.

## Proof levels and limits

A recently authenticated poll proves a call happened, not that an app can
be cold-started or that it will stay connected. An active long-poll refreshes
that server-observed presence and checks the authoritative SQLite queue every
60 seconds, including across separately running server processes. This is a
bounded fallback, not an external push wake or an app-launch mechanism. Worker-advertised delivery
modes remain unverified claims. No live host task delivery is marked
`autonomousWakeVerified=true` until independent real-host E2E evidence exists.
A listener cannot itself launch a closed ChatGPT, Claude, Grok or Gemini app.
The host must actually expose durable task/listening or a supported wake
mechanism and must be permitted to process work without interactive prompts.

Completion after a disconnect must not be assumed. Work is durable; lease
fencing prevents duplicate completions, and expired write-capable work
becomes `OUTCOME_UNKNOWN`, never an automatic retry. On failure, GPT-A must
inspect the evidence and choose a permitted recovery path.

## E2E host acceptance, one peer at a time

- Observe authenticated listener registration and task dispatch ID.
- Disconnect and reconnect the actual host without manually triggering the
  worker; verify whether it picks up work autonomously.
- Confirm one fenced claim, one authorized execution, one terminal receipt
  and full result retrieval by GPT-A.
- Verify the next task can be received and processed after rearm.
- Reject false-positive wake claims when only a server HTTP smoke or a
  self-reported delivery mode has been observed.

For native 2026 Tasks extension conformance, see
`docs/WORKFORCE_TASKS_WIRE.md`. Phase 3A exposes method-level interoperability;
the full `resultType:task` creation and `notifications/tasks` path remains
separate work requiring host negotiation and official-client tests.
