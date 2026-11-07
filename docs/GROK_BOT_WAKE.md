# Grok Bot Routine wake (phase 3D)

Panter's Grok Bot Routine integration needs its own Routine. Do not reuse another service's Routine. The operator configures a separate Panter Routine webhook URL and its native bearer key as protected `PANTER_WAKE_GROK_URL` and `PANTER_WAKE_GROK_KEY` environment variables. Panter does not copy or reveal secrets from another service.

GPT-A prefers active authenticated MCP listeners. When none is available and Grok is configured for the requested read-only role, the backend may queue one Grok work item and deliver a pointer-only HTTP doorbell. The Grok Routine must use its Panter OAuth worker connector to pick up that exact item, execute in Grok's host, submit its fenced terminal receipt and re-arm. Two or more outstanding tasks never trigger duplicate Grok routine calls. A 2xx response means SIGNAL_ACCEPTED; only a later actor-bound claim makes wakeObserved true. Full results remain in Mesh SQLite for GPT-A.

The implementation is not automatically enabled by having an OAuth client registration. Confirm actual Grok Routine setup, authenticated pickup and GPT-A receipt in a real-host E2E before declaring autonomous wake. For other peers, confirm each host's own Tasks/listen or scheduling mechanism. No model-provider API calls or production rollout are included.

Reference: https://docs.x.ai/grok-bot/skills-routines-and-automations

## Long work and expired leases (1.5.1)

A claim lasts 5 minutes unless the worker asks for more (`leaseSeconds`, up to 3600) or renews it with `panter_mesh_heartbeat`. A review that also publishes on GitHub can take longer than that. For read-only work (every role except `implementer`), Panter keeps the result:

- **Late renewal and completion.** While the work is still `RUNNING` under the same attempt (same `attemptId` and `leaseGeneration`), the worker can renew or complete it after the lease ran out. The fence is the proof: if Panter had requeued, reclaimed or abandoned the work, the old attempt is refused with `Stale work lease`. Writers stay strict. An expired `implementer` is an unknown outcome, and only the operator reconciles it.
- **Grok stops looking busy.** The doorbell rings one Grok work at a time and waits while another one runs. Read-only work whose lease ran out more than 15 minutes ago no longer counts as running. Before 1.5.1, a review that never closed blocked every later ring.
- **Visible in the status.** `panter_workforce_status` reports `leaseExpired`: read-only work still `RUNNING` after its lease ran out, which its worker may still complete.

Grok should still ask for a lease that fits the job (for example `leaseSeconds: 900` for a review) or heartbeat while it works.
