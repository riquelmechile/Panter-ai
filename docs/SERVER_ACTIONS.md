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
- **Per release.** Without the standing authorization, each commit needs an operator record: `panter_server_authorize { action: "deploy.commit", sha }`, a tool listed only for the operator principal (never for the leader or a worker), valid 24 hours, single use.

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
4. **Green on itself.** `GET repos/{repo}/commits/{sha}/check-runs`, every page up to 1000 runs (more fails). For each name in `PANTER_SERVER_DEPLOY_CHECKS` (default `test,arm64-image`), take the run with that name and the latest `completed_at` (ties: highest `id`); it must exist, be `completed` and have conclusion `success`. Legacy commit statuses are deliberately not consulted: the configured checks must be check runs.
5. **Independently approved on the final head.** `GET repos/{repo}/pulls/{n}/reviews`, every page up to 1000 reviews (more fails). Among reviews by `PANTER_GITHUB_INDEPENDENT_REVIEWER` whose state is `APPROVED`, `CHANGES_REQUESTED` or `DISMISSED`, the latest by submission time must be `APPROVED` and its `commit_id` must equal the pull request's `head.sha`. This is the same latest-decisive-review rule `github-delivery.ts` applies, and phase 1 reuses that code.
6. **Local state.** `/health` does not already report this `sha`; `etc/maintenance` does not exist.

The checks repeat on the server what the merge already required, so neither a mistaken permit nor the leader can deploy a commit that is not merged, green and independently approved. `deploy.sh` additionally checks `merge-base --is-ancestor` against its own clone.

## Permits

A permit is a row in Panter's own SQLite ledger, not a signed token: Panter issues it, checks it and spends it in the same process, so there is no boundary for a signature to cross.

```
{ permitId, missionId, workId, host, attemptId|null, leaseGeneration|null,
  action: "deploy.commit", args: { sha }, issuedBy, issuedAt, expiresAt,
  state: "ISSUED" | "SPENT" | "REVOKED" | "EXPIRED", actionId|null }
```

- **Issued by the leader only,** and only with the operator's authorization in place. It can be attached when the leader delegates (a new optional `server` field on `panter_mesh_delegate`, next to `github`) or later with `panter_server_grant`. In owner mode the leader issues it on its own, as it already does for GitHub grants.
- **Fenced to one claim.** If the work is already claimed, the permit records that claim's `attemptId` and `leaseGeneration`. If it is still queued, they stay null and are filled **atomically by the first claim**, in the same transaction as the claim. From then on the permit is usable only by the same host with exactly that `attemptId` and `leaseGeneration`, and only while the claim is live (the `liveWork` check). Any later claim transition of that work (requeue, a new claim, a new generation, `OUTCOME_UNKNOWN`) revokes the permit in the same transaction. A worker whose claim expired cannot get the permit back by claiming again: the leader has to issue a new one.
- **One action, fixed arguments:** a permit for `deploy.commit` on `abc…` cannot deploy anything else.
- **Expiry:** `expiresAt` (default 30 minutes, at most 2 hours), or when the work ends, is withdrawn or abandoned, or its run is closed: the hooks that revoke GitHub grants today revoke permits too.
- **Leader changes:** at start, and whenever `PANTER_LEAD_HOST` resolves to a different host than the one recorded in `issuedBy`, every `ISSUED` permit of the old leader is revoked.
- **Single use:** the permit is spent in the same transaction that reserves the action (below), whatever the outcome. A failed precondition does not spend it; a started action always does.

## Action state machine

Actions live in the same ledger. A partial unique index allows **at most one action in a non-terminal state** across the server, so two callers cannot both pass the preconditions and launch: the second gets `BUSY` from the insert, before anything runs.

```
RESERVED ──▶ LAUNCHED ──▶ RUNNING ──▶ LIVE | ROLLED_BACK | BUILD_FAILED | FAILED | LOCKED
    │            │            │
    └──▶ START_FAILED          └──────────────▶ UNKNOWN
                 └─────────────────────────────▶ UNKNOWN
```

| State | Written when | Terminal |
|---|---|---|
| `RESERVED` | preconditions passed; same transaction spends the permit and takes the unique slot | no |
| `LAUNCHED` | `systemd-run` returned success for unit `panter-action-<actionId>` | no |
| `RUNNING` | the wrapper wrote its first record | no |
| `LIVE`, `ROLLED_BACK`, `BUILD_FAILED`, `FAILED`, `LOCKED` | read from the wrapper's final record | yes |
| `START_FAILED` | `systemd-run` returned an error and `systemctl --user show` confirms no unit by that name exists | yes |
| `UNKNOWN` | the outcome cannot be read without guessing (see recovery) | yes |

