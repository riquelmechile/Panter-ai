# Runner pilot: the runner runs the tests

**Status:** design accepted, implementation in phases (see the end). Nothing in this document is active in a deployment until the operator sets `PANTER_RUNNER_SOCKET` on the Panter side and installs `panter-runner` as a separate user. With the variable unset, Panter behaves exactly as before.

## Why

Today a worker (Grok, GPT, Gemini) does its work in its own environment and delivers through a pull request. What its tests reported is a claim; the CI of the repository is the only independent check. The runner gives the control plane a second one: it can run the tests of an exact commit **inside the operator's server, without giving anyone the server**.

The isolated runner designed in `RUNNER_IMPLEMENTATION.md` and its follow-ups (grants, anti-replay, journal, outcomes, quarantine, writer fence) has its guarantees implemented and tested, but nothing executes. This pilot adds the smallest executor that is useful: one operation, one pipeline, one result.

The pilot does **not** add coordination rules. Delegation, claims, completion, pull requests and merges work as today. The runner is one more tool, never a required step, and it never blocks a merge.

## What the pilot does

One pipeline for a repository and an exact commit. In the pilot it is what the grant operation `test.run` means: one granted operation, four internal steps.

| Step | Command | Limit |
|---|---|---|
| `fetch` | `git clone --no-checkout --filter=blob:none <url> <dir>`, `git fetch origin <sha>`, `git checkout --detach <sha>`, verify `git rev-parse HEAD` equals `<sha>` | 5 min |
| `install` | `npm ci --no-audit --no-fund` | 10 min |
| `test` | `npm test` | 15 min (`PANTER_RUNNER_TEST_TIMEOUT_SEC`) |
| `cleanup` | remove the work directory, keep the output file | 1 min |

