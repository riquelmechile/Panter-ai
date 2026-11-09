# Runner pilot: the runner runs the tests

**Status:** design accepted, implementation in phases (see the end). Nothing in this document is active in a deployment until the operator sets `PANTER_RUNNER_SOCKET` on the Panter side and installs `panter-runner` as a separate user. With the variable unset, Panter behaves exactly as before.

## Why

Today a worker (Grok, GPT, Gemini) does its work in its own environment and delivers through a pull request. What its tests reported is a claim; the CI of the repository is the only independent check. The runner gives the control plane a second one: it can run the tests of an exact commit **inside the operator's server, without giving anyone the server**.

The isolated runner designed in `RUNNER_IMPLEMENTATION.md` and its follow-ups (grants, anti-replay, journal, outcomes, quarantine, writer fence) has its guarantees implemented and tested, but nothing executes. This pilot adds the smallest executor that is useful: one operation, one pipeline, one result.

The pilot does **not** add coordination rules. Delegation, claims, completion, pull requests and merges work as today. The runner is one more tool, never a required step, and it never blocks a merge.

## What the pilot does

One pipeline for a repository and an exact commit:

| Step | Grant operation | Command | Limit |
|---|---|---|---|
| Fetch the commit | `workspace.prepare` | `git clone --no-checkout --filter=blob:none <url> <dir>`, `git fetch origin <sha>`, `git checkout --detach <sha>`, verify `git rev-parse HEAD` equals `<sha>` | 5 min |
| Install | `build.install` | `npm ci --no-audit --no-fund` | 10 min |
| Test | `test.run` | `npm test` | 15 min (`PANTER_RUNNER_TEST_TIMEOUT_SEC`) |
| Clean up | `workspace.cleanup` | remove the work directory, keep the output file | 1 min |

The result is a small, structured record: exit code, how many tests passed and failed (parsed from the Node test reporter lines `# pass N` and `# fail N`), timing, the exact commit, the SHA-256 of the full output and the last 32 KiB of output. Nothing else leaves the runner.

Out of scope for the pilot, planned for later phases: writing files, deploying, free commands, sealing the journal in Cloudflare R2 (`RUNNER_SEAL_WORKER.md`), a sandbox without network (`npm ci` needs the registry), kernel peer credentials on the socket (`RUNNER_CROSS_UID_IPC.md`), reclaim after a crash (`RUNNER_FENCED_ADMISSION.md`).

## Two processes, one authority

```
Panter (user zana)                         panter-runner (user panter-runner)
┌──────────────────────────┐   AF_UNIX    ┌──────────────────────────────────┐
│ panter_runner_test       │ ───────────▶ │ verify grant (pinned public key) │
│  issues a signed grant   │   JSON lines │ reserve once (anti-replay)       │
│  for ONE pipeline        │ ◀─────────── │ journal INTENT → EFFECT_WINDOW   │
│ panter_runner_status     │              │ run the pipeline, kill on time   │
│  stores the receipt      │              │ journal SUCCEEDED / FAILED       │
└──────────────────────────┘              └──────────────────────────────────┘
```

- **The signature is the authorization.** Panter signs each grant with an Ed25519 private key only Panter can read (`PANTER_RUNNER_SIGNING_KEY_FILE`). The runner pins the public key (`PANTER_RUNNER_PINNED_KEYS_FILE`, JSON `keyId → PEM`) and verifies with the existing `verifyRunnerGrant`. A grant is valid for one pipeline (`maxUses: 1`), for one repository and commit, for 20 minutes. Replays are refused by `RunnerGrantLedger`.
- **Different Linux user.** The runner runs as `panter-runner`, with its own home and data under `/var/lib/panter-runner`. It cannot read `panter.env`, the Panter data directory or any token. It needs none: the pilot clones public repositories over HTTPS.
- **The socket is defence in depth.** `/run/panter-runner/` is `0710 panter-runner:panter-ipc`, the socket `0660`; only members of `panter-ipc` (the Panter user) can connect. Without a valid grant, connecting achieves nothing.
- **systemd is the sandbox of the pilot.** `panter-runner.service` runs with `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome=yes`, `PrivateTmp`, `ReadWritePaths=/var/lib/panter-runner /run/panter-runner`, `MemoryMax`, `TasksMax`, `CPUQuota`. The pipeline children run in their own process group and are killed as a group when a step passes its limit.
- **Scrubbed environment.** A child sees only `PATH`, `HOME` (the work directory), `LANG`, `CI=1` and `npm_config_cache` (a cache under the runner root). Nothing from the runner's own environment is inherited.

