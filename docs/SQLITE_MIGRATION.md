# SQLite WAL migration — Panter-ai phase 1

## Decision and scope

Panter now uses `data/panter.sqlite` as the transactional authority for the
`state`, `agents`, `mesh`, `harness`, and `oauth` ledgers. The data model
remains backward-compatible JSON *inside* SQLite rows; it is not five independent
JSON files. SQLite schema `user_version=1` and `schema_migrations` record
the initial version. `BEGIN IMMEDIATE` serializes each read-modify-write
across separate SQLite connections/processes. WAL, `synchronous=FULL`, and
`busy_timeout=10000` are configured on every connection.

A single initial transaction imports all existing `<name>.json` snapshots
for the five namespaces (when present); invalid JSON, unsupported versions, or
any transaction failure abort the import. The source files are never rewritten
or deleted by the new adapter. Existing OAuth clients, token digests, refresh
families, grants, and pending authorization state are copied verbatim.

This phase does NOT normalize records into relational tables, guarantee one
business transaction across multiple distinct ledger operations, or add
multi-node scheduling/leases. Other ancillary legacy files used by Panter-RDD
and native reviewers are not yet migrated: do not declare every file SQL-backed.
No model/host wake is implied.

## Runtime requirements and limitations

- Node.js 22.23.4 on Oracle exposes `node:sqlite`; Node 22 still labels it
  experimental. Keep the tested Node 22 baseline pinned, monitor API changes,
  and do not silently replace the SQLite engine.
- `panter.sqlite` is mode 0600; its parent data directory must remain
  owner-private 0700. WAL and SHM files stay under that same private directory.
- Only Panter writes this database. Do not share the database over a network
  filesystem or run an unverified second live instance.
- OAuth/consent/registration restrictions at Cloudflare remain separate
  requirements. SQLite does not fix OAuth policy or wake behavior.

## Cutover procedure (one service only)

1. Freeze new Panter writes/agent claims, stop only `panter-ai`, and create
   a timestamped 0700 backup directory outside `data`.
2. Archive `data/` and `etc/` into mode-0600 backup files while the
   service is stopped. Keep both exact archives, current release SHA and
   checksum/audit records. Do not print or upload secrets.
3. Install the exact reviewed/merged main SHA into a new release directory,
   run `npm ci`, `npm run check`, `npm run build`, `npm test`,
   and smoke tests. Keep the existing `current` symlink intact until green.
4. Atomically switch `current` and restart only `panter-ai`. The first
   startup imports all five legacy snapshots in one SQLite transaction.
5. Verify `/health`, OAuth discovery, unauthenticated `/mcp` = 401,
   the original five client/grant identities, token refresh behavior, and
   representative harness/mesh reads. Preserve backup and old release.
6. Resume writes only when these checks pass. Exercise repeated refresh and
   restart on a protected canary before calling production migration complete.

## Rollback

**Do not simply point the symlink at the old JSON build after new writes
have occurred.** It would read stale JSON and silently lose new committed
work. Stop Panter, preserve the current SQLite file and WAL as forensic
evidence, restore the PRE-CUTOVER snapshots of both `data/` and `etc/`,
switch back to the previous verified release, and restart. Any work executed
after cutover requires deliberate reconciliation before reopening writes.

## Verification

`tests/sqlite-ledger.test.ts` checks atomic JSON import, preservation of
hashed OAuth token family records, cross-connection increments and restart,
and fail-closed corrupt input. Existing suites cover OAuth, mission, mesh
and harness behavior through the new database. Passing tests do not establish
a live five-host refresh/claim/wake E2E.
