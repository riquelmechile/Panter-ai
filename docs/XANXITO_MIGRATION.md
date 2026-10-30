# Migración Xanxittoo → Panter-ai (inventario y plan)

**Objetivo:** Panter-ai es Xanxittoo 2.0. La meta es reemplazar Xanxittoo por completo, portando lo que sirve, rediseñando lo que estaba mal y descartando lo que sobra, para después apagar Xanxittoo.

**Base del inventario:** `riquelmechile/xanxittoo@b90d281` (v0.5.8, Python, unas 30.500 líneas en `src/`, 85 archivos de tests) y Panter-ai en la rama del PR #1 (TypeScript, unas 4.000 líneas de núcleo, 168 tests).

**Regla de migración:** nada se porta en bloque. Cada capacidad entra a Panter con su propio PR, sus tests y su revisión independiente (`docs/INDEPENDENT_REVIEW_IDENTITY.md`). Xanxittoo no se modifica salvo para correcciones críticas mientras siga en uso.

## Inventario por capacidad

| # | Capacidad en Xanxittoo | Dónde vive (aprox. líneas) | Estado en Panter-ai | Decisión |
|---|---|---|---|---|
| 1 | **Control plane**: `xanxito_turn`, MissionContract, Execution Fabric, work registry, preflight, release gate, debt, checkpoints, telemetría | `execution_control` (1.571), `tools/control_plane` (789), `execution_fabric` (579), `work_context` (427), `mission` (273) | **Cubierto con otro diseño**: harness ODD (`auto-harness`), grants del operador, fences y reconciliación | **Rediseñar.** El harness de Panter es el canónico. Portar solo debt/checkpoint si se echan de menos en uso real. No portar Execution Fabric. |
| 2 | **Workforce A2A + wake** (Grok por webhook, Spark por correo/callback, Tasks/long-poll, presencia) | `workforce` (3.799) + `tools/workforce` (1.531), `workforce_wake` (423), `workforce_tasks` (399), `spark_callback` (848), `spark_email_relay` (343), `qe_peer_bridge` (316) | **Parcial**: malla con delegate/claim/complete/reconcile, inbox y `subscriptions/listen`; **sin adaptadores de wake** | **Portar mínimo.** Solo el doorbell por webhook firmado (lo único que funciona de verdad: Grok), separando "señal aceptada" de "wake observado". El relay de correo de Spark queda en evaluación. `workforce.py` es el módulo más grande y el más desordenado: no copiarlo. |
| 3 | **HostOps** (shell, fs, procesos PTY, browser con perfiles plasticov/maustian, watch, search, voz) sobre SSH | `hostops` + `runtime_hostops` + `tools/hostops` (1.822), `host_telemetry` (905), `host_context` (404), `host_policy` (365), `hostops_runner_sync` (208) | **No existe, por diseño** (Panter no da shell) | **Decisión pendiente y bloqueante.** Propuesta: un *runner* separado con permisos acotados por grant, worktrees aislados y auditoría, que Panter invoca. **No** se da shell libre desde el MCP. Sin esto Panter no puede reemplazar a Xanxittoo. |
| 4 | **Downstream MCP** (commerce/MercadoLibre, controlmcp con github/cloudflare/railway/pc) con routing por capacidad y árbol genealógico | `tools/downstream` (1.034), `downstream_oauth` (215), `tools/genealogy` (752), `src/mcp/registry.ts` (233) | **No existe** | **Portar.** Necesario para el trabajo de Plasticov/Maustian. Diseño: registro con clasificación lectura/escritura por herramienta, OAuth client-credentials por downstream, y escrituras con grant. El árbol genealógico se simplifica. |
| 5 | **Memoria** (Engram) | `tools/mem` (369) | **Cubierto**: puente Engram por proyecto, separado de Xanxittoo | **Listo en código.** Falta Engram ARM64 en Oracle. |
| 6 | **Skills** (list/load/resolve/forge/save) y research | `tools/skills` (1.084), `research` (646) | **Parcial**: catálogo Gentle Shell fijado, solo lectura | **Portar** carga y resolución de skills propias (Plasticov, proteccion-datos-chile, etc.). `forge`/`save` requieren revisión, porque escriben conocimiento. Research queda para más adelante. |
| 7 | **Revisión** (SDD, 4R, receipts, provenance) | `tools/review` (613), `tools/sdd` (263), `provenance` (372) | **Superado**: Panter-RDD con SHA exacto, autores excluidos, firmas Ed25519 de runner, gate de GitHub y ahora `APPROVE` de la identidad revisora | **No portar el de Xanxittoo.** `review.approve` en Xanxittoo **no verifica que el revisor sea distinto del implementador** y no exige ninguna aprobación en GitHub: por eso las revisiones independientes "pasaban" sin serlo o fallaban al intentar mergear. |
| 8 | **Autenticación** (OAuth, consentimiento, autorización por actor) | `oauth` (202), `consent` (118), `authorization` (187) | **Superado**: OAuth embebido con PKCE, cuotas por IP real, socket admin Unix y revocación | **Listo.** Falta validarlo con ChatGPT y Claude reales. |
| 9 | **Estado** (SQLite, estado compartido, migraciones, resiliencia) | `state_db` (438), `shared_state` (531), `state_migration` (804), `runtime_resilience` (690) | **Débil**: ledgers JSON de un solo proceso | **Portar el concepto.** Antes de migrar tráfico real, Panter necesita un store transaccional (SQLite en un proceso, luego Postgres) con migraciones. Es prerequisito de 2, 3 y 4. |
| 10 | **Presentación** (MCP Apps, vista MercadoLibre) | `presentation` (569), `mercadolibre_presentation` (653) | Solo Agent Studio | **Portar después** de 4 (commerce). |
| 11 | **Batch read** | `tools/batch` (349) | — | **Descartar.** Devolvía `INTERNAL_BATCH_ERROR`; en Panter las lecturas paralelas las hace el host. |

