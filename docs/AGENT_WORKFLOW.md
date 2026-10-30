# Panter-ai agent orchestration (alpha)

Panter-ai is the stateful coordination surface, not an AI model runtime. Every specialist is executed by an authenticated AI application or an external worker that calls Panter-ai MCP tools. A task sitting in the queue does **not** start a model or wake an inactive host.

## The workflow

1. **Classify:** the host translates the user's request into an explicit, conservative `panter_flow_route` decision. Small, low-risk work with enough context and a reproducible diff can be handled inline. Read-only questions do not authorize changes.
2. **Preserve:** create a mission and (for coordinated work) a flow containing the user's original specification exactly. Record scope, risk and authorization flags.
3. **Explore:** when context is uncertain, assign a `scout` (read-only). It returns concise file/line evidence and the relevant invariants. A `designer` can propose a bounded implementation plan without writing source.
4. **Implement:** the coordinator splits **independent behavior** into one or more `builder` assignments. Builders reserve non-overlapping file/path scopes within a named workspace. Each builder returns changed files, commit/diff references and reported test results.
5. **Freeze:** once all builders are complete, the coordinator freezes a concrete Git candidate SHA. New verification must target that exact candidate.
6. **Verify and review:** a separate reported worker runs relevant tests and/or assesses the frozen candidate. High-risk flows require an independent verifier; review can be made a flow requirement. Changing the candidate invalidates old verification/review results.
7. **Close:** the coordinator collects findings, rejects incomplete evidence, closes the flow and presents the result. Deployment/merge remains a separate explicit authorization and externally verified operation.

## Roles

| Agent | Permission | Contract |
|---|---|---|
| Coordinator (host) | User-scoped | Owns goal, routing, authorization and final response; not a server worker |
| Scout | Read-only | Locate relevant code, collect `path:line` evidence, identify uncertainty |
| Designer | Read-only | Propose bounded architecture and acceptance checks |
| Builder | Scoped writes | Complete one assigned implementation unit, with tests and change evidence |
| Verifier | Read-only reported | Verify a frozen candidate independently and report concrete checks |
| Reviewer | Read-only reported | Assess a frozen candidate and decide approve/reject with findings |

## Assignment lifecycle

```text
QUEUED ──claim──> CLAIMED ──complete──> DONE
                    │  └──fail───────> FAILED
                    │
                    └──ask───> WAITING_INPUT ──answer──> QUEUED

CLAIMED ──lease expiry──> eligible for re-claim (fenced generation)
```

A worker uses `panter_agent_packet` to fetch the exact original request, the role contract, the allowed edit scope, and relevant predecessor handoffs. A worker may not approve its own implementation under the reported worker-ID check. SHA changes invalidate any finished verification/review in that flow.

## Concurrent work

Independently delegated work may proceed concurrently, but two builders cannot reserve overlapping `scopes` within the same declared logical workspace. A separate `workspace` value is a caller-supplied *claim*, not proof that a worktree or sandbox exists. Panter-ai does not inspect or enforce filesystem paths: actual writes must be gated by host tools, Git permissions and isolated workspaces.

## Protocol limitations in this alpha

- One process and one trusted token control the entire agent-state store. Worker IDs are **not authenticated actor IDs**. Do not expose it to unknown contributors.
- Leases, task dependencies and result storage work, but agent inference is always initiated by the host. No model API, model process, automatic subagent-launch API or wake adapter exists on the server.
- Git SHAs, test output, reviewer reports and worker IDs are caller-reported; Panter-ai cannot independently validate their authenticity.
- Real GitHub MCP connections, CI proof checks, OAuth actor isolation and reliable external wake are separate planned integrations.
- A reported completed task should not be described as a verified deploy or merge.

## Next implementation gates

1. OAuth and authenticated worker identity with capability/grant scoping.
2. GitHub/CI MCP adapters for authentic candidate SHAs, tests and PR links.
3. Host capability negotiation and delivery adapters: native agent spawn where the host explicitly exposes it; MCP Tasks, scheduled listener or verified doorbells elsewhere.
4. Container/worktree-backed writing for hard file-system isolation and real parallel development.
5. End-to-end multi-host integration tests covering cancellation, wake, retry, quota and recovery.