Terminal states free the slot. `UNKNOWN` is terminal for the ledger but flagged for the operator; it never blocks later actions, because it is only written once the unit is confirmed gone, and `deploy.sh`'s own lock protects the release directory regardless. Nothing is ever re-run: every transition out of `RESERVED` or later is a reading, never a new launch.

## Running a deploy without cutting the branch Panter sits on

`panter-ai.service` runs with `KillMode=control-group`, and `deploy.sh` stops and restarts that service. A deploy started as a child of Panter would be killed half way. So Panter never runs `deploy.sh` itself. After `RESERVED` is committed, it starts:

```
systemd-run --user --unit=panter-action-<actionId> --collect --property=RuntimeMaxSec=45min \
  --setenv=PANTER_SOURCE_REPO=<configured clone> <base>/current/deploy/run-action.sh deploy.commit <actionId> <sha>
```

The unit name is derived from `actionId` (a UUID), so it cannot collide and recovery can always find it. The argument vector is fixed and built by Panter; the only value from the request is the `sha`, already validated and checked. No shell, no other command, no environment from the request.

`deploy/run-action.sh` is a small wrapper in the repository. It writes `etc/actions/<actionId>.json` with `RUNNING` (atomically: write a temporary file, `fsync`, rename), runs `deploy.sh <sha>` with its output in `etc/actions/<actionId>.log`, and writes the final record the same way: exit code, the revision `/health` reports, and one of `LIVE`, `ROLLED_BACK`, `BUILD_FAILED`, `FAILED`, or `LOCKED` when `deploy.sh` refused because another deploy or the daily backup holds its lock. **The wrapper takes no lock of its own**: `deploy.sh`'s `releases/.deploy.lock` is the only lock, and the ledger's unique slot is the only gate on the Panter side.

## Recovery

On start, and every 30 seconds while an action is open, Panter reconciles each non-terminal action from three observations: its ledger state, the record file, and `systemctl --user show panter-action-<actionId> -p LoadState,ActiveState`.

| Ledger | Record file | Unit | Panter writes |
|---|---|---|---|
| any | final record | any | the record's state |
| any | `RUNNING` | loaded and active | nothing yet (check again later) |
| any | `RUNNING` | not found | `UNKNOWN` |
| `RESERVED` or `LAUNCHED` | none | loaded and active | nothing yet, up to 2 minutes; then `UNKNOWN` if still no record |
| `RESERVED` | none | not found | `UNKNOWN` (Panter may have died after `systemd-run` started the unit; nothing proves it did not run) |
| `LAUNCHED` | none | not found | `UNKNOWN` |
| `RESERVED` | none | not found, **and** this same process saw `systemd-run` fail | `START_FAILED` |
| unreadable or malformed record | | any | `UNKNOWN` |

`START_FAILED` is only written by the process that saw the refusal, in the same request. After a crash, absence is never read as "did not run". A Panter crash after the unit was accepted but before the wrapper wrote anything is the `RESERVED`/`LAUNCHED`, no record, unit active row: Panter waits for the wrapper. If the unit then disappears without a record, the action is `UNKNOWN`.

The record is written by the unit, not by Panter, so it survives Panter's own restart during the deploy and Panter's rollback to the previous release, which reads the same `etc/actions/` and closes the action the same way.

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
| 1 | Authority and checks: the ledger (permits, authorizations, actions with the unique slot), the five tools, the `server` field on `panter_mesh_delegate`, claim fencing and revocation hooks, the operator authorization, the preconditions against GitHub with the truth tables above, the `AGENTS.md` sentence. `deploy.commit` stops after `RESERVED` in **dry-run**: it answers what it would launch and frees the slot. Tests with a fake GitHub API covering every row of the tables |
| 2 | Execution: `deploy/run-action.sh`, the `systemd-run` launch, the records, recovery with every row of its table, receipts; tests with a fake `systemd-run`, a fake `systemctl` and a fake `deploy.sh` |
| 3 | On the operator's server, with explicit authorization: enable `deploy.commit`, then the leader delegates the next release's deploy to a worker with a permit, and the result is checked against `/health` |

Phases 1 and 2 share only this document and the record format in `etc/actions/`. Every phase is a pull request with CI green, Codex, an independent review on the exact head commit by the reviewer account, and a squash merge by the leader.
