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

The grant is a plain `RunnerGrant` that the existing `parseGrant` accepts: `operations: ["test.run"]`, `effectClass: "TEST_EXEC"`, `maxUses: 1`, `paths: ["**"]` (the pilot's spelling for "the whole worktree"; the runner accepts exactly that value for `test.run`). The other `RUNNER_OPERATIONS` stay unused in the pilot.

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

Reply: `{"requestId":"…","operationId":"…","state":"EFFECT_WINDOW"|"SUCCEEDED"|"FAILED"|"OUTCOME_UNKNOWN","result":{…}}`. `result` appears in terminal states:

```json
{"candidateSha":"…","exitCode":1,"passed":603,"failed":1,"startedAt":"…","finishedAt":"…",
 "durationMs":184210,"outputSha256":"…","outputTail":"…","sealed":false,"step":"test.run"}
```

`step` names the step that ended the pipeline (`fetch` for a fetch failure, and so on). `sealed` is `false` in the pilot: the journal is hash-chained locally, not yet sealed outside. Everything in `result` except `candidateSha` is what the executor reported.

Messages are capped at `RUNNER_MESSAGE_MAX_BYTES` (16 KiB) on the way in; a status reply may be larger because of `outputTail`.

## Protocol: runner to executor

Same framing, on the executor's socket. The runner sends one job per operation, after reserving the grant and journaling `INTENT`, and the executor answers `ACCEPTED` or `BUSY` before running anything:

```json
{"version":1,"requestId":"…","job":{"operationId":"…","repository":"owner/repo","url":"https://…",
 "candidateSha":"<40 hex>","limits":{"fetchSec":300,"installSec":600,"testSec":900,"cleanupSec":60}}}
```

While it runs, the executor sends one line per step: `{"operationId":"…","event":"STEP_STARTED"|"STEP_FINISHED","step":"fetch"|"install"|"test"|"cleanup","exitCode":…,"durationMs":…}`, then one `{"operationId":"…","event":"RESULT","result":{…}}` with the result above minus `sealed`. The runner journals each event as it arrives, so a crash on either side leaves a record of how far the pipeline got. If the connection to the executor drops before `RESULT`, the runner marks the operation `OUTCOME_UNKNOWN`. The executor runs one job at a time and holds no state across jobs: on start it removes any work directory left under `work/` and keeps nothing from it.

The repository allowlist lives on the **runner** (`PANTER_RUNNER_REPOSITORIES`): the executor only ever receives a URL the runner resolved from it.

## State and recovery

The runner reuses the libraries that already exist: `RunnerGrantLedger` (one reservation per request), `RunnerOutcomeLedger` (`INTENT → EFFECT_WINDOW → SUCCEEDED | FAILED`), `RunnerAuditJournal` (typed, hash-chained events: `RESERVED`, `STEP_STARTED`, `STEP_FINISHED`, `TERMINAL`, each with the operation, the step and the exit code, nothing else). All of it lives under `PANTER_RUNNER_ROOT`, opened through one private root as `RUNNER_FENCED_ADMISSION.md` requires.

- **Reservation before effect.** The order is: verify the grant, reserve it, journal `INTENT`, then hand the job to the executor. If the executor refuses or is unreachable, the reservation is rolled back inside the same transaction and the reply is `DENIED: EXECUTOR_UNAVAILABLE` or `BUSY`.
- **One pipeline at a time.** A second request while one runs is answered `DENIED: BUSY`. Panter reports that to the caller; there is no queue in the pilot.
- **Crash or restart in the middle.** On start, the runner marks every `EFFECT_WINDOW` operation `OUTCOME_UNKNOWN` and never re-runs it; the grant is already spent, so the same grant cannot start it again. The executor, on start, removes whatever is left under `work/`; the output files it already wrote stay under `results/` for the operator.
- **Timeouts.** A step past its limit kills its whole process group; the executor reports `FAILED` with `step` set and `exitCode: null`, and still runs `cleanup`.
- **No secrets in the journal.** As today, events are typed fields only: no command output, no environment, no paths outside the runner root.

## Panter side

Two tools, in the `admin` domain so the leader's listed surface stays at 50 (they are reached through `panter_admin` with operations `runner_test` and `runner_status`; `panter_runner_test` is also listed for workers, who have room for one more):

- `panter_runner_test { repository, candidateSha, workId? }`. Issues the grant and starts the pipeline. A **worker** may only pass its own `RUNNING` work (same `attemptId` and `leaseGeneration`); the grant binds to that attempt. The **leader** may pass any work of a mission it leads, or none: Panter then mints a synthetic attempt for the grant. Returns `{ operationId, state }` or `{ state: "RUNNER_DISABLED" }` when `PANTER_RUNNER_SOCKET` is unset.
- `panter_runner_status { operationId }`. Proxies the runner's state. When the state is terminal, Panter stores the result as a **runner receipt** (operationId, mission, work, attempt, repository, commit, passed, failed, exit code, output SHA-256, `sealed`) in its own ledger, so the leader, reviewers and later the delivery gate can read it. The receipt is reported evidence from the operator's own runner, not a Panter-RDD signature and not an official Gentle AI Go attestation.

Repositories the runner accepts come from `PANTER_RUNNER_REPOSITORIES` on the **runner** side (`owner/repo=https://github.com/owner/repo.git`, comma-separated); tests use `file://` paths. Panter does not need its own allowlist: a grant for another repository is refused by the runner.

What the pilot does not protect against, stated plainly: the candidate's `npm ci` runs that commit's lifecycle scripts and its tests run with network access, both as `panter-build`; a malicious commit can misreport its own result, exhaust the executor's quota until systemd kills it, or make outbound requests. Socket access is enforced by filesystem permissions, not by kernel peer credentials, until `RUNNER_CROSS_UID_IPC.md` is applied. The journal is not sealed outside the server until `RUNNER_SEAL_WORKER.md` is applied.

No automatic call. Nothing in the harness, the delivery gate or `panter_mesh_complete` requires a runner receipt. A later phase may let the gate prefer a receipt over a worker's claim; that is a separate decision.

## Configuration

Panter (`panter.env`): `PANTER_RUNNER_SOCKET=/run/panter-runner/runner.sock`, `PANTER_RUNNER_SIGNING_KEY_FILE=/home/<user>/panter-ai/etc/runner-signing.pem` (Ed25519 private key, mode 0600), `PANTER_RUNNER_KEY_ID=<name>`.

Runner (its own environment file, readable only by `panter-runner`): `PANTER_RUNNER_ROOT=/var/lib/panter-runner`, `PANTER_RUNNER_SOCKET`, `PANTER_RUNNER_EXECUTOR_SOCKET=/run/panter-build/build.sock`, `PANTER_RUNNER_PINNED_KEYS_FILE=/etc/panter-runner/pinned-keys.json`, `PANTER_RUNNER_REPOSITORIES`, `PANTER_RUNNER_TEST_TIMEOUT_SEC=900`.

Executor (its own environment file, readable only by `panter-build`): `PANTER_BUILD_ROOT=/var/lib/panter-build`, `PANTER_BUILD_SOCKET=/run/panter-build/build.sock`.

None of these files is in the repository. `deploy/runner-install.sh` creates the two users, the two groups, the directories, the key pair and the three files from templates, and installs both units **disabled**.

## Acceptance

The pilot is done when all three hold:

1. On the operator's server, `panter_runner_test` on a commit of this repository returns the same pass/fail count as the CI run for that commit.
2. Tests prove the refusals: a replayed grant, an expired grant, a grant for another repository or commit or with other operations or paths, an intent whose work does not match the grant, a second pipeline while one runs, an executor that is down (no reservation left behind), a step past its limit (the group is killed and cleanup still runs), a dropped executor connection (`OUTCOME_UNKNOWN`) and a restart during `EFFECT_WINDOW` (becomes `OUTCOME_UNKNOWN`, nothing re-runs).
3. With `PANTER_RUNNER_SOCKET` unset, `npm test` and the full tool surface are unchanged, and Panter in production behaves exactly as before the pilot.

## Phases

| Phase | Deliverable | Pull request |
|---|---|---|
| 0 | This design | `docs/RUNNER_PILOT.md` |
| 1 | The executor (`panter-build`): its socket, the pipeline with limits and group kill, output capture, step events and result, cleanup on start; tests against a local fixture repository (no network) | `src/runner/executor/`, `tests/runner-executor-*.test.ts`, `npm run start:executor` |
| 2 | The runner (`panter-runner`): its socket, grant check, reservation, journal and outcomes, the executor client, recovery on start; tests with a fake executor | `src/runner/`, `tests/runner-pilot-*.test.ts`, `npm run start:runner` |
| 3 | The Panter side: grant issuer, the two tools, runner receipts, configuration, `TOOL_SURFACE.md`; tests with a fake runner socket | `src/core/runner-grant-issuer.ts`, `src/core/runner-client.ts`, tool registration |
| 4 | Deployment: hardened `panter-runner.service` and `panter-build.service`, `deploy/runner-install.sh`, templates, `SELF_HOSTING.md` and `OPERATIONS.md` sections, `scripts/smoke-runner.mjs` | `deploy/`, `scripts/` |
| 5 | Pilot on the operator's server with explicit authorization, comparison with CI, release | CHANGELOG, README line |

Phases 1, 2 and 3 share only this document and the message types in `src/core/runner-protocol.ts`, so they can run in parallel. Phase 4 needs phases 1 and 2 merged. Every phase is a pull request with CI green, Codex when available, an independent review on the exact head commit by the reviewer account, and a squash merge by the leader.
