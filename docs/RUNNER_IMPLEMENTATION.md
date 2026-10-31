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

## Gates bloqueantes antes de poner el ejecutor en servicio (review Claude PR #25)

**Estos cuatro puntos NO bloquean el merge de esta biblioteca sin ejecutor, pero todos son requisitos de aceptación obligatorios antes de habilitar cualquier socket/dispatcher que produzca efectos.** La revisión de Claude encontró y reprodujo estos riesgos:

1. **Crash y cola parcial del diario:** implementar detección de una única línea terminal incompleta (sin salto final), preservarla en cuarentena de solo lectura con hash, ubicación y evidencia verificable, reconciliar reserva/efectos antes de continuar y reanudar en un nuevo segmento válido. Alteraciones en cualquier entrada completa o en el interior del diario deben seguir fallando cerrado; probar corte eléctrico simulado, reinicio y falsificación.
2. **Rotación y límites de tamaño/rendimiento:** el diario actual valida O(n) cada `append` y al superar 16 MiB falla cerrado; antes de servicio definir límites operativos y rotación de segmentos sellados, encadenar hash final del segmento anterior con el génesis del siguiente, verificar continuidad al reiniciar, gestionar `fsync`, cuotas/espacio y evitar el re-hash integral por evento. Probar crecimiento y rotación bajo carga.
3. **Firma/digest canónicos:** derivar la identidad/digest de una firma sobre sus **64 bytes Ed25519 decodificados**, o exigir base64url canónico con recodificación idéntica. La forma actual utiliza el texto de la firma en el digest del ledger: una recodificación alternativa válida se rechaza por anti-replay (no es bypass), pero impide correlación canónica. Probar que representaciones equivalentes no generan identidades divergentes, sin aceptar replays ni alterar el payload firmado.
4. **Durabilidad y verificación externa de efectos:** hacer recuperable la falta de atomicidad entre **reserva SQLite, ejecución y append de auditoría** mediante protocolo de estados de intención/resultado y reconciliación de `OUTCOME_UNKNOWN`; nunca reintentar escrituras automáticamente tras una interrupción sin cercar al proceso anterior. Además **sellar/exportar el diario fuera del host/UID del runner**, verificar firma/continuidad entre segmentos y su cadena al reiniciar. Se requieren pruebas de fallo en cada frontera y detección de manipulación posterior. **Ambos subrequisitos son bloqueantes** antes del servicio.

**Corrección P1 ya implementada en este PR:** `PRAGMA busy_timeout=10000` se ejecuta antes de `PRAGMA journal_mode=WAL` (en sentencias separadas) tanto para `runner-grants.ts` como para el almacén legado `sqlite-ledger.ts`. `tests/runner-grants-multiprocess.test.ts` inicia dos procesos **independientes** sobre una base nueva, desde una barrera simultánea: verifica una reserva ganadora y una denegada (4 repeticiones), y dos incrementos persistidos en el ledger principal (3 repeticiones). Ningún proceso debe fallar durante la apertura por `database is locked`.


## Verificación exigida y siguientes PR

- CI: `npm run check`, `npm run build`, `npm test`; pruebas nuevas de firma válida, firma falsificada, alcance/lease/SHA, expiración, anti-replay con SQLite tras reinicio, rutas prohibidas y auditoría alterada.
- PR 2/3: servidor AF_UNIX, credenciales de pares verificadas en kernel, UID separado, denegación de operaciones no autorizadas, límites de recursos, reparación de estado incierto y **worktrees por intento**. En Node sin API nativa de `SO_PEERCRED`, el servicio debe usar una capa nativa revisada o fallar cerrado: permisos de socket por sí solos no satisfacen el ADR.
- PR 3/3: sandbox rootless real para ejecutar `npm ci`/build/test sin secretos ni red libre, pruebas adversariales de filesystem y red, y controlador de release separado por allowlist de servicios. Crear `panter-review` en fase 3, con llave Ed25519 independiente.

**No modificar ni apagar Xanxittoo en este PR.** Referencia normativa: [ADR-001](architecture/ADR-001-ISOLATED-RUNNER.md).


## Fase 2 — PR incremental de admisión Unix sin efectos (posterior a #25)

Se introduce `src/runner/readonly_ipc.py`, prototipo Python 3.12 stdlib **no desplegado** de socket local AF_UNIX. En Linux verifica `SO_PEERCRED` mediante `getsockopt` para obtener PID/UID/GID definidos por el kernel **antes de leer bytes del cliente**; el UID se compara con un allowlist fijado en la configuración de arranque (no suministrado en cada request). Requiere padre privado y propiedad del UID, rechaza sockets preexistentes/symlinks, crea socket 0600, limita mensajes a 16 KiB con timeout y rehúsa formatos desconocidos. Única respuesta autorizada: `runner.status` → `READ_ONLY`, `executionEnabled:false`; cualquier petición de trabajo, Git, despliegue o comando arbitrario se deniega. Es un adaptador de prueba, **no** un servidor de tareas y no ejecuta grants, procesos ni comandos.

`src/core/runner-worktree.ts` añade un planificador puro que genera un path de intento dentro de una raíz absoluta y retiene el SHA Git exacto. Solo valida sintaxis y contención léxica; **no** crea worktrees ni verifica symlink/TOCTOU del filesystem, ni invoca `git`. El futuro ejecutor debe abrir y validar raíces mediante descriptores con `O_NOFOLLOW/openat2` y lock por intento antes de construir/sanar el workspace.

**Puertas de seguridad aún pendientes para activación:**
- El socket de demostración usa padre 0700 y archivo 0600, por lo que solo prueba el mismo UID. Para separar los UID de `panter-ai` y `panter-runner` hay que instalar mediante operador una política grupal/ACL explícita en directorio y socket, sin permitir acceso a terceros, manteniendo la comprobación obligatoria de UID con `SO_PEERCRED`; pruebas E2E entre dos UID reales antes de habilitar cualquier operación.
- Actualmente el adaptador no verifica grants Ed25519 ni consume ledger, ni entrega trabajo: nunca interpretarlo como autorización de ejecución. En el siguiente PR será necesario integrar verificación de peer + grant firmado + reconciliación de efectos/diario.
- Los **cuatro gates pre-servicio** enumerados arriba (recuperación del diario, rotación/sellado, firma canónica y efectos inciertos/auditoría externa) siguen todos sin resolver. No hay permiso de ejecutar `npm`, `git`, `release.request`, ni despliegues reales aunque un host esté en `PANTER_OWNER_TRUSTED_HOSTS`.
- La dependencia Python 3.12 está disponible en Oracle y GitHub Ubuntu, pero **no** se agregó al Dockerfile; este prototipo no forma parte de `dist`, ni del servicio de producción, ni se distribuye mediante el contenedor existente. Cualquier empaquetado deberá incluir y auditar explícitamente el runtime del adaptador.

**Pruebas nuevas:** `tests/runner-ipc.test.ts` levanta un proceso Python real en una ruta temporal privada; valida `SO_PEERCRED`, UID autorizado/denegado, ausencia de reflejo de secreto, parser estricto, timeout, propiedad, sockets ocupados y symlinks. `tests/runner-worktree.test.ts` comprueba SHA exacto, rutas deterministas y rechazo de traversal o referencias textuales inseguras. Ambos son tests de desarrollo sin root, sin afectar Panter producción.