## Protocol

JSON, one object per line, over the socket. Every message carries `version: 1` and a `requestId` (UUID) that the reply echoes.

**Start a pipeline**

```json
{"version":1,"requestId":"…","grant":{"keyId":"…","claims":{…RunnerGrant…},"signature":"…"},
 "intent":{"version":1,"requestId":"…","operation":"test.run","repository":"owner/repo",
           "candidateSha":"<40 hex>","workId":"…","attemptId":"…","arguments":{}}}
```

Reply: `{"requestId":"…","operationId":"…","state":"EFFECT_WINDOW"}` or `{"requestId":"…","state":"DENIED","reason":"GRANT_REJECTED"|"BUSY"|"REPOSITORY_NOT_ALLOWED"|"INVALID_INTENT"}`. The runner answers before running anything. The grant and the intent must agree on repository, commit, work and attempt, and the grant's `operations` must contain the four pipeline operations with `effectClass: "TEST_EXEC"`.

**Ask for the state**

```json
{"version":1,"requestId":"…","status":{"operationId":"…"}}
```

Reply: `{"requestId":"…","operationId":"…","state":"EFFECT_WINDOW"|"SUCCEEDED"|"FAILED"|"OUTCOME_UNKNOWN","result":{…}}`. `result` appears in terminal states:

```json
{"candidateSha":"…","exitCode":1,"passed":603,"failed":1,"startedAt":"…","finishedAt":"…",
 "durationMs":184210,"outputSha256":"…","outputTail":"…","sealed":false,"step":"test.run"}
```

`step` names the step that ended the pipeline (`workspace.prepare` for a fetch failure, and so on). `sealed` is `false` in the pilot: the journal is hash-chained locally, not yet sealed outside.

Messages are capped at `RUNNER_MESSAGE_MAX_BYTES` (16 KiB) on the way in; a status reply may be larger because of `outputTail`.

## State and recovery

The runner reuses the libraries that already exist: `RunnerGrantLedger` (one reservation per request), `RunnerOutcomeLedger` (`INTENT → EFFECT_WINDOW → SUCCEEDED | FAILED`), `RunnerAuditJournal` (typed, hash-chained events: `RESERVED`, `STEP_STARTED`, `STEP_FINISHED`, `TERMINAL`). All of it lives under `PANTER_RUNNER_ROOT`, opened through one private root as `RUNNER_FENCED_ADMISSION.md` requires.

- **One pipeline at a time.** A second request while one runs is answered `DENIED: BUSY`. Panter reports that to the caller; there is no queue in the pilot.
- **Crash or restart in the middle.** On start, the runner marks every `EFFECT_WINDOW` operation `OUTCOME_UNKNOWN` and never re-runs it. Its work directory is kept under `quarantine/` for the operator to inspect and remove; the runner does not delete it. The grant is already spent, so the same grant cannot start it again.
- **Timeouts.** A step past its limit kills the whole process group, records `FAILED` with `step` set and `exitCode: null`, and still runs the cleanup step.
- **No secrets in the journal.** As today, events are typed fields only: no command output, no environment, no paths outside the runner root.

## Panter side

Two tools, in the `admin` domain so the leader's listed surface stays at 50 (they are reached through `panter_admin` with operations `runner_test` and `runner_status`; `panter_runner_test` is also listed for workers, who have room for one more):

