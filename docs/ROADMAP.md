# Panter-ai roadmap

## Foundation (v0.1)
- [x] Stateless remote MCP transport with host-managed inference.
- [x] Explicit host request contract and evidence boundaries.
- [x] Persistent mission lifecycle and idempotent task queue.
- [x] Single-tenant bearer transport and restricted network binding.
- [x] Automated unit tests and CI configuration.

## Agent workflow engine (v0.2)
- [x] Role contracts for focused read-only scout/designer and scoped builder/verifier/reviewer.
- [x] Inline/read-only/coordinated workflow decision and exact durable specification.
- [x] Dependency-aware dispatch, fencing, recovery and blocking question relay.
- [x] Admission guard for overlapping writer scopes in the same declared workspace.
- [x] Candidate SHA freeze, independent verification/review policy and invalidation.
- [ ] Host-native worker launch integration, external wake, authenticated workers and real CI proof checks.

## Connectivity (v0.3)
- [ ] OAuth 2.1 / protected-resource metadata / per-user and per-actor identities.
- [ ] PostgreSQL persistence and horizontal-safe claims.
- [ ] Authenticated, scoped MCP downstream registry with live discovery.
- [ ] MCP tool read/write classification and approvals.

## Development engine (v0.4)
- [ ] Repository integration, branch/PR lifecycle and CI receipts.
- [ ] Specification-driven planning and risk-proportional independent reviews.
- [ ] Container-sandbox runners for trusted builds; no dependency on a personal PC.
- [ ] Context/memory summaries with explicit scopes and retention policies.

## Agent mesh (v0.5)
- [ ] Authenticated actor registrations, capabilities and verified lease ownership.
- [ ] MCP Tasks negotiation, long polling and signed external event doorbells.
- [ ] Wake observation separate from signal acceptance.
- [ ] Durable retry budgets, loop breakers, quotas and provenance.

## Release goals
- [ ] Hosted installation guide and security audit.
- [ ] Performance benchmarks and integration tests on representative MCP hosts.
- [ ] Explicit compatibility matrix for host-native agents and reasoning-effort settings.
