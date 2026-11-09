# Server actions with single-use permits

**Status:** design. Nothing here is active until the operator sets `PANTER_SERVER_ACTIONS` on the server. With the variable unset every tool below answers `SERVER_ACTIONS_DISABLED` and Panter behaves exactly as before.

## Why

Agents sometimes have to act on the server that runs Panter: deploy a release, later restart a service or read a log. Today that goes through an SSH session with full access to the machine. Full access is the wrong unit of authority: it cannot be scoped, it cannot be taken back once handed over, and it does not say who did what.

This design replaces it with **server actions**: a short, fixed catalog of operations that Panter itself knows how to run. The leader hands a worker a **permit** for one action, Panter checks and runs that action, records it, and the permit is spent. No agent holds SSH, a shell or a credential, and no agent's own code runs on the server.

It follows the pattern Panter already uses for GitHub: the leader attaches a work-scoped grant when it delegates, the worker uses it while its work is live, and the grant ends with the work. It adds **no** coordination rule: delegation, claims, completion, pull requests and merges work as today, and nothing waits for a human. An earlier design that isolated arbitrary code on the server (the closed PR #102) showed how much machinery that takes; server actions avoid the problem by never running anything the catalog does not define.

## The first action: `deploy.commit`

The catalog starts with one action. Others come later, one pull request each.

| Action | Arguments | What Panter runs |
|---|---|---|
| `deploy.commit` | `sha` (40 hex) | the existing `deploy/deploy.sh <sha>`, unchanged, as a transient systemd user unit |

`deploy.sh` already builds and tests the commit in its own release directory, takes a backup with the service stopped, switches `current`, waits for `/health` to report that commit and rolls back by itself if it does not. The action adds the authority around it, not a second deployment procedure.

### Preconditions, checked by Panter before anything runs

1. The permit is valid (see below) and names this `sha`.
2. The commit is on the default branch of `PANTER_SERVER_DEPLOY_REPOSITORY`: GitHub's compare of `sha...main` answers `behind` or `identical`.
3. It is the merge commit of a merged pull request (`commits/<sha>/pulls`, `merge_commit_sha == sha`).
4. The required checks of that repository (`PANTER_SERVER_DEPLOY_CHECKS`, default `test,arm64-image`) have a successful run **on the commit itself**.
5. The independent reviewer (`PANTER_GITHUB_INDEPENDENT_REVIEWER`, the same setting the delivery gate uses) approved that pull request **on its final head commit**, and no later review by that account requests changes.
6. `/health` does not already report this `sha`, `etc/maintenance` does not exist, and no other action is running.

If any check fails, the answer names it and the permit is **not** spent; the worker can fix the cause and try again while the permit lives.

Panter reads GitHub with the token it already has for the delivery gate. The checks repeat on the server what the merge already required, so a permit cannot deploy an unreviewed or red commit even if the leader issued it by mistake.

## Permits

A permit is a row in Panter's own ledger, not a signed token: Panter issues it, checks it and spends it in the same process, so there is no boundary for a signature to cross.

```
{ permitId, missionId, workId, host, action: "deploy.commit", args: { sha },
  issuedBy, issuedAt, expiresAt, state: "ISSUED" | "SPENT" | "REVOKED" | "EXPIRED", actionId? }
```

- **Who issues it.** Only the leader (`PANTER_LEAD_HOST`). It can attach one when it delegates (a new optional `server` field on `panter_mesh_delegate`, next to `github`) or later with `panter_server_grant`. In owner mode the leader does this on its own, as it already does for GitHub grants. The leader may also run an action itself, without a permit, through the same tool; the preconditions still apply.
- **What it allows.** One action, with its arguments fixed: a permit for `deploy.commit` on `abc…` cannot deploy anything else.
- **Who may use it.** Only the worker of that work, while its claim is live: same `attemptId` and `leaseGeneration`, the check `liveWork` already makes for GitHub capabilities.
- **How long.** Until `expiresAt` (default 30 minutes, at most 2 hours), or until the work ends, is withdrawn, is abandoned or its run is closed, whichever comes first. Those are the hooks that already revoke GitHub grants.
- **How many times.** Once. Starting the action spends it, whatever the outcome. A failed deploy needs a new permit.

## Running a deploy without cutting the branch Panter sits on

`panter-ai.service` runs with `KillMode=control-group`, and `deploy.sh` stops and restarts that service. A deploy started as a child of Panter would be killed half way. So Panter never runs `deploy.sh` itself. It starts it as its own transient unit:

```
systemd-run --user --unit=panter-action-<actionId> --collect --property=RuntimeMaxSec=45min \
  --setenv=PANTER_SOURCE_REPO=<configured clone> <base>/current/deploy/run-action.sh deploy.commit <actionId> <sha>
```

`deploy/run-action.sh` is a small wrapper in the repository. It takes a lock, writes `etc/actions/<actionId>.json` with `RUNNING`, runs `deploy.sh <sha>` with its output in `etc/actions/<actionId>.log`, and writes the final record: exit code, live revision from `/health`, and one of `LIVE`, `ROLLED_BACK`, `BUILD_FAILED`, `FAILED`. The unit lives outside Panter's control group, so it survives Panter's own restart.

The fixed argument vector is built by Panter; the only value that comes from the request is the `sha`, already checked to be 40 hex and to pass the preconditions. No shell, no other command, no environment from the request.

**Closing the record.** The new Panter starts after the switch, and so does the old one after a rollback. On start, and every 30 seconds while an action is open, Panter reads `etc/actions/<actionId>.json` and closes the action from it. If the record is still `RUNNING` but the unit is gone (`systemctl --user show` reports no such unit), the action ends as `UNKNOWN` for the operator to look at. Panter never starts the same action again.

## What gets recorded

Every action, in the same ledger as its permit: who issued the permit, which worker used it, the arguments, each precondition and its result, the start, the final state, the exit code, the revision `/health` reported afterwards and the SHA-256 of the log. The worker and the leader both get a receipt in their inbox when it ends. `panter_server_status` shows open and recent actions; the log stays on the server under `etc/actions/`, readable by the operator, not returned to agents beyond its last lines.

## Tools

| Tool | Who | What |
|---|---|---|
| `panter_server_grant { workId, action, args, ttlMinutes? }` | leader | issues a permit for the worker of that work |
| `panter_server_revoke { permitId }` | leader | revokes an unspent permit |
| `panter_server_action { action, args, permitId?, workId?, attemptId?, leaseGeneration? }` | worker with a permit, or the leader | checks the preconditions and starts the action; returns `{ actionId, state }` |
| `panter_server_status { actionId? }` | leader, and a worker for its own actions | open and recent actions and permits |

Their names fall in the `admin` domain, so they are reached through `panter_admin` as `server_grant`, `server_revoke`, `server_action` and `server_status`. The leader's listed surface is full (50), so none is added to it; the worker gets `panter_server_action` listed (31 → 32). Nothing is hidden: every tool stays callable by name and through the router.

## Configuration

In `panter.env`, all optional:

- `PANTER_SERVER_ACTIONS=deploy.commit`: the actions this server allows (comma-separated). Unset: none.
- `PANTER_SERVER_DEPLOY_REPOSITORY=<owner>/<repo>`: the repository whose `main` is deployed.
- `PANTER_SERVER_DEPLOY_SOURCE=<path to the clone>`: what `deploy.sh` needs as `PANTER_SOURCE_REPO`.
- `PANTER_SERVER_DEPLOY_CHECKS=test,arm64-image`.

## What this does not do

- It does not give agents a shell, SSH, or any command outside the catalog.
- It does not deploy anything that is not merged, green and approved on `main`. It does not merge.
- It does not roll back data; `deploy.sh` rolls back code only, as today (`OPERATIONS.md`).
- It does not protect against someone who already controls the server or the operator's GitHub account: they can change `panter.env` or merge whatever they want.
- `deploy.sh` runs `npm ci`, the build and the tests of the commit on the server, as it does today. That is code that passed review and CI on `main`, not arbitrary code; the action does not change that trust.

## Later actions (not part of this work)

Each one is its own pull request with its own preconditions and tests: `service.restart` (only the units named in configuration), `logs.tail` (fixed units, fixed line count, secrets redacted), `backup.now` (the existing `backup.mjs`).

## Phases

| Phase | Deliverable |
|---|---|
| 0 | This design |
| 1 | Permits and checks: the ledger, the four tools, the `server` field on `panter_mesh_delegate`, revocation hooks, the preconditions against GitHub. `deploy.commit` runs in **dry-run** only: it answers what it would run. Tests with a fake GitHub API |
| 2 | Execution: `deploy/run-action.sh`, the `systemd-run` launch, the action records and closing them after a restart, receipts; tests with a fake `systemd-run` and a fake `deploy.sh` |
| 3 | On the operator's server, with explicit authorization: enable `deploy.commit`, then the leader delegates the next release's deploy to a worker with a permit, and the result is checked against `/health` |

Phases 1 and 2 share only this document and the record format in `etc/actions/`. Every phase is a pull request with CI green, Codex, an independent review on the exact head commit by the reviewer account, and a squash merge by the leader.
