# Native ChatGPT & Gemini app work directly over Panter MCP

## No Work, CLI, provider API or Oracle model runner

The configured leader orchestrates (GPT-A by default). GPT-B is an independent connected ChatGPT
application account, and Gemini is an independently connected Gemini
application account. Each uses its already approved OAuth grant to
`https://panter.example.com/mcp`. The same Panter-ai MCP HTTP endpoint
is the only control plane. No Codex CLI, Antigravity CLI, OpenAI/Google
model-provider APIs, ChatGPT Work, Gmail relay or additional local worker.

## Single direct in-app tool contract

Once either application has opened a host-native conversation and connected
its existing Panter MCP plugin, call:

`panter_workforce_app_turn(leaseSeconds=900)`

Only `gpt-b` and `gemini` actor identities can call this tool.
The server obtains the actor **from the authenticated request** and protocol
era **from the negotiated transport**, not from host-supplied arguments.
It atomically claims at most one actor-owned task with a fencing token
(`workId`, `attemptId`, `leaseGeneration`) and returns the actual
assigned instruction to that host. Retry does not clone an active task.

- `EMPTY`: no work; finish. Never tight-poll or invent work.
- `CLAIMED`: execute only the claimed instruction using native in-app
  reasoning/tools/subagents to the extent the **actual app** allows. For
  any action requiring writes, the independent host and Panter approvals
  remain mandatory; a claimed task is not an extra authorization.
- Finish using `panter_workforce_complete_and_rearm` with the exact fenced
  identifiers and factual result; GPT-A reads a compact receipt and can
  fetch full output with `panter_workforce_result_get`.
- For longer tasks use the existing `panter_mesh_heartbeat` and
  `panter_mesh_message` tools.
- The already-existing `panter_workforce_listen` can wait on a *currently
  active* MCP tool call, and `panter://inbox/{host}` resources provide
  revision notifications for compatible connected hosts.

The orchestrator delegates with existing `panter_mesh_delegate_auto`
(when an authenticated live listener is observed) or with
`panter_mesh_delegate` after a host profile is authorized.
The change does not rename, recreate or overwrite any OAuth client.

## Important difference: in-chat use vs cold-start wake

ChatGPT and Gemini applications demonstrably call MCP tools as clients,
and can run their own supported native tools; that does **not** imply that
an arbitrary MCP server can create a new assistant turn inside a closed,
inactive app conversation. The app controls whether it stays subscribed
to incoming notifications and whether such a notification triggers
autonomous model execution.

The MCP server supports live long-poll/notifications and normal MCP Tasks
compatibility surfaces, but **cannot certify cold-start from the server
alone**. A real host-side unattended event is required to promote
`autonomousWakeVerified` from false. Do not substitute Work, CLI or a
model inference API merely to manufacture that proof.

Do not merge or deploy before exact-SHA CI, independent GitHub APPROVED,
Panter-RDD 4R and owner authorization for the service switch.

Official sources:
- https://developers.openai.com/plugins/concepts/mcp-server
- https://developers.google.com/connected-apps/mcp/mcp-flow
- https://blog.modelcontextprotocol.io/posts/2026-07-28/