- `panter_runner_test { repository, candidateSha, workId? }`. Issues the grant and starts the pipeline. A **worker** may only pass its own `RUNNING` work (same `attemptId` and `leaseGeneration`); the grant binds to that attempt. The **leader** may pass any work of a mission it leads, or none: Panter then mints a synthetic attempt for the grant. Returns `{ operationId, state }` or `{ state: "RUNNER_DISABLED" }` when `PANTER_RUNNER_SOCKET` is unset.
- `panter_runner_status { operationId }`. Proxies the runner's state. When the state is terminal, Panter stores the result as a **runner receipt** (operationId, mission, work, attempt, repository, commit, passed, failed, exit code, output SHA-256, `sealed`) in its own ledger, so the leader, reviewers and later the delivery gate can read it. The receipt is reported evidence from the operator's own runner, not a Panter-RDD signature and not an official Gentle AI Go attestation.

Repositories the runner accepts come from `PANTER_RUNNER_REPOSITORIES` on the **runner** side (`owner/repo=https://github.com/owner/repo.git`, comma-separated); tests use `file://` paths. Panter does not need its own allowlist: a grant for another repository is refused by the runner.

No automatic call. Nothing in the harness, the delivery gate or `panter_mesh_complete` requires a runner receipt. A later phase may let the gate prefer a receipt over a worker's claim; that is a separate decision.

## Configuration

Panter (`panter.env`): `PANTER_RUNNER_SOCKET=/run/panter-runner/runner.sock`, `PANTER_RUNNER_SIGNING_KEY_FILE=/home/<user>/panter-ai/etc/runner-signing.pem` (Ed25519 private key, mode 0600), `PANTER_RUNNER_KEY_ID=<name>`.

Runner (its own environment file, readable only by `panter-runner`): `PANTER_RUNNER_ROOT=/var/lib/panter-runner`, `PANTER_RUNNER_SOCKET`, `PANTER_RUNNER_PINNED_KEYS_FILE=/etc/panter-runner/pinned-keys.json`, `PANTER_RUNNER_REPOSITORIES`, `PANTER_RUNNER_TEST_TIMEOUT_SEC=900`.

Neither file is in the repository. `deploy/runner-install.sh` creates the user, the group, the directories, the key pair and the two files from templates, and installs the unit **disabled**.

## Acceptance

The pilot is done when all three hold:

1. On the operator's server, `panter_runner_test` on a commit of this repository returns the same pass/fail count as the CI run for that commit.
2. Tests prove the refusals: a replayed grant, an expired grant, a grant for another repository or commit, an intent whose work does not match the grant, a second pipeline while one runs, a step past its limit (the group is killed and cleanup still runs), and a restart during `EFFECT_WINDOW` (becomes `OUTCOME_UNKNOWN`, nothing re-runs).
3. With `PANTER_RUNNER_SOCKET` unset, `npm test` and the full tool surface are unchanged, and Panter in production behaves exactly as before the pilot.

## Phases

| Phase | Deliverable | Pull request |
|---|---|---|
| 0 | This design | `docs/RUNNER_PILOT.md` |
| 1 | The runner process: socket server, grant check, pipeline with limits and group kill, journal and outcomes, recovery on start, tests against a local fixture repository (no network) | `src/runner/`, `tests/runner-pilot-*.test.ts`, `npm run start:runner` |
| 2 | The Panter side: grant issuer, the two tools, runner receipts, configuration, `TOOL_SURFACE.md`, tests with a fake runner socket | `src/core/runner-grant-issuer.ts`, `src/core/runner-client.ts`, tool registration |
| 3 | Deployment: hardened `panter-runner.service`, `deploy/runner-install.sh`, templates, `SELF_HOSTING.md` and `OPERATIONS.md` sections, `scripts/smoke-runner.mjs` | `deploy/`, `scripts/` |
| 4 | Pilot on the operator's server with explicit authorization, comparison with CI, release | CHANGELOG, README line |

Phases 1 and 2 share only this document and `src/core/runner-protocol.ts`, so they can run in parallel. Phase 3 needs phase 1 merged. Every phase is a pull request with CI green, Codex when available, an independent review on the exact head commit by the reviewer account, and a squash merge by the leader.
