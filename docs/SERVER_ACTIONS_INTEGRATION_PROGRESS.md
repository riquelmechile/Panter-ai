# Server actions integration: staged work

This branch provides the SQLite-backed `ServerActionStore` adapter on the existing
`server_actions` ledger. Its `transact` callback runs inside SQLite
`BEGIN IMMEDIATE`, and a transition to a terminal state releases the unique
active slot in the same transaction. Existing Phase 1 records lacking the new
`sha` and `reservedAt` aliases are read compatibly. Authorization, actor,
claim, permit and precondition evidence remains in the stored action.

This is **not** a complete server-actions integration. The following remain
unimplemented and must be completed before any real deployment is enabled:

- Connect `ServerActions.action()` to `launchServerAction`, and make dry-run
  explicitly opt-in.
- Wire a boot/restart reconciler, durable inbox receipt deduplication and
  per-actor redacted log tails.
- Provision private action directories, pass only allowlisted unit environment,
  and extend end-to-end recovery and failure tests.
- Update operator documentation and complete independent security review.

No deployment has been performed or enabled. Do not set
`PANTER_SERVER_ACTIONS` on a production server based on this branch.

Verification: `npm ci`, `npm run check`, `npm run build`,
`npm test`: 704/704 passed, including the new SQLite restart/slot test.
