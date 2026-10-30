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
