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

## v0.5 OAuth external resource-server milestone

- [x] Add opt-in JWT validation with exact audience/issuer, fixed JWKS, actor/client-id bindings, scopes and discovery.
- [x] Add local negative-token tests and HTTP fixture-client round trip.
- [ ] Deploy external IdP with real consent/PKCE/OAuth client registrations and validate true app connections.
- [ ] Validate host-native MCP listen and autonomous continuation (not inferred from SDK).
- [ ] Implement transactional multi-process persistence, workspace permissions and safe Git/SSH execution.

## v0.6 embedded OAuth milestone (developer preview)

- [x] Self-hosted authorization-server discovery, exact allowlisted DCR, PKCE S256 and human consent with origin/CSRF/owner password.
- [x] Opaque access and refresh tokens persisted as SHA-256 digests, short-lived codes, refresh rotation/replay family revocation and token endpoint revocation.
- [x] Per-registered-client host approval, including distinct GPT-A/GPT-B identities, plus nine negative and continuity unit tests.
- [x] CI smoke for embedded OAuth and real MCP A2A round trip; `subscriptions/listen` delivery tested under authenticated transport.
- [ ] Security review and OAuth profile conformance audit before production/public exposure.
- [ ] Prove OAuth/consent and `subscriptions/listen` in the five real connected apps; **MCP listening is not automatically a host wake guarantee**.
- [ ] Durable multi-process SQL implementation, operator dashboard for revoking connections, and per-mission grants.