## Revisión independiente en Xanxittoo mientras siga vivo

No se agrega código a Xanxittoo. El proceso es:

1. Invitar a `sebastianriquelme95-max` como colaborador (**Write**) en `riquelmechile/xanxittoo`. El repo es privado, y el token de la cuenta ya tiene scope `repo`.
2. Todo PR de Xanxittoo se mergea solo con `APPROVE` de esa cuenta sobre el SHA exacto, emitido por un agente que no escribió el cambio, con la misma convención de texto que en Panter.
3. Los receipts internos de `review_*` de Xanxittoo se tratan como **evidencia no independiente**.

## Orden de trabajo propuesto

| Fase | Entregable | Prerequisito |
|---|---|---|
| 0 | Mergear PR #1 y PR #6 (identidad revisora en el gate) | aprobación del responsable |
| 1 | Canary privado de Panter en Oracle, al lado de Xanxittoo y sin tocarlo | fase 0 |
| 2 | Primer ciclo real: ChatGPT conectado por OAuth hace una tarea chica de punta a punta | fase 1 |
| 3 | Usuario Unix `panter-review` con la credencial revisora y la llave del runner, más protección de `main` | fase 1 |
| 4 | Store transaccional (SQLite) con migración de los ledgers JSON | fase 2 |
| 5 | Decisión e implementación del runner de ejecución (reemplazo de HostOps) | fase 4 |
| 6 | Downstream MCP (commerce primero) con clasificación lectura/escritura | fase 4 |
| 7 | Wake por webhook firmado (Grok) y skills propias | fase 4 |
| 8 | Operación en paralelo; Xanxittoo pasa a solo lectura y luego se apaga | 5, 6 y 7 en uso real |

**Criterio para apagar Xanxittoo:** dos semanas operando Plasticov/Maustian y desarrollo solo con Panter, sin volver a usar ninguna herramienta de Xanxittoo, y con backup de su estado archivado.
