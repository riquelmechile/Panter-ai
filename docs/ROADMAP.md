# Roadmap status

The checkboxes below are a **historical per-release backlog** and should not be interpreted as the current release inventory. Normative behavior and current known acceptance gaps are in [`CANONICAL_HARNESS_POLICY.md`](CANONICAL_HARNESS_POLICY.md). In v0.15 embedded OAuth, GitHub verification, Panter-RDD, GPT-A native packet planning and Engram MCP bridges exist in code, but real host onboarding, Oracle deployment, runner signatures, secure worktrees and multi-process persistence remain unverified/incomplete. Do not toggle these boxes simply to declare production ready.

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


## v0.9: GPT-A without workforce and native RDD preflight

- [x] GPT-A ODD fallback plan without remote host credentials, native-subagent selection only when the host reports actual support, and inline sequential fallback.
- [x] Inline/native-agent packets read specialist definitions and skills directly from the MCP without a remote binding.
- [x] Reject overlapping parallel writer scopes, unsigned model approvals and incorrect candidate SHA reports.
- [x] Optional operator-pinned read-only bridge to official Gentle AI Go review-integration/v2 (capabilities, assess, status).
- [x] Fail closed when the native reviewer, host tools or remote peers are unavailable.
- [ ] Connect a **supported** native Gentle AI review runtime to a protected Oracle Git worktree and complete real consent, capture, correction, final acknowledgement and release checks. Read-only bridge is not full RDD lifecycle.
- [ ] Validate real GPT-A native agents and concurrency reports in ChatGPT. A model-selected profile is not evidence that workers were spawned.
- [ ] Durable multi-replica grants, verified CI/Git evidence and host wake acceptance.

## v0.11 native-subagent review handoffs
- [x] Persist frozen 4R or two blind Judgment Day slots, each with a versioned MCP skill packet and candidate SHA.
- [x] Batch outstanding work for genuine host-owned parallel native children; no remote peer required.
- [x] Collect independently reported child runs with distinct IDs, bounded structured findings and SHA-bound immutable receipts.
- [x] Reject report tampering, stale packets, conflicting retries and fabricated server approval; recover across restarts.
- [ ] Integrate actual ChatGPT host-native child launch and verify independent execution evidence and throughput.
- [ ] Wire full official Gentle AI Go RDD v2 consent/transition/fix/validation/acknowledgement on a trusted Git runner; current bridge is read-only.
- [ ] Add multi-process transactional storage and isolate correction worktrees before production.

## v0.15.x embedded OAuth — contrato con clientes reales (PR #18)

- [x] Cookie de consentimiento `SameSite=Lax` (Secure, HttpOnly, 10 min): ChatGPT llega a `/authorize` por navegación cross-site y los navegadores no envían cookies `Strict` en esa cadena. El CSRF de doble envío y la verificación de Origin del POST se mantienen.
- [x] Clientes confidenciales: `/register` acepta `none`, `client_secret_basic` y `client_secret_post`; el secreto se entrega una vez y solo se guarda su hash. `/token` y `/revoke` aceptan credenciales por HTTP Basic (RFC 6749 §2.3.1) o en el cuerpo y exigen el secreto a los clientes confidenciales. PKCE S256 sigue siendo obligatorio para todos.
- [x] Gemini: hasta 10 `redirect_uris` (Gemini registra 6 relays `/r/` y `/a/` de Google) y entrega HTML sin scripts tras el consentimiento para los hosts relay exactos de Google, porque Chrome aplica el `form-action` CSP a toda la cadena del POST. ChatGPT, Claude y Grok siguen con 302.
- [x] `panter:lead` solo se concede a `gpt-a`; si otro host lo pide, se descarta en vez de fallar el consentimiento.
- [x] Toda conexión aprobada recibe `offline_access` y refresh rotativo (ChatGPT no lo solicita); reuso detectado revoca la familia.
- [x] Logs `[oauth] <etapa> rejected: <motivo>` con mensajes fijos únicamente; los errores no controlados (p. ej. JSON malformado) se registran solo por clase, nunca con fragmentos del cuerpo.
- [ ] Validación sostenida en los cinco hosts reales (renovación de GPT-A/GPT-B tras la primera hora, revocación desde Gemini).

## v0.15.x despliegue de un solo dueño — `PANTER_OWNER_TRUSTED_HOSTS` (PR #18, commit 14bbb58)

