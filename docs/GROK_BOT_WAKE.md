# Grok Bot Routine wake (phase 3D)

Panter's Grok Bot Routine integration is distinct from the existing Xanxittoo Grok Routine. Do not repoint or change the Xanxittoo workflow. The operator configures a separate Panter Routine webhook URL and its native bearer key as protected `PANTER_WAKE_GROK_URL` and `PANTER_WAKE_GROK_KEY` environment variables. Panter does not copy or reveal secrets from another service.

GPT-A prefers active authenticated MCP listeners. When none is available and Grok is configured for the requested read-only role, the backend may queue one Grok work item and deliver a pointer-only HTTP doorbell. The Grok Routine must use its Panter OAuth worker connector to pick up that exact item, execute in Grok's host, submit its fenced terminal receipt and re-arm. Two or more outstanding tasks never trigger duplicate Grok routine calls. A 2xx response means SIGNAL_ACCEPTED; only a later actor-bound claim makes wakeObserved true. Full results remain in Mesh SQLite for GPT-A.

The implementation is not automatically enabled by having an OAuth client registration. Confirm actual Grok Routine setup, authenticated pickup and GPT-A receipt in a real-host E2E before declaring autonomous wake. For other peers, confirm each host's own Tasks/listen or scheduling mechanism. No model-provider API calls or production rollout are included.

Reference: https://docs.x.ai/grok-bot/skills-routines-and-automations
