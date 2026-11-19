# Changelog

All notable changes to Panter-ai. Versions follow [Semantic Versioning](https://semver.org/). Releases before 1.0 are described in [docs/HISTORY.md](docs/HISTORY.md).

## Unreleased

### Fixed
- **Leases that fit the work.** Every claim used to get five minutes unless the worker asked for more, so a writer's lease ran out before its first commit: the commit was refused as stale, the work stayed `RUNNING` with nobody on it, and only an operator could close it.
  - A claim, pickup or heartbeat that names no `leaseSeconds` now gets the default of the work's role: 3600 s for a writer, 900 s for read-only work. An explicit value is honoured as before (30 to 3600).
  - Implicit heartbeat: a worker using its work's GitHub grant (`panter_github_*`, reads included) keeps its lease. Same fence as `panter_mesh_heartbeat` (the call carries the attempt and its generation), a lease is never shortened, and it writes only when less than half the default is left. A message does not renew a lease: it carries no fence.
  - Owner mode: a writer whose lease ran out can still renew or complete while its fenced attempt holds (same `attemptId` and `leaseGeneration`, nobody claimed it again), as read-only work already could. Outside owner mode writers stay strict. Claiming an expired writer again is still `OUTCOME_UNKNOWN` in every mode.
- **Expired work is swept.** Directed work (delegated by the leader, outside a harness run) had nothing that ever ended a claim whose worker was gone: it stayed `RUNNING` for days, counted as load and, for a writer, held its edit scope until an operator noticed. Every five minutes Panter now looks for claims whose lease ran out more than `PANTER_SWEEP_GRACE_SECONDS` ago (default 6 hours; until then the same attempt may still finish late) and that no transport holds:
  - Read-only work ends `ABORTED_NO_EFFECTS`, its GitHub grant is closed and the leader gets one message.
  - A writer becomes `OUTCOME_UNKNOWN`, as if it had been claimed again: nothing is replayed and its scope stays held. Ten minutes later (a write authorized just before may still be on its way; nothing new can be authorized after) Panter looks once at what the work left: its own branch and pull requests from it on GitHub, and what its grant durably recorded (the write budget it reserved, the branch it created, what it opened). The leader gets the evidence with the fence a reconciliation needs.
  - Owner mode only: a writer for which nothing was found is closed `ABORTED_NO_EFFECTS` without waiting for the operator. Outside owner mode, and whenever something was found or GitHub could not be asked, the work waits for `panter_mesh_reconcile_writer` as before.
- `panter_mesh_delegate_auto` in owner mode no longer counts expired claims and writers of unknown outcome as load, and puts workers that claimed or completed something in the last 72 hours before workers that have not answered. Before, stuck work made the hosts that answer look busy and sent new work to the ones that do not.
- **Queued work nobody claims is no longer left alone.** A wake is rung a bounded number of times (three for an app host, ten minutes apart); after that nothing happened and the work could sit in the queue for days. Every five minutes Panter now looks at directed work that has been queued for 30 minutes (two poll intervals for a host that only polls on a schedule):
  - Owner mode: work that was never claimed moves once to another reachable worker with the role, the ones that answered recently first, under the same reachability rules as `panter_mesh_delegate_auto`. Its frozen execution settings become the new worker's and its GitHub grant moves with it (only a grant that never wrote anything; a default `panter/<worker>-<id>` branch name follows the worker). The leader gets one `REASSIGNED_UNCLAIMED` message. Work that was ever claimed, is bound to a specialist or holds a server permit never moves.
  - Otherwise, and when the new worker does not claim it either, the leader gets one `UNCLAIMED_QUEUED` message and decides. Work waiting behind a worker that is busy on something else is not reported.
  - Harness and review work is left to the harness, which has its own pickup timeouts.
- `claimedAt` on each work (when the worker itself claimed its current attempt), in the leader's inbox and in the work view used for grants.

## 1.6.0 (2026-11-10)

### Added
- **Server actions** (disabled unless `PANTER_SERVER_ACTIONS` is set; see `docs/SERVER_ACTIONS.md` and `docs/OPERATIONS.md`). The leader can hand a worker a single-use permit to deploy one exact commit. Panter gives no shell: it checks that the commit is on `main`, merged through one pull request, green on the required checks and approved on its final head by the independent reviewer, and then runs the unchanged `deploy/deploy.sh` for it in a transient systemd unit.
  - The operator authorizes deployments separately, per release (`panter_server_authorize`) or with a standing setting. Enabling the feature authorizes nothing.
  - A permit is fenced to one claim of one work: it is revoked when that claim ends, is released, lapses or is taken over, and it is spent before anything runs. Only one action can be open on the server.
  - `deploy/run-action.sh` takes a fence before any effect, records the start and the outcome, and always exits with `deploy.sh`'s status. A reconciler settles every action from the fence, the unit and that record, also after the restart the deployment itself causes, and never leaves the slot taken once the unit is gone.
  - When an action ends, the leader and the worker each get one inbox message. `panter_server_status` shows the state, every precondition, the exit code, the revision `/health` reported and the redacted last lines of the log.
  - `PANTER_SERVER_DEPLOY_DRY_RUN=1` checks everything and launches nothing, to validate a server's configuration first.
  - Five tools, reached through the `panter_admin` router; workers get `panter_server_action` listed.

## 1.5.1 (2026-11-09)

### Fixed
- A read-only work item (review, verification, exploration) whose lease ran out while its worker was still finishing kept its result out of Panter: completing failed with `Lease expired` even though nobody had taken the work over. The worker can now renew or complete it late, as long as its fenced attempt still holds (same `attemptId` and `leaseGeneration`). Writers stay strict.
- Such an item stayed `RUNNING` forever and kept Grok "busy", so the doorbell never rang for later work. Read-only work whose lease expired more than 15 minutes ago no longer counts as busy. An expired writer still does.
- `panter_workforce_status` shows `leaseExpired` per host; before, these items were invisible (`running: 0`).
- A work event (`panter.work.ready`, the wake for ChatGPT and Gemini apps) was sent once per work: if the app accepted it but the host ended its run without claiming, the work sat in the queue until someone opened the app. While the work is still queued 10 minutes after an accepted event, Panter now sends it again, at most 3 times in total, each with its own event id so the receiver does not drop it as a duplicate. `panter_workforce_event_status` shows `rerung`.

### Docs
- README in English and Spanish (`README.md`, `README.es.md`) with diagrams for each language: architecture, how a task flows, how workers wake up, the delivery gate and owner mode, and what lives in the repository versus your server. Corrected the worker tool count (31, routers included).
- The asset test covers both READMEs and checks they show the same diagrams, each in its own language.
- Motion identity: an animated hero (drifting aurora, the mascot's connector pulsing, the title as vector paths in Space Grotesk) and a terminal that types a task moving through Panter, both in English and Spanish, replace the static banner. Every diagram shows a work packet travelling its path. All of it is pure SVG with no scripts or external requests, works in dark and light themes and stands still for readers who ask for reduced motion (a new test checks this).
- `scripts/brand` holds the generators, so anyone can change the text and rebuild the images (`sh build.sh`).

### Community
- `SECURITY.md` (private vulnerability reporting, scope), `CODE_OF_CONDUCT.md`, issue templates for bugs and feature requests (blank issues off) and a pull request template.

### Docs accuracy
- Pages that still said GPT-A is the only coordinator now name the configured leader (`PANTER_LEAD_HOST`), as the code does; legacy pages carry a note. The roadmap header says which early items were superseded and that the runner is still inactive.
- `TOOL_SURFACE.md`: the stale-list section is in Spanish like the rest of the page, the worker count is 31 with routers, and a misplaced note about sensitive-mission addresses moved to `GEMINI_MAIL_WAKE.md`.

## 1.5.0 (2026-11-06)

### Public, generic repository
- No owner accounts, domains, server paths or store names in code, tests, examples or docs: example configs use `your-org/*` and `<reviewer-account>`, tests use `example-org/*`, README images use relative paths.
- The one-time bootstrap exception of the delivery gate is configured with `PANTER_GITHUB_BOOTSTRAP_REPOSITORY` instead of a repository written in the code.
- Removed operator-specific logs and migration notes from `docs/`. New [docs/SELF_HOSTING.md](docs/SELF_HOSTING.md): what goes in your server's `panter.env` and what never goes in the repository.
- `tests/public-repo-hygiene.test.ts` fails CI on a tracked credential in a real format or a real value in the example configs.

## 1.4.0 (2026-11-06)

### Owner mode
- `PANTER_OWNER_MODE=1` for a single-owner deployment (see [docs/OWNER_MODE.md](docs/OWNER_MODE.md)): write grants become optional and the leader delegates `implementer` work directly (before, `panter_mesh_delegate` with that role always failed with `Authorized run required`); writers may cover the whole repository; wake routes accept writers and queue work behind a busy peer; `panter_mesh_delegate_auto` picks the least-loaded reachable worker; keyword and unknown-scope risk become advice; the GitHub delivery gate keeps blocking only on exact SHA, open non-draft PR, authorized base, required CI and the independent reviewer, and reports the conventions as warnings; automatic per-phase GitHub grants are on; up to 10 corrections per run.
- What stays in every mode: workers never merge, approve, force-push or write default/protected branches, CI and git config files; secrets stay on the server; sensitive-mission checks.

### Workforce
- `panter_workforce_status` adds `wakeRoutes`, `last24h` and `reachable` per worker, so a 2-minute `STALE` presence no longer reads as "the worker is down".
- `panter_mesh_withdraw` (mesh router): the leader withdraws queued work no worker started and revokes its GitHub grant.

## 1.3.0 (2026-11-05)

### Workforce
- Grok is rung for every queued work, not only `panter_mesh_delegate_auto`: a directed `panter_mesh_delegate` rings it too (after any GitHub grant; the answer carries `grokWake`), and a one-minute sweep rings the oldest queued Grok work that was never rung once Grok is free (work younger than 30 s is left to its creator, which may still be attaching a grant). A ring that failed, or that Grok did not pick up within 15 minutes, no longer keeps Grok busy and is rung again up to 3 times. A new directed delegate whose GitHub grant fails is withdrawn (a replay of existing work keeps it). Before, directed work waited forever and an earlier unrung work kept Grok looking busy.
- Gemini by e-mail: work of a sensitive mission is never mailed (its task would leave Panter in a mail, and Gemini's mail runtime has no Panter tools); it waits for a live Gemini chat. The mail relay's bounce now says why Panter refused a result (e.g. which kind of personal data a sensitive mission refused).
- Sensitive missions: Panter's own mailboxes (`PANTER_GEMINI_MAIL_RECIPIENT` and `PANTER_SENSITIVE_ALLOWED_ADDRESSES`, exact addresses) no longer count as personal data, so a worker quoting how it is woken is not refused.

### Tool surface
- `notifications/tools/list_changed` when the tool surface changes (a deploy, a new downstream server, or a downstream server whose tools changed), including across restarts, repeated after one and five minutes for hosts that reconnect. The surface fingerprint is in the server instructions; `panter_admin` operation `surface_status` (tool `panter_surface_status`) says what the caller's list should contain and whether a known fingerprint is stale. Hosts that keep the list read when the connector was added (ChatGPT, Gemini) still need a connector refresh; meanwhile every tool stays callable through its router and downstream servers through `downstream_call`.

## 1.2.1 (2026-11-05)

- `panter_downstream_call`: reach a downstream server by name (same authorization, write policy, grants and audit as its `panter_ds_<name>` router), also through the `panter_admin` router, so a host whose connector's tool list predates a newly mounted server can use it without reloading.

## 1.2.0 (2026-11-05)

### Downstream gateway
- OAuth client credentials for downstream servers (`oauth` in the config): cached token, renewed before expiry and once on a 401, never shown. Needed to mount servers that only accept OAuth, such as commerce-control.
  A refused write is never replayed (only calls authorized as reads and protocol requests are retried with the new token); it fails alone, without breaking the connection; refusals count toward the circuit breaker once per token. A failed renewal keeps using the current token until it really expires. A token replaced while a call runs stays redacted until it expires, a late 401 for an older token does not discard the newer one, the token endpoint's answer is limited to 64 KB, and Basic credentials are form-encoded (RFC 6749).

## 1.1.0 (2026-11-04)

### Downstream gateway
- Signed actor identity: every forwarded call carries `_meta["panter-ai/actor"]`, an Ed25519-signed assertion of the calling host, its role and mission, bound to the server, tool, arguments and a 120-second lifetime. Public keys at `/.well-known/panter-downstream-keys`; reference verifier in `src/core/actor-assertion.ts`.
- `sensitive` servers: proxied without keeping content (no argument hash, no error text in audit, status or log), every call names its mission, answers are marked sensitive.
- Sensitive missions: a mission that called a sensitive server is never mirrored to Engram, and Panter refuses new text with a personal identifier for it (harness reports, delegated work, results, messages, reviews, memory; heuristic check: RUT, e-mail, +56 phone). Marks are durable and never dropped; `panter_downstream_unmark` (operator) clears one set by mistake.
- The audit records each call's role and mission.

## 1.0.0 (2026-11-04)

The first stable release: the developer-preview features are now the supported product, deployed and running in production.

### Coordination
- Configurable leader (`PANTER_LEAD_HOST`); every other connected host is a worker.
- Automatic ODD harness: phases chosen by risk, run inline, natively or on the bound remote host, with pickup timeouts and native fallback for the host that failed.
- `panter_harness_close` stops a run for good, withdrawing its remote work and revoking its grants.
- Durable mesh and workforce: delegation, claims with leases, heartbeats, results, wake for Claude routines, Grok and Gemini (mail relay).

### Review
- 4R with four lenses on their bound remote hosts, and Judgment Day with two blind judges on bound hosts that did not write the candidate.
- Panter-RDD acknowledges only reviews bound to the exact commit and its CI, with optional transport attestation that also refuses receipts from hosts that wrote the candidate.

### GitHub
- GitHub workforce: write access scoped to one work item, granted on dispatch and revoked when the work ends, with an audit trail.
- Formal approvals come only from a dedicated independent reviewer account on the exact head SHA.

### Tools
- Per-role `tools/list` (leader, worker, operator) and eight domain routers; every tool stays callable by name.
- Downstream MCP gateway: other MCP servers mounted behind Panter, each as one router (`panter_ds_<name>`), with timeouts, a circuit breaker, write grants and audit.

### Operations
- `deploy/deploy.sh` deploys an exact commit of main: build and test in its own release, backup with the service stopped, switch, health check on that revision, automatic rollback.
- `deploy/backup.mjs`: SQLite copy with a restore check, plus the environment and JSON stores; daily backups through a systemd timer.
- Health-check timer that restarts the service after two failed checks, with an optional alert webhook.
- `/health` reports the package version and the release commit.

### Brand
- Panter, the mascot: a panther with a mouse's face. New README, banner and architecture diagram.
