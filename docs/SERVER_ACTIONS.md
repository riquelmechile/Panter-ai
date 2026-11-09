# Server actions with single-use permits

**Status:** design. Nothing here is active until the operator sets `PANTER_SERVER_ACTIONS` on the server. With the variable unset every tool below answers `SERVER_ACTIONS_DISABLED` and Panter behaves exactly as before.

## Why

Agents sometimes have to act on the server that runs Panter: deploy a release, later restart a service or read a log. Today that goes through an SSH session with full access to the machine. Full access is the wrong unit of authority: it cannot be scoped, it cannot be taken back once handed over, and it does not say who did what.

This design replaces it with **server actions**: a short, fixed catalog of operations that Panter itself knows how to run. The leader hands a worker a **permit** for one action, Panter checks and runs that action, records it, and the permit is spent. No agent holds SSH, a shell or a credential, and no agent's own code runs on the server.

It follows the pattern Panter already uses for GitHub: the leader attaches a work-scoped grant when it delegates, the worker uses it while its claim is live, and the grant ends with the work. It adds **no** coordination rule between agents: delegation, claims, completion, pull requests and merges work as today. An earlier design that isolated arbitrary code on the server (the closed PR #102) showed how much machinery that takes; server actions avoid the problem by never running anything the catalog does not define.

## Three separate questions

| Question | Who answers it | Where |
|---|---|---|
| Is this server willing to run the action at all? | the operator | `PANTER_SERVER_ACTIONS` |
| Is the operator's authorization to deploy in place? | the operator | a standing authorization in configuration, or one per release (below) |
| Is this commit eligible? | Panter, against GitHub | the preconditions |

Enabling an action is **not** an authorization to use it, and eligibility is not either. `AGENTS.md` requires its own authorization for every deployment; this design gives that authorization a durable, checkable form instead of a chat message:

- **Standing authorization.** `PANTER_SERVER_DEPLOY_STANDING_AUTHORIZATION=1`, set by the operator in `panter.env`, authorizes deploying any commit that passes every precondition. It is the deployment counterpart of the standing merge authorization `AGENTS.md` already describes. Phase 1 adds that sentence to `AGENTS.md`.
- **Per release.** Without the standing authorization, each commit needs an operator record: `panter_server_authorize { action: "deploy.commit", sha }`, a tool that refuses every caller but the operator principal (never the leader or a worker), valid 24 hours. A record backs **one** use and is consumed atomically, never returned:

  | Record state | Becomes | When |
  |---|---|---|
  | `OPEN` | `BOUND` (to one permit, recorded on both) | the leader issues a permit for that `sha`; a unique index allows one permit per record |
  | `OPEN` | `CONSUMED` (to one action) | the leader runs the action itself, in the `RESERVED` transaction |
  | `BOUND` | `CONSUMED` | that permit's action is reserved |
  | `OPEN` or `BOUND` | `EXPIRED` | 24 hours pass |
  | `BOUND` | stays `BOUND` | its permit is revoked or expires: the operator authorized one attempt, so a retry needs a new record |

  A failed or rolled-back deploy therefore needs a new operator decision. The standing authorization has no such count: it covers every eligible commit until the operator removes it.

Both the leader's own runs and every permit need one of the two. With neither, `panter_server_grant` refuses to issue a permit and `panter_server_action` refuses to start (`NOT_AUTHORIZED`).

## The first action: `deploy.commit`

| Action | Arguments | What Panter runs |
|---|---|---|
| `deploy.commit` | `sha` (40 lowercase hex) | the existing `deploy/deploy.sh <sha>`, unchanged, as a transient systemd user unit |

`deploy.sh` already builds and tests the commit in its own release directory, takes a backup with the service stopped, switches `current`, waits for `/health` to report that commit and rolls back by itself if it does not. The action adds the authority around it, not a second deployment procedure.

### Preconditions

Checked by Panter, in this order, before anything is reserved. The first that fails is named in the answer and nothing is spent.

1. The action is enabled and authorized (above). For a worker: the permit is valid for this caller, this claim and this `sha` (see "Permits").
2. **On `main`.** `GET repos/{repo}/compare/{sha}...{default}` (base `sha`, head the default branch, so the answer describes the default branch relative to `sha`):

   | `status` | Meaning | Eligible |
   |---|---|---|
   | `identical` | `sha` is the tip of `main` | yes |
   | `ahead` | `main` contains `sha` and has moved on | yes |
   | `behind` | `sha` has commits `main` lacks | **no** |
   | `diverged` | neither contains the other | **no** |
   | anything else, an error, or `sha` unknown | | **no** |

3. **One merged pull request.** `GET repos/{repo}/commits/{sha}/pulls`, every page up to 100 entries (more fails). Keep only pull requests with `merged_at` set, `base.ref` equal to the default branch and `merge_commit_sha == sha`. **Exactly one** must remain; zero or several fail. Every later check uses that pull request only, never evidence mixed from another.
4. **Green on itself.** `GET repos/{repo}/commits/{sha}/check-runs`, every page up to 1000 runs (more fails). For each name in `PANTER_SERVER_DEPLOY_CHECKS` (default `test,arm64-image`), take the run with that name and the highest `id`, **whatever its status** (ids grow monotonically, so a queued or in-progress rerun is newer than an older success); it must exist, be `completed` and have conclusion `success`. An older success behind a newer pending or failed run does not count. Legacy commit statuses are deliberately not consulted: the configured checks must be check runs.
5. **Independently approved on the final head.** `GET repos/{repo}/pulls/{n}/reviews`, every page up to 1000 reviews (more fails). Among reviews by `PANTER_GITHUB_INDEPENDENT_REVIEWER` whose state is `APPROVED`, `CHANGES_REQUESTED` or `DISMISSED`, the latest by submission time must be `APPROVED` and its `commit_id` must equal the pull request's `head.sha`. This is the same latest-decisive-review rule `github-delivery.ts` applies, and phase 1 reuses that code.
6. **Local state.** `/health` does not already report this `sha`; `etc/maintenance` does not exist.

The checks repeat on the server what the merge already required, so neither a mistaken permit nor the leader can deploy a commit that is not merged, green and independently approved. `deploy.sh` additionally checks `merge-base --is-ancestor` against its own clone.

## Permits

A permit is a record in Panter's own state, not a signed token: Panter issues it, checks it and spends it in the same process, so there is no boundary for a signature to cross.

**Where it lives.** Claims are mutations of the single `mesh` document in `SqliteLedger`, and a separate ledger cannot join that transaction. So permits live **inside the mesh document**, next to the works they belong to (`d.serverPermits`), and every binding or revocation that depends on a claim happens inside the same `MeshEngine` mutation as the claim transition. Operator authorizations and actions live in their own `server-actions` ledger; the step that crosses the two, reserving an action, uses the order in "Action state machine".

```
{ permitId, missionId, workId, host, attemptId|null, leaseGeneration|null,
  action: "deploy.commit", args: { sha }, issuedBy, issuedAt, expiresAt,
  state: "ISSUED" | "SPENT" | "REVOKED" | "EXPIRED", actionId|null }
```

- **Issued by the leader only,** and only with the operator's authorization in place. It can be attached when the leader delegates (a new optional `server` field on `panter_mesh_delegate`, next to `github`) or later with `panter_server_grant`. In owner mode the leader issues it on its own, as it already does for GitHub grants.
- **Fenced to one claim.** If the work is already claimed, the permit records that claim's `attemptId` and `leaseGeneration`. If it is still queued, they stay null and `MeshEngine.claim` fills them in the same mutation that creates the claim. From then on the permit is usable only by the same host with exactly that `attemptId` and `leaseGeneration`, and only while the claim is live (the `liveWork` check). Every `MeshEngine` path that changes the claim of that work (requeue, a new claim, a new generation, `OUTCOME_UNKNOWN`, completion, withdraw, abandon, leader switch) revokes its `ISSUED` permits in that same mutation. As a second fence, using a permit also requires its recorded `attemptId` and `leaseGeneration` to match the caller's live claim, so a missed revocation still fails closed. A worker whose claim expired cannot get the permit back by claiming again: the leader has to issue a new one.
- **One action, fixed arguments:** a permit for `deploy.commit` on `abc…` cannot deploy anything else.
- **Expiry:** `expiresAt` (default 30 minutes, at most 2 hours), or when the work ends, is withdrawn or abandoned, or its run is closed: the hooks that revoke GitHub grants today revoke permits too.
- **Leader changes:** at start, and whenever `PANTER_LEAD_HOST` resolves to a different host than the one recorded in `issuedBy`, every `ISSUED` permit of the old leader is revoked.
- **Single use:** the permit is spent when the action is reserved (below), whatever the outcome. A failed precondition does not spend it; a reserved action always does.

## Action state machine

Actions live in the `server-actions` ledger. A partial unique index allows **at most one action in a non-terminal state** across the server, so two callers cannot both pass the preconditions and launch: the second gets `BUSY` from the insert, before anything runs.

**Reserving crosses two stores, in a fixed order.** (1) In the mesh mutation, check the permit against the live claim and mark it `SPENT` with a fresh `actionId`. (2) In one `server-actions` transaction, insert the action as `RESERVED` with that `actionId` (taking the unique slot) and consume the operator record if there is one. If (2) fails, for example `BUSY`, the permit stays spent and the answer says so: the safe failure is a lost permit, never a permit usable twice. If Panter dies between (1) and (2), the permit is spent and no action exists, which is the same safe failure; recovery reports a `SPENT` permit without an action as `PERMIT_LOST`. A direct leader run skips (1).

```
RESERVED ──▶ LAUNCHED ──▶ RUNNING ──▶ LIVE | ROLLED_BACK | BUILD_FAILED | FAILED | LOCKED
    │            │            │
    │            │            ├──▶ STOPPING ──▶ UNKNOWN
    │            │            └──────────────▶ UNKNOWN
    ├──▶ START_FAILED          (fence: closed)
    └──────┴──▶ ABANDONED      (fence: closed)
```

| State | Written when | Terminal |
|---|---|---|
| `RESERVED` | preconditions passed; same transaction spends the permit and takes the unique slot | no |
| `LAUNCHED` | `systemd-run` returned success for unit `panter-action-<actionId>` | no |
| `RUNNING` | the wrapper wrote its first record | no |
| `LIVE`, `ROLLED_BACK`, `BUILD_FAILED`, `FAILED`, `LOCKED` | read from the wrapper's final record | yes |
| `START_FAILED` | `systemd-run` returned an error in the reserving request, and that request created the fence as `closed` | yes |
| `ABANDONED` | no record, no unit, and the fence says `closed` (created by this pass or by an earlier process that died before recording it); nothing ran | yes |
| `STOPPING` | the unit has run past its allowance without a record (see recovery); Panter asked systemd to stop it | no |
| `UNKNOWN` | the unit is confirmed gone and the outcome cannot be read without guessing (see recovery) | yes |

Terminal states free the slot. An action **never** becomes terminal while its unit is still live, and an action without a record ends as `ABANDONED` or `START_FAILED` only when the fence says `closed`, so a terminal state always means nothing is running and nothing can still start. `UNKNOWN` is flagged for the operator but does not block later actions. Nothing is ever re-run: every transition out of `RESERVED` or later is a reading, or a stop, never a new launch.

## Running a deploy without cutting the branch Panter sits on

`panter-ai.service` runs with `KillMode=control-group`, and `deploy.sh` stops and restarts that service. A deploy started as a child of Panter would be killed half way. So Panter never runs `deploy.sh` itself. After `RESERVED` is committed, it starts:

```
systemd-run --user --unit=panter-action-<actionId> --collect --property=RuntimeMaxSec=45min \
  --setenv=PANTER_SOURCE_REPO=<configured clone> <base>/current/deploy/run-action.sh deploy.commit <actionId> <sha>
```

The unit name is derived from `actionId` (a UUID), so it cannot collide and recovery can always find it. The argument vector is fixed and built by Panter; the only value from the request is the `sha`, already validated and checked. No shell, no other command, no environment from the request.

`deploy/run-action.sh` is a small wrapper in the repository. Its first action is to take the fence (below) with `ln -s run <fence>` (no `-f`): if that fails because the link exists, whatever it points to, it exits with status 0 and does nothing. Then it writes `etc/actions/<actionId>.json` with `RUNNING` (atomically: write a temporary file, `fsync`, rename), runs `deploy.sh <sha>` with its output in `etc/actions/<actionId>.log`, and writes the final record the same way: exit code, the revision `/health` reports, and one of `LIVE`, `ROLLED_BACK`, `BUILD_FAILED`, `FAILED`, or `LOCKED` when `deploy.sh` refused because another deploy or the daily backup holds its lock. **The wrapper takes no lock of its own**: `deploy.sh`'s `releases/.deploy.lock` is the only lock, and the ledger's unique slot is the only gate on the Panter side.

## Recovery

**Launch and reconciliation never overlap: one fence, taken where the effect happens.** No timeout is treated as proof that a launch cannot still happen: a process can be frozen between any two steps, and systemd may still create a unit after the `systemd-run` client was killed. So the decision of whether an action may run is made by a single atomic file operation that both sides use:

```
etc/actions/<actionId>.fence    a symbolic link created with symlink(2), which fails if it already exists
  -> "run"      created by the wrapper, as its first action, before writing RUNNING or touching deploy.sh
  -> "closed"   created by Panter, before it writes START_FAILED or ABANDONED for an action with no record
```

Whoever creates the link first wins, and the link says who it was (`readlink`). The wrapper that finds the link already pointing to `closed` exits at once with status 0 and does nothing: a late, frozen or duplicated launch can therefore never deploy after Panter closed the action. Panter, finding the link pointing to `run`, never closes the action from "no unit": the wrapper ran, so the action follows the `RUNNING` rows of the table. The two-minute wait below only avoids closing launches that are merely slow; correctness comes from the fence, not from the clock. Immediately before `systemd-run`, the launching request re-reads the action in a transaction, proceeds only if it is still `RESERVED` and unmarked, and marks it with `launchStartedAt`; that only keeps two launches of one action from both calling `systemd-run` in the normal case, and starts the two-minute wait. The `systemd-run` call keeps a 30-second timeout as hygiene, so a stuck client does not hold the request forever. Neither is relied on for safety.

On start, and every 30 seconds while an action is open, Panter reconciles each non-terminal action from three observations: its ledger state, the record file, and `systemctl --user show panter-action-<actionId> -p LoadState,ActiveState`. The unit is **gone** when `LoadState` is `not-found`, or `ActiveState` is `inactive` or `failed` (with `--collect` a stopped unit is unloaded soon after). It is **live** when `ActiveState` is `activating`, `active`, `reloading` or `deactivating`.

The fence is read with `readlink` on the link itself, never with `stat` or `test -e` (the targets `run` and `closed` do not exist as files, so the links dangle on purpose). Its observed value is one of: **absent** (`ENOENT`), **`run`**, **`closed`**, or **odd** (any other target, or any other error). Taking it means `symlink("closed", …)`; on `EEXIST` Panter reads it again and uses what it finds. Fences live in `<base>/etc/actions/`, outside every release directory, so they survive a deploy and a rollback; Panter never deletes them.

| Fence | Record file | Unit | Panter writes |
|---|---|---|---|
| `run` | final record, well formed | gone | the record's state |
| any | any | live, and the action is younger than `RuntimeMaxSec` + 5 minutes | nothing yet; next pass |
| any | any | live, and older than that | `STOPPING`, then `systemctl --user stop` on the unit; next pass |
| `run` | `RUNNING`, none, malformed or unreadable | gone | `UNKNOWN` (the wrapper ran; it may have reached `deploy.sh`) |
| absent | none | gone, less than 2 minutes after `launchStartedAt` (or after the reservation if never marked) | nothing yet; next pass |
| absent | none | gone, 2 minutes or more | take the fence; on success `ABANDONED`, on `EEXIST` apply this table again with what the fence now says |
| `closed` | none | gone | `ABANDONED` (nothing ran and nothing can run; written whoever created `closed`, including an earlier process that died before recording it) |
| `closed` | any record | gone | `UNKNOWN` (impossible by construction; fail closed and flag it) |
| absent | `RUNNING`, final, malformed or unreadable | gone | `UNKNOWN` (a record without the fence is impossible by construction; fail closed) |
| odd | any | gone | `UNKNOWN` |

"Gone" and "live" are the `ActiveState` definitions above. Every row with the unit gone ends the action, so no combination leaves the slot taken once the unit has stopped, and every row that writes `ABANDONED` has `closed` in the fence, so no wrapper can still deploy.

One case is decided outside this table: when `systemd-run` itself returns an error in the request that reserved the action, that same request tries to take the fence. If it creates `closed`, it writes `START_FAILED`; whatever systemd does later, the wrapper will find `closed` and do nothing. If the fence already exists, the action stays open and the table takes over. If that request dies between creating `closed` and writing `START_FAILED`, the next pass finds `closed`, no record and no unit, and writes `ABANDONED`: the original reason is lost, the safety is not. A Panter crash after the unit was accepted but before the wrapper did anything is a "live" row: Panter waits for the wrapper, and `RuntimeMaxSec` bounds the wait. No record can appear after a terminal state: `ABANDONED` and `START_FAILED` stand on `closed`, and `UNKNOWN` is only written once the unit is gone.

## What gets recorded

For every action: who issued the permit and under which authorization (standing, or the operator record's id), which worker used it with which claim, the arguments, each precondition and its result, every state transition with its time, the exit code, the revision `/health` reported afterwards and the SHA-256 of the log. The worker and the leader both get a receipt in their inbox when it reaches a terminal state. `panter_server_status` shows open and recent actions and permits; the log stays on the server under `etc/actions/`, readable by the operator. Agents get its last 50 lines with known secret patterns redacted.

## Tools

| Tool | Listed for | What |
|---|---|---|
| `panter_server_authorize { action, sha }` | operator only | records a per-release authorization |
| `panter_server_grant { workId, action, args, ttlMinutes? }` | (leader, via router) | issues a permit for the worker of that work |
| `panter_server_revoke { permitId }` | (leader, via router) | revokes an unspent permit |
| `panter_server_action { action, args, permitId?, workId?, attemptId?, leaseGeneration? }` | worker | checks everything and starts the action; the leader may call it without a permit |
| `panter_server_status { actionId? }` | (leader, via router) | open and recent actions and permits; a worker sees its own |

Their names fall in the `admin` domain, so they are reached through `panter_admin` as `server_authorize`, `server_grant`, `server_revoke`, `server_action` and `server_status`. The leader's listed surface is full (50), so none is added to it; workers get `panter_server_action` listed (31 → 32). `panter_server_authorize` refuses any caller that is not the operator principal, whatever route it comes through.

## Configuration

In `panter.env`, all optional:

- `PANTER_SERVER_ACTIONS=deploy.commit`: the actions this server allows (comma-separated). Unset: none.
- `PANTER_SERVER_DEPLOY_STANDING_AUTHORIZATION=1`: the operator's standing authorization (above). Unset: one operator record per release.
- `PANTER_SERVER_DEPLOY_REPOSITORY=<owner>/<repo>`: the repository whose default branch is deployed.
- `PANTER_SERVER_DEPLOY_SOURCE=<path to the clone>`: what `deploy.sh` needs as `PANTER_SOURCE_REPO`.
- `PANTER_SERVER_DEPLOY_CHECKS=test,arm64-image`.

## What this does not do

- It does not give agents a shell, SSH, or any command outside the catalog.
- It does not deploy anything that is not merged, green and independently approved on `main`, or without the operator's authorization. It does not merge.
- It does not roll back data; `deploy.sh` rolls back code only, as today (`OPERATIONS.md`).
- It does not protect against someone who already controls the server, `panter.env` or the operator's GitHub account.
- `deploy.sh` runs `npm ci`, the build and the tests of the commit on the server, as it does today. That is code that passed review and CI on `main`, not arbitrary code; the action does not change that trust.

## Later actions (not part of this work)

Each one is its own pull request with its own preconditions, authorization rule and tests: `service.restart` (only units named in configuration), `logs.tail` (fixed units, fixed line count, secrets redacted), `backup.now` (the existing `backup.mjs`).

## Phases

| Phase | Deliverable |
|---|---|
| 0 | This design |
| 1 | Authority and checks: permits inside the mesh document with binding and revocation in every claim transition, the `server-actions` ledger (operator authorizations with their state table, actions with the unique slot), the reserve order across the two, the five tools, the `server` field on `panter_mesh_delegate`, the preconditions against GitHub with the truth tables above (including an older success behind a newer pending run), the `AGENTS.md` sentence. `deploy.commit` stops after `RESERVED` in **dry-run**: it answers what it would launch and frees the slot. Tests with a fake GitHub API covering every row of the tables |
| 2 | Execution: `deploy/run-action.sh`, the `systemd-run` launch, the records, recovery with every row of its table and every `ActiveState`, `STOPPING`, the fence with every row of the table (including deterministic tests of a launcher frozen after marking, a `systemd-run` killed after sending its request, a unit that systemd starts late after `ABANDONED`, and a Panter that dies between creating `closed` and recording `ABANDONED` or `START_FAILED`, recovered by a restarted or second process), receipts; tests with a fake `systemd-run`, a fake `systemctl` and a fake `deploy.sh` |
| 3 | On the operator's server, with explicit authorization: enable `deploy.commit`, then the leader delegates the next release's deploy to a worker with a permit, and the result is checked against `/health` |

Phases 1 and 2 share only this document and the record format in `etc/actions/`. Every phase is a pull request with CI green, Codex, an independent review on the exact head commit by the reviewer account, and a squash merge by the leader.
