# Host-native Workforce schedules: GPT-B, Claude, Gemini

GPT-A orchestrates and stores all results in the Panter Mesh ledger. A cloud
Task or Schedule is a **worker host execution mechanism**, not a Panter model
worker. OAuth identity, host permissions, stored task status and delivery
claims are different facts.

## Shared scheduled-worker contract

After GPT-A explicitly opts in an existing host profile and the host has
actually made at least one scheduled MCP call, GPT-A can select that worker
for the next safe (non-implementer) assignment using
`panter_mesh_delegate_auto`. Preference order: observed live MCP wait,
configured Grok webhook, recently observed scheduled worker; otherwise GPT-A
runs locally. Busy, stale, unconfigured and solo-mode peers are excluded.

Each native run invokes exactly one authenticated MCP call:

`panter_workforce_schedule_pickup(intervalSeconds=3600,leaseSeconds=900)`

- `EMPTY`: finish silently, no work or notification.
- `CLAIMED`: execute only the claimed task with the host model and existing
  approved tools. Preserve `workId`, `attemptId`, `leaseGeneration`.
- Complete with `panter_mesh_complete` using the exact lease identifiers and
  real result. No chat output is an authoritative receipt.
- Next real scheduled invocation acknowledges terminal rearm. A repeated
  invocation does **not** rerun already claimed work.
- Do not fabricate success if user approval, connector availability or quota
  blocks the host. Leave evidence and allow GPT-A to reconcile.
- No API tokens, email triggers, GitHub PR doorbells or secret instructions
  in the schedule trigger.

Server-configured `scheduledPickupEnabled` is a **permission to queue**,
not evidence of a real host scheduler. A first observed authenticated poll
is similarly not proof of unattended execution; use two independent
scheduled runs and a final receipt for host E2E.

## GPT-B (separate ChatGPT account)

Use ChatGPT's own scheduled Task or Work capability on the GPT-B account,
with that account's **existing GPT-B Panter OAuth plugin connection**.
The task's prompt is the shared contract above. Do not create the GPT-B
task in GPT-A's session and do not reuse GPT-A's OAuth grants.

ChatGPT scheduled work support and plugin access vary by account/plan.
Only mark the route as host-verified when a native scheduled invocation
actually reaches the GPT-B connector and produces an actor-bound result.

Source: https://help.openai.com/en/articles/10291617-scheduled-tasks-in-chatgpt

## Claude (Claude Cowork / unified experience)

Create a cloud scheduled task using the existing Claude Panter MCP connector.
Use its own skill/tool instructions and **hourly** schedule with the shared
contract. Cloud Claude tasks can use configured MCP connectors and skills
without leaving a desktop CLI running. Claude Code Channels, on the other
hand, are distinct and require the CLI process to remain alive.

Source:
https://support.claude.com/en/articles/13854387-schedule-recurring-tasks-in-claude-cowork

## Gemini (Task + Skill)

Use the full, concrete Gemini Skill in `GEMINI_WORKFORCE_TASK_SKILL.md`
and attach it to an hourly Task schedule. The official custom app support
enables MCP tools in Gemini Tasks. The user's existing Always allow
preference remains in the Gemini app; Panter does not alter it.

Source: https://support.google.com/gemini/answer/17094710

## Grok

Keep the previously approved native webhook Routine configured on Oracle.
Do not edit the separate Xanxittoo Grok Routine or copy its keys.
Grok webhook accepted != worker executed.

## Readiness acceptance

Require per host: connected OAuth actor; GPT-A profile opt-in; first actual
`SCHEDULED_POLL` host call; safe queue; host-native invocation later without
human chat intervention; fenced claim; real terminal receipt; repeat schedule
without duplicate execution. Until then `autonomousWakeVerified=false`.

All profile changes and E2E are performed **after** the PR passes exact-SHA CI,
independent review, RDD 4R and authorized Oracle deploy. No provider model
inference runs inside the Panter backend.
