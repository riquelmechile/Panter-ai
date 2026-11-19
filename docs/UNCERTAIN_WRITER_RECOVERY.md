# Panter-ai: reconciliation of uncertain remote implementers

This is a **manual security procedure** for an operator with authenticated access to the private Unix socket only. Neither GPT-A nor the remote peer can authorize reconciliation. Panter DOES NOT control or kill operating-system processes belonging to external peer hosts.

1. Call the private MCP tool `panter_mesh_uncertain_writers`. Record the exact `workId`, `missionId`, `attemptId`, `leaseGeneration`, `target`, allowed edit surfaces and expired lease for the `OUTCOME_UNKNOWN` or expired `RUNNING` writer.
2. **Quarantine before releasing scopes.** Disable/revoke the remote worker's actual write credentials and access to the GitHub branch/worktree; terminate or isolate the remote process on the executing host. Merely expiring the Panter lease or invalidating a result receipt is NOT enough: a zombie process may continue writing externally. If there is no reliable way to stop it, **do not use `CONFIRMED_NO_EFFECTS`**; keep the mission blocked and investigate manually. Ask the remote operator/platform to confirm termination, revoked credentials and host/worktree isolation.
3. Inspect repository refs, worktree diff, uncommitted edits, run logs, timestamps and CI. Determine whether the original writer completed exactly the authorized changes. Save evidence (SHA, run ID, logs/links). Watch for delayed writes and confirm the isolation is effective before deciding.
4. Through the private Unix socket, invoke `panter_mesh_reconcile_writer` with the exact original fence and one outcome:
   - `CONFIRMED_COMPLETE`: provide `resolution`, operator `evidence` and the observed `result` (`summary`, array of `evidence`, frozen `candidateSha`, original `runId`). No additional writer is started.
   - `CONFIRMED_NO_EFFECTS`: **only** after the operator has positively verified no effects AND isolated the original peer/worktree. Include detailed `evidence` and mandatory `isolationEvidence` describing how the credentials were revoked / process was killed / worktree was isolated. This creates an operator audit statement, not hardware-backed process termination proof.
5. Re-query `panter_mesh_uncertain_writers` and inspect the harness. If `CONFIRMED_NO_EFFECTS` was accepted, the next harness tick may issue a fresh attempt with a new idempotency generation **only while an operator write grant remains valid**. If the grant expired, request a new scoped grant before proceeding.
6. Inspect the actual Git SHA and run CI; freeze a new candidate and re-run the appropriate independent reviews. Never reuse evidence from the previous candidate SHA.

**Failure rules:** never guess an `attemptId` from a log, copy a fence from another task, tell the peer to replay its own work, release overlapping edit scopes without confirmed isolation, or mark an unaudited operator statement as external runner attestation. A remote zombie cannot be fenced at the OS/GitHub layer by Panter alone.

**Deployment policy:** Until real worker termination/revocation is integrated with the execution provider and independently tested, human oversight is mandatory for any `CONFIRMED_NO_EFFECTS` reconciliation.

## The automatic sweep

Every five minutes the server looks for claims whose lease ran out more than `PANTER_SWEEP_GRACE_SECONDS` ago (default 6 hours) and that no transport holds. It never starts a model, never replays a write and never contacts the worker.

- **Read-only work** ends `ABORTED_NO_EFFECTS` (it left nothing to reconcile), its GitHub grant is closed and the leader gets one `SWEPT_EXPIRED_READ_ONLY` message. The swept attempt is fenced out: a result that arrives later is refused.
- **A writer** becomes `OUTCOME_UNKNOWN`, exactly as when someone tries to claim it again. Panter then looks once, with the workforce token and only in the repository of that work's grant, for the work's own `panter/` branch, pull requests from that branch and the work's audited writes, and sends the leader one message with what it saw and the `attemptId` and `leaseGeneration` this procedure needs (`UNCERTAIN_WRITER_NEEDS_RECONCILIATION`). If GitHub cannot be asked, it tries again on the next pass. A work with no GitHub grant is reported as `UNVERIFIABLE`.

"Nothing found" is evidence about that grant, not proof about the world: a worker that published through another tool, or on another branch, is not seen.

**Outside owner mode** the sweep releases no writer. The procedure above stays the only way to close one, and its deployment policy is unchanged.

**In owner mode** a writer for which nothing was found is closed `ABORTED_NO_EFFECTS` by the sweep itself, with the evidence stored as its reconciliation and one `SWEPT_WRITER_NO_EFFECTS` message to the leader; its grant is closed and its edit scope is free again. That is the owner accepting, for a deployment where every host is theirs, the residual risk named above. A writer that left a branch, a pull request or an audited write is never closed automatically in any mode.
