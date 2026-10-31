# Runner fase 2 — núcleo de autorización (PR incremental 1/3)

**Estado:** implementación parcial, solo bibliotecas. No existe todavía `panter-runner.service`, socket AF_UNIX, ejecución de procesos, sandbox de scripts, worktrees ni mecanismo de despliegue. **No activar en producción** hasta completar el ADR-001 y obtener revisión independiente de Claude sobre cada SHA.

## Qué implementa este primer PR

- `src/core/runner-grants.ts`: parseo estricto del contrato `panter.runner-grant/v1`; firma Ed25519 verificada contra claves públicas fijadas por configuración del ejecutor. Se comprueban issuer `panter-ai`, audience `panter-runner`, identidad, misión/trabajo/intento, `leaseGeneration`, repositorio, SHA exacto, rango temporal <= 1 h, operaciones allowlisted, rutas relativas sin traversal y clasificación de efectos. Se rechazan campos desconocidos, comandos de shell, operaciones mixtas en un grant y maxUses >1 en operaciones con efectos.
- `RunnerGrantLedger`: SQLite WAL local, transacción `BEGIN IMMEDIATE` y reservas únicas por `requestId`; vincula el digest del grant a su UUID, impide repetir una solicitud y mantiene el contador tras reinicio. Una **reserva no prueba ejecución** ni un receipt firmado.
- `src/core/runner-journal.ts`: diario de eventos tipados, sin mensajes de texto arbitrarios, stdout/stderr ni secretos; secuencia, prev_hash/hash, append y fsync; falla cerrado si detecta alteraciones. El hash-chain local **no es inmutable contra un atacante con permisos del usuario/host** ni sustituye exportación y sellado fuera del host.
- `src/core/runner-protocol.ts`: parser de intención con tamaño máximo (16 KiB), campos/operaciones estrictos; `runnerExecutionAvailable()` retorna `false`. No exporta dispatcher ni socket.

## Límites intencionales

1. Esta biblioteca **solo verifica** grants firmados. No incluye la clave privada ni una API pública para firmarlos: Panter deberá firmar en su propio servicio tras autenticar a un administrador del dueño único, incluidos los hosts enumerados en `PANTER_OWNER_TRUSTED_HOSTS`. La futura firma usa una clave separada de los receipts independientes `panter-review` y nunca alcanza los worktrees.
2. No se procesa ningún `grant` directamente desde bearer OAuth en el runner. El proceso futuro fijará claves públicas locales y validará `SO_PEERCRED` en el socket antes de tomar acciones.
3. SQLite anti-replay y JSONL no forman actualmente una transacción global; un fallo entre la reserva y el append produce **efecto desconocido**, que requiere reconciliación. El siguiente PR debe definir el orden/recuperación y registrar evidencia del proceso con un ID distinto del del autor.
4. `release.request` aparece en el *vocabulario de tipos* pero **no puede ejecutar un despliegue**. Su futuro controlador validará SHA mergeado, CI, revisión independiente, respaldo consistente y servicio allowlisted; `panter-ai` puede ejecutarse automáticamente con grant admin confiable si pasan todos los gates y no requiere confirmación humana repetitiva. Las políticas de commerce/pagos pueden exigir confirmación.
5. Las rutas relativas del grant no sustituyen comprobaciones de `realpath`, symlink/TOCTOU y `openat` que deberán implementar worktrees y sandbox antes de aceptar archivos.
6. El diario requiere **un solo escritor**; hay que introducir coordinación transaccional para multiproceso y sellado externo antes de su puesta en servicio. Revisar uso de espacio, truncamientos, rotación y crash recovery.

## Verificación exigida y siguientes PR

- CI: `npm run check`, `npm run build`, `npm test`; pruebas nuevas de firma válida, firma falsificada, alcance/lease/SHA, expiración, anti-replay con SQLite tras reinicio, rutas prohibidas y auditoría alterada.
- PR 2/3: servidor AF_UNIX, credenciales de pares verificadas en kernel, UID separado, denegación de operaciones no autorizadas, límites de recursos, reparación de estado incierto y **worktrees por intento**. En Node sin API nativa de `SO_PEERCRED`, el servicio debe usar una capa nativa revisada o fallar cerrado: permisos de socket por sí solos no satisfacen el ADR.
- PR 3/3: sandbox rootless real para ejecutar `npm ci`/build/test sin secretos ni red libre, pruebas adversariales de filesystem y red, y controlador de release separado por allowlist de servicios. Crear `panter-review` en fase 3, con llave Ed25519 independiente.

**No modificar ni apagar Xanxittoo en este PR.** Referencia normativa: [ADR-001](architecture/ADR-001-ISOLATED-RUNNER.md).