**Ampliación de privilegios administrativos (opt-in).** Por defecto las herramientas admin-only solo se pueden usar con `PANTER_OPERATOR_TOKEN` por el socket Unix privado. Con `PANTER_OWNER_TRUSTED_HOSTS=<hosts>`, los principales OAuth autenticados de esos hosts también son admin.

- [x] Alcance exacto (todo lo que pasa por `requireAdmin`): `panter_harness_write_grant` (incluye auto-emitirse grants de escritura), `panter_harness_delivery_strategy_set`, `panter_oauth_clients`, `panter_oauth_client_revoke`, `panter_mesh_uncertain_writers`, `panter_mesh_reconcile_writer`, `panter_host_policy` y las herramientas legacy de misiones/trabajo/flujos/agentes registradas con `registerLegacyTool` (`panter_mission_*`, `panter_work_*`, `panter_agent_*`, `panter_flow_*`).
- [x] La identidad sale del token OAuth emitido tras el consentimiento con clave de operador, nunca de argumentos. Solo se aceptan identidades de host válidas (`gpt-a`, `gpt-b`, `grok`, `gemini`, `claude`); una entrada inválida aborta el arranque.
- [x] Sin la variable el comportamiento no cambia (test `owner-trust`). `requireLeader` (gpt-a) y la separación autor/revisor en GitHub no se relajan.
- [x] Supuesto de seguridad: todas las cuentas conectadas pertenecen al mismo dueño. Si se usa, el registro de clientes (`/register`, `/authorize`, `/oauth/consent`) debe quedar cerrado en el borde (en producción: 403 en el túnel) y abrirse solo para reconectar.
- [ ] Riesgo aceptado: un token robado de cualquiera de esos hosts tiene poder de operador hasta que se revoque su cliente. Mitigación: revocación por cliente, refresh rotativo con detección de reuso y quitar la variable para volver al modo restringido.

## v0.16 SQLite WAL transaccional — fase 1 Xanxittoo → Panter

- [x] Esquema SQLite versionado (`user_version=1`, `schema_migrations`) y WAL para `state`, `agents`, `mesh`, `harness` y `oauth`; importación transaccional de los JSON, preservando las conexiones OAuth sin volver a registrar los clientes.
- [x] Lecturas y escrituras desde SQLite, `BEGIN IMMEDIATE` contra pérdidas de actualización entre conexiones, `busy_timeout`, integridad y pruebas de reinicio.
- [x] Originales JSON conservados únicamente como respaldo anterior al corte; rollback exige detener Panter y restaurar snapshot anterior, nunca apuntar a una versión vieja con JSON desfasados.
- [ ] Validar release en Oracle con parada controlada, backup y cinco clientes OAuth; las pruebas aisladas no prueban uso continuo en hosts reales.
- [ ] Migrar estados auxiliares de revisión nativa/Panter-RDD y coordinar transacciones de negocio entre namespaces; no equivale todavía a despliegue horizontal.

Guía: [SQLITE_MIGRATION.md](SQLITE_MIGRATION.md). Node 22 `node:sqlite` aún es experimental; fijar y validar la versión del runtime.

## v0.16 runner aislado: primer corte de implementación

- [x] ADR-001 aprobado: runner separado, grants firmados, sandbox, worktrees y auditabilidad.
- [x] Núcleo offline de verificación de grants Ed25519: issuer/audience, identidad, misión/intento, SHA, alcance, vencimiento y anti-replay SQLite WAL.
- [x] Protocolo tipado con allowlist sin shell libre ni dispatch de operaciones en esta etapa.
- [x] Auditoría local append-only con hash-chain y esquema sin payloads secretos; **no** equivale a auditoría inmutable sin sellado externo.
- [ ] Servicio Unix separado y `SO_PEERCRED`, verificación de grants en IPC real, política de claves y crash recovery.
- [ ] Sandbox de npm/scripts, worktrees aislados y pruebas adversariales en Oracle ARM64.
- [ ] Firma de grants en control plane únicamente para admins autenticados (`PANTER_OWNER_TRUSTED_HOSTS`), independiente de las llaves Panter-RDD.
- [ ] Controlador de release con gates y política por servicio; `panter-ai` automático según ADR, commerce/pagos con protección configurable.
- [ ] Revisión independiente de Claude sobre PR y SHA exacto; instalación/reinicio solo después.

Estado: este primer PR **no pone en marcha** un runner, no da shell, no reinicia servicios ni reemplaza todavía HostOps. Véase [RUNNER_IMPLEMENTATION.md](RUNNER_IMPLEMENTATION.md).