The grant is a plain `RunnerGrant` that the existing `parseGrant` accepts: `operations: ["test.run"]`, `effectClass: "TEST_EXEC"`, `maxUses: 1`, `paths: ["**"]` (the pilot's spelling for "the whole worktree"; the runner accepts exactly that value for `test.run`), `expiresAt = notBefore + 40 min`. That expiry is also the **effect deadline**: the executor kills everything still running at that instant, whatever the per-step limits say, and the durable outcome closes only after it (see "State and recovery"). The other `RUNNER_OPERATIONS` stay unused in the pilot.

The result is a small, structured record: exit code, how many tests passed and failed (parsed from the Node test reporter lines `# pass N` and `# fail N`), timing, the exact commit, the SHA-256 of the full output and the last 32 KiB of output. Nothing else leaves the runner.

Out of scope for the pilot, planned for later phases: writing files, deploying, free commands, sealing the journal in Cloudflare R2 (`RUNNER_SEAL_WORKER.md`), a sandbox without network (`npm ci` needs the registry), kernel peer credentials on the socket (`RUNNER_CROSS_UID_IPC.md`), reclaim after a crash (`RUNNER_FENCED_ADMISSION.md`).

## Three processes, three users, one authority

```
Panter (user <panter>)            panter-runner (user panter-runner)        panter-build (user panter-build)
┌────────────────────────┐ AF_UNIX ┌─────────────────────────────────┐ AF_UNIX ┌────────────────────────────┐
│ panter_runner_test     │ ──────▶ │ verify grant (pinned public key)│ ──────▶ │ fetch, npm ci, npm test    │
│  issues a signed grant │  JSON   │ reserve once (anti-replay)      │  JSON   │ own process group per step │
│  for ONE pipeline      │ ◀────── │ journal INTENT → EFFECT_WINDOW  │ ◀────── │ kill the group on time     │
│ panter_runner_status   │         │ journal steps as reported       │         │ writes only its work dir   │
│  stores the receipt    │         │ journal SUCCEEDED / FAILED      │         │ reports steps and result   │
└────────────────────────┘         └─────────────────────────────────┘         └────────────────────────────┘
```

The candidate's code (its `npm` lifecycle scripts, its tests) runs **only** in `panter-build`, a user that owns nothing but work directories. `panter-runner` keeps the grant ledger, the outcome ledger and the journal and never spawns candidate code. A malicious commit can therefore wreck its own work directory and lie about its results, which is the same trust a worker's claim has today; it cannot touch a ledger, the journal or a socket, because those belong to another user with mode `0700`. The runner records every step and result **as reported by the executor**.

The executor also holds its own Ed25519 key. It signs each result as an `OutcomeClaim` (`panter.outcome-reconciliation/v1`, with the SHA-256 of the output file as `evidenceDigest`), and the runner pins its public key. That makes the executor the **independent observer** that `RUNNER_OUTCOMES.md` requires to close an outcome: a different user, a different key, a different process from the one that opened the effect window.

- **The signature is the authorization.** Panter signs each grant with an Ed25519 private key only Panter can read (`PANTER_RUNNER_SIGNING_KEY_FILE`). The runner pins the public key (`PANTER_RUNNER_PINNED_KEYS_FILE`, JSON `keyId → PEM`) and verifies with the existing `verifyRunnerGrant`. A grant is valid for one pipeline (`maxUses: 1`), for one repository and commit, for 20 minutes. Replays are refused by `RunnerGrantLedger`.
- **Two more Linux users.** `panter-runner` owns `/var/lib/panter-runner` (ledgers, journal) and `panter-build` owns `/var/lib/panter-build` (work directories, npm cache, output files), both `0700`. Neither can read `panter.env`, the Panter data directory or any token, and neither needs one: the pilot clones public repositories over HTTPS.
- **Sockets are defence in depth.** `/run/panter-runner/` is `0710 panter-runner:panter-ipc` and only the Panter user is in `panter-ipc`; `/run/panter-build/` is `0710 panter-build:panter-build-ipc` and only `panter-runner` is in `panter-build-ipc`. Sockets are `0660`. Without a valid grant, connecting to the runner achieves nothing; the executor accepts a job only from its socket, which only the runner can reach.
- **systemd is the sandbox of the pilot.** Both services run with `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome=yes`, `PrivateTmp`, `PrivateDevices`, `ReadWritePaths` limited to their own state and runtime directories, `MemoryMax`, `TasksMax`, `CPUQuota`. Each pipeline step runs in its own process group and is killed as a group when it passes its limit.
- **Scrubbed environment.** A step sees only `PATH`, `HOME` (the work directory), `LANG`, `CI=1` and `npm_config_cache` (a cache under `/var/lib/panter-build`). Nothing from the executor's own environment is inherited.

## Protocol: Panter to runner

JSON, one object per line, over the socket. Every message carries `version: 1` and a `requestId` (UUID) that the reply echoes.

**Start a pipeline**

```json
{"version":1,"requestId":"…","grant":{"keyId":"…","claims":{…RunnerGrant…},"signature":"…"},
 "intent":{"version":1,"requestId":"…","operation":"test.run","repository":"owner/repo",
           "candidateSha":"<40 hex>","workId":"…","attemptId":"…","arguments":{}}}
```

Reply: `{"requestId":"…","operationId":"…","state":"EFFECT_WINDOW"}` or `{"requestId":"…","state":"DENIED","reason":"GRANT_REJECTED"|"BUSY"|"REPOSITORY_NOT_ALLOWED"|"INVALID_INTENT"|"EXECUTOR_UNAVAILABLE"}`. The runner answers before anything runs. The grant and the intent must agree on repository, commit, work and attempt; the grant must be exactly the pilot grant described above. `EXECUTOR_UNAVAILABLE` means the runner could not hand the job to `panter-build`; the grant is then **not** reserved, so the same grant may be retried.

**Ask for the state**

```json
{"version":1,"requestId":"…","status":{"operationId":"…"}}
```

Reply: `{"requestId":"…","operationId":"…","state":"EFFECT_WINDOW"|"REPORTED"|"SUCCEEDED"|"FAILED"|"OUTCOME_UNKNOWN","result":{…},"observation":{…}}`. `REPORTED` is the pilot's fast answer: the executor finished and sent its signed result, but the effect deadline has not passed, so the durable outcome is still `EFFECT_WINDOW`. `SUCCEEDED`, `FAILED` and `OUTCOME_UNKNOWN` are the durable states after reconciliation. `result` appears from `REPORTED` on; `observation` is the executor's signed claim (`keyId`, `claim`, `signature`) as stored:

```json
{"candidateSha":"…","exitCode":1,"passed":603,"failed":1,"startedAt":"…","finishedAt":"…",
 "durationMs":184210,"outputSha256":"…","outputTail":"…","sealed":false,"step":"test.run"}
```

`step` names the step that ended the pipeline (`fetch` for a fetch failure, and so on). `sealed` is `false` in the pilot: the journal is hash-chained locally, not yet sealed outside. Everything in `result` except `candidateSha` is what the executor reported, and `exitCode`, `passed` and `failed` are parsed by the executor from a process it ran: they say how the candidate's own test command ended, nothing more.

Messages are capped at `RUNNER_MESSAGE_MAX_BYTES` (16 KiB) on the way in; a status reply may be larger because of `outputTail`.

## Protocol: runner to executor

Same framing, on the executor's socket. The runner sends one job per operation, after reserving the grant and journaling `INTENT`, and the executor answers `ACCEPTED` or `BUSY` before running anything:

```json
{"version":1,"requestId":"…","job":{"operationId":"…","repository":"owner/repo","url":"https://…",
 "candidateSha":"<40 hex>","limits":{"fetchSec":300,"installSec":600,"testSec":900,"cleanupSec":60}}}
```

The job also carries `deadline` (the grant's `expiresAt`, epoch milliseconds) and `intentDigest` (the runner's `OutcomeIntent` digest, so the executor's claim binds to the same intent).

While it runs, the executor sends one line per step: `{"operationId":"…","event":"STEP_STARTED"|"STEP_FINISHED","step":"fetch"|"install"|"test"|"cleanup","exitCode":…,"durationMs":…}`, then one `{"operationId":"…","event":"RESULT","result":{…},"observation":{"keyId":"…","claim":{…OutcomeClaim…},"signature":"…"}}` with the result above minus `sealed`. The runner stores each event as it arrives, so a crash on either side leaves a record of how far the pipeline got. If the connection drops before `RESULT`, the runner keeps the operation in `EFFECT_WINDOW` until the deadline and then reconciles as described below.

The executor writes `results/<operationId>/output.log` and `result.json` (the result plus the claim it signed) before it answers `RESULT`, and keeps them. A second request, `{"version":1,"requestId":"…","observe":{"operationId":"…"}}`, makes it re-read `result.json`, check that `output.log` still hashes to `evidenceDigest`, and answer a **fresh** signed claim with `observedAt` = now, or `NOT_OBSERVED` when there is no complete result. The executor runs one job at a time and holds no state across jobs other than `results/`: on start it removes anything left under `work/`.

The repository allowlist lives on the **runner** (`PANTER_RUNNER_REPOSITORIES`): the executor only ever receives a URL the runner resolved from it.

## State and recovery

The runner reuses the libraries that already exist, unchanged except for one method named below: `RunnerGrantLedger` (one reservation per request), `RunnerOutcomeLedger` (`prepare → enterEffectWindow → reconcile`, with its epoch fencing), `RunnerAuditJournal` (hash-chained events with the existing vocabulary `RESERVED | DENIED | SUCCEEDED | FAILED | QUARANTINED` and the existing fixed fields). All of it lives under `PANTER_RUNNER_ROOT`, opened through one private root as `RUNNER_FENCED_ADMISSION.md` requires. Step progress and the executor's reports go to a separate fixed-field SQLite table of the runner (`pipeline_events`: operation, step, started, finished, exit code, claim digest), which is **not** hash-chained and is not the journal.

- **Reservation before effect.** The order is: verify the grant, ask the executor `{"probe":{}}` (it answers `READY` or `BUSY` and runs nothing), then reserve the grant, `prepare` the outcome intent, journal `RESERVED`, send the job and, once the executor answers `ACCEPTED`, `enterEffectWindow` with the grant's `expiresAt` as the deadline. The runner is the executor's only client and admits one pipeline at a time, so a `READY` probe cannot be overtaken. If the probe fails, nothing is reserved and the reply is `DENIED: BUSY` or `DENIED: EXECUTOR_UNAVAILABLE`; the same grant may be retried. Neither ledger can release a reservation, so if the job itself is refused or lost **after** the reservation, the grant is spent, the journal gets `DENIED`, the intent stays `INTENT` (the ledger turns it unknown at the next writer epoch, by its own rule) and Panter must issue a new grant.
- **One pipeline at a time.** A second request while one runs is answered `DENIED: BUSY`. Panter reports that to the caller; there is no queue in the pilot.
- **Closing an outcome.** The executor's `RESULT` only moves the pilot state to `REPORTED`; the durable outcome stays `EFFECT_WINDOW`. Once the deadline has passed, the runner asks the executor to `observe` the operation and calls `reconcile` with that fresh signed claim, which the existing contract accepts (independent key, `observedAt` and wall clock both past the deadline, idempotent). The journal then gets `SUCCEEDED` or `FAILED` with `evidenceDigest` as `outputDigest`. If the executor answers `NOT_OBSERVED` or is gone, the runner calls the one new ledger method, `expireUnobserved(operationId)`: it moves an `EFFECT_WINDOW` of the current writer epoch to `OUTCOME_UNKNOWN` only when its deadline has passed, the same transition `reconcile` already makes as its first step and the ledger already makes for old epochs when it opens. It closes nothing as success or failure. The journal then gets `QUARANTINED`. Nothing is ever re-run.
- **Crash or restart in the middle.** On start, the runner does not touch a live `EFFECT_WINDOW`: it waits for its deadline and then reconciles as above. A pending `INTENT` of an old epoch becomes unknown by the ledger's own rule. The executor, on start, removes whatever is left under `work/` and keeps `results/`.
- **Timeouts.** A step past its limit, or anything still running at the deadline, is killed as a whole process group; the executor reports `FAILED` with `step` set and `exitCode: null`, and still runs `cleanup`.
- **No secrets in the journal.** As today, events are typed fields only: no command output, no environment, no paths outside the runner root.

## Panter side

Two tools, in the `admin` domain so the leader's listed surface stays at 50 (they are reached through `panter_admin` with operations `runner_test` and `runner_status`; `panter_runner_test` is also listed for workers, who have room for one more):

- `panter_runner_test { repository, candidateSha, workId? }`. Issues the grant and starts the pipeline. A **worker** may only pass its own `RUNNING` work (same `attemptId` and `leaseGeneration`); the grant binds to that attempt. The **leader** may pass any work of a mission it leads, or none: Panter then mints a synthetic attempt for the grant. Returns `{ operationId, state }` or `{ state: "RUNNER_DISABLED" }` when `PANTER_RUNNER_SOCKET` is unset.
- `panter_runner_status { operationId }`. Proxies the runner's state. From `REPORTED` on, Panter stores the result as a **runner receipt** (operationId, mission, work, attempt, repository, commit, passed, failed, exit code, output SHA-256, `sealed`, the executor's claim digest, and `durable: false`), and updates it to `durable: true` with the final state once the runner reports `SUCCEEDED`, `FAILED` or `OUTCOME_UNKNOWN`. The leader, reviewers and later the delivery gate can read receipts. A receipt is reported evidence from the operator's own executor, not a Panter-RDD signature and not an official Gentle AI Go attestation.

Repositories the runner accepts come from `PANTER_RUNNER_REPOSITORIES` on the **runner** side (`owner/repo=https://github.com/owner/repo.git`, comma-separated); tests use `file://` paths. Panter does not need its own allowlist: a grant for another repository is refused by the runner.

What the pilot does not protect against, stated plainly. The candidate commit is **arbitrary untrusted code**: `npm ci` runs its lifecycle scripts and those of its dependency graph, and `npm test` runs whatever it says, as `panter-build`, with outbound network access and reach into the local network, including the cloud instance-metadata service unless the host firewall blocks that user (phase 4 installs an optional egress rule for the `panter-build` UID that rejects link-local addresses; without it, treat metadata access as possible). Such code can misreport its own result, burn CPU and memory until systemd kills the group, and fill the executor's disk: the executor caps `output.log` at 64 MiB (truncating and flagging it in the result) and kills the job when its work directory passes 4 GiB, and `/var/lib/panter-build` should sit on its own filesystem or quota. Socket access is enforced by filesystem permissions, not by kernel peer credentials, until `RUNNER_CROSS_UID_IPC.md` is applied. The journal is not sealed outside the server until `RUNNER_SEAL_WORKER.md` is applied.

No automatic call. Nothing in the harness, the delivery gate or `panter_mesh_complete` requires a runner receipt. A later phase may let the gate prefer a receipt over a worker's claim; that is a separate decision.

## Configuration

Panter (`panter.env`): `PANTER_RUNNER_SOCKET=/run/panter-runner/runner.sock`, `PANTER_RUNNER_SIGNING_KEY_FILE=/home/<user>/panter-ai/etc/runner-signing.pem` (Ed25519 private key, mode 0600), `PANTER_RUNNER_KEY_ID=<name>`.

Runner (its own environment file, readable only by `panter-runner`): `PANTER_RUNNER_ROOT=/var/lib/panter-runner`, `PANTER_RUNNER_SOCKET`, `PANTER_RUNNER_EXECUTOR_SOCKET=/run/panter-build/build.sock`, `PANTER_RUNNER_PINNED_KEYS_FILE=/etc/panter-runner/pinned-keys.json` (Panter's grant key), `PANTER_RUNNER_EXECUTOR_KEYS_FILE=/etc/panter-runner/executor-keys.json` (the executor's observation key), `PANTER_RUNNER_REPOSITORIES`, `PANTER_RUNNER_TEST_TIMEOUT_SEC=900`.

Executor (its own environment file, readable only by `panter-build`): `PANTER_BUILD_ROOT=/var/lib/panter-build`, `PANTER_BUILD_SOCKET=/run/panter-build/build.sock`, `PANTER_BUILD_SIGNING_KEY_FILE=/etc/panter-build/observer.pem` (Ed25519 private key, mode 0400, owner `panter-build`), `PANTER_BUILD_KEY_ID`.

None of these files is in the repository. `deploy/runner-install.sh` creates the two users, the two groups, the directories, the two key pairs and the three files from templates, and installs both units **disabled**.

## Acceptance

The pilot is done when all three hold:

1. On the operator's server, `panter_runner_test` on a commit of this repository returns the same pass/fail count as the CI run for that commit.
2. Tests prove the refusals: a replayed grant, an expired grant, a grant for another repository or commit or with other operations or paths, an intent whose work does not match the grant, a second pipeline while one runs, an executor that is down (no reservation left behind), a step past its limit (the group is killed and cleanup still runs), a result signed with the wrong key (stays `EFFECT_WINDOW`, never `REPORTED`), a dropped executor connection followed by the deadline (`OUTCOME_UNKNOWN` when the executor cannot observe), a reconciliation attempted before the deadline (refused by the ledger), and a restart during `EFFECT_WINDOW` (the window stays live until its deadline; nothing re-runs).
3. With `PANTER_RUNNER_SOCKET` unset, `npm test` and the full tool surface are unchanged, and Panter in production behaves exactly as before the pilot.

## Phases

| Phase | Deliverable | Pull request |
|---|---|---|
| 0 | This design | `docs/RUNNER_PILOT.md` |
| 1 | The executor (`panter-build`): its socket, the pipeline with limits, deadline and group kill, output capture and caps, signed result and `observe`, cleanup on start; tests against a local fixture repository (no network) | `src/runner/executor/`, `tests/runner-executor-*.test.ts`, `npm run start:executor` |
| 2 | The runner (`panter-runner`): its socket, grant check, probe, reservation and intent, journal, executor client, `REPORTED`, reconciliation after the deadline, `RunnerOutcomeLedger.expireUnobserved`, behaviour on restart; tests with a fake executor | `src/runner/`, `tests/runner-pilot-*.test.ts`, `npm run start:runner` |
| 3 | The Panter side: grant issuer, the two tools, runner receipts, configuration, `TOOL_SURFACE.md`; tests with a fake runner socket | `src/core/runner-grant-issuer.ts`, `src/core/runner-client.ts`, tool registration |
| 4 | Deployment: hardened `panter-runner.service` and `panter-build.service`, `deploy/runner-install.sh` (users, groups, two key pairs, optional egress rule), templates, `SELF_HOSTING.md` and `OPERATIONS.md` sections, `scripts/smoke-runner.mjs` | `deploy/`, `scripts/` |
| 5 | Pilot on the operator's server with explicit authorization, comparison with CI, release | CHANGELOG, README line |

Phases 1, 2 and 3 share only this document and the message types in `src/core/runner-protocol.ts`, so they can run in parallel. Phase 4 needs phases 1 and 2 merged. Every phase is a pull request with CI green, Codex when available, an independent review on the exact head commit by the reviewer account, and a squash merge by the leader.
