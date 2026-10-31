# ADR-001: Runner de ejecución aislado para Panter-ai

- **Estado:** PROPUESTO — diseño, sin implementación ni autorización de despliegue
- **Fecha:** 2026-10-31
- **Fase:** 2, migración Xanxittoo → Panter-ai
- **Decisores:** responsable del proyecto y revisión independiente de Claude en PR
- **Referencias:** `docs/CANONICAL_HARNESS_POLICY.md`, `docs/XANXITO_MIGRATION.md`, `docs/PANTER_RDD_NATIVE.md`, `docs/UNCERTAIN_WRITER_RECOVERY.md`, `docs/SQLITE_MIGRATION.md`

## Contexto y decisión

Panter-ai es el único **control plane** previsto; Xanxittoo HostOps es temporal. Panter recibe las solicitudes, mantiene grants/leases en SQLite, decide automáticamente el ODD y revisa evidencias. **No** interpreta comandos de shell recibidos de modelos ni accede a `sudo` o `ssh` por una herramienta MCP genérica. La ejecución corre en un servicio local independiente `panter-runner` con UID Unix dedicado, invocado exclusivamente mediante socket Unix privado. Se divide el dominio de ejecución no confiable (repositorios, scripts de build/test) del dominio privilegiado de release/deploy.

Este ADR adopta **diseño de confianza cero entre el control plane y el ejecutor**: la identidad de un host OAuth permite solicitar trabajo, pero no es una credencial de ejecución. Ningún texto generado por el modelo —incluidos los informes de harness— constituye un grant ni un recibo firmado. Las cinco identidades OAuth actuales continúan intactas; el runner no las administra.

## Límites de confianza y despliegue

```text
Host OAuth → Panter MCP (usuario de servicio, no shell)
                    │ decisiones ODD + grant del operador
                    ▼
           socket AF_UNIX privado
                    │ SO_PEERCRED, framing y tamaño máximos
                    ▼
      panter-runner (UID dedicado, sin sudo ni TCP)
             ├── policy / grant validator
             ├── audit append-only
             ├── worktree único + sandbox desechable
             └── request deploy -> mecanismo de release separado
                                         │ gate explícito, SHA, backup
                                         ▼
                                 solo servicio autorizado

panter-review (fase 3): identidad GitHub y firmante Ed25519
aislados tanto del proceso de modelos como del ejecutor de código.
```

- `/run/panter-runner/runner.sock` (ruta de configuración del operador, no fija en código): directorio `0700` o ACL explícita, socket `0660` únicamente para el grupo del control plane. Validar `SO_PEERCRED` (UID/GID/PID) en cada conexión; no dar por suficiente el permiso del archivo. No exponer socket mediante túnel, TCP, MCP tools ni contenedores.
- `panter-runner.service` con `User=panter-runner`, `NoNewPrivileges=yes`, `ProtectSystem=strict`, `PrivateTmp=yes`, `ProtectHome=yes`, `RestrictAddressFamilies=AF_UNIX` cuando corresponda y directorios `ReadWritePaths` puntuales. Definir perfiles de aislamiento distintos para bootstrap con red, ejecución offline y deploy. Probar en Oracle ARM64 en lugar de asumir soporte de seccomp/cgroups.
- Solo un componente de release delegado al operador puede efectuar el reinicio del servicio `panter-ai`. El runner de desarrollo no obtiene acceso a `/etc`, llaves SSH, tokens de GitHub, credenciales downstream, Docker socket, sockets Postgres/Redis ni al estado OAuth de producción.
- La lista de repos y raíces de checkout permitidas procede de configuración **fuera de Git, administrada por el operador**, vinculada a repositorio GitHub canónico y origen permitido. Soportar repos de Zana por política explícita; no admitir comodines globales.
- Las credenciales de `panter-review`, la clave privada Ed25519, y los archivos `PANTER_RDD_RUNNER_KEYS_FILE` / reglas locales se mantienen fuera del alcance del control plane y de los worktrees. En fase 3 se concretará el protocolo de firma: la evidencia se firma únicamente en una ejecución de revisión independiente verificable, no por petición libre de un agente.

## Protocolo de tareas y grants

El socket recibe operaciones tipadas con versionado `panter.runner/v1`; **no** hay operación `exec(command)` ni cadenas de shell. Las operaciones iniciales previstas son `workspace.prepare`, `git.inspect`, `build.install`, `build.check`, `build.compile`, `test.run`, `git.diff`, `workspace.cleanup` y `release.request`. Respuestas: `run_id`, `task_id`, `lease_generation`, `operation`, `status`, `exit_code` limitado, digest de salida y punteros de evidencia sin secretos. Limitar solicitud/respuesta, cuota, tiempo y bytes de log.

Cada operación exige grant firmado o autenticado por un canal de operador independiente del modelo, comprobado **dentro del runner** y no solo en Panter: `grant_id`, `issuer`, `audience`, `subject`, `mission_id`, `work_id`, `attempt_id`, `lease_generation`, `repository`, `candidate_sha` o ref permitido, conjunto de operaciones, rutas relativas, clasificación de efecto, `not_before`, `expires_at`, `max_uses`, límites de recursos y nonce. Los grants originales de Panter se admiten solo tras validar criptográficamente su procedencia y scope mediante contrato de operador; jamás confiar en un UUID enviado sin comprobación. Registrar el consumo en almacenamiento transaccional para impedir replay. Grants vencidos, revocados, reutilizados, con SHA/actor/proyecto distintos o scopes superpuestos incompatibles fallan cerrados.

El trabajo en cola no concede permisos. Cada claim adquiere un lease *fenced*; antes de abrir archivos o producir efectos se comprueba su generación y su vigencia. El operador puede revocar el grant, detener el cgroup y poner la tarea en cuarentena. Una expiración de lease **no mata por sí sola** el proceso: no liberar scopes hasta comprobar terminación y revisar efectos conforme a `UNCERTAIN_WRITER_RECOVERY.md`.

## Worktrees y comandos permitidos

1. Preparar checkout en una raíz privada por `mission/work/attempt`, a partir de SHA remoto verificado y repositorio autorizado. Usar `git worktree add --detach` en un mirror administrado por el runner. Validar `realpath`, `O_NOFOLLOW`/equivalentes, tipos de entrada y pertenencia de rutas después de operaciones de Git; rechazar traversal, symlinks fuera de raíz, submódulos no aprobados y hooks arbitrarios. No reutilizar el mismo worktree entre tareas.
2. Todas las ejecuciones toman un descriptor tipado, no `sh -c`, `bash -c`, `eval`, PTY, redirecciones, variables de entorno del usuario ni argumentos concatenados. Definir una matriz exacta por operación de **binario absoluto, subcomando, opciones, argumentos y cwd**, con rechazado por defecto. La mera allowlist de binarios no es suficiente.
3. `npm ci`, `npm run build`, `npm test` y cualquier script de repositorio **pueden ejecutar código arbitrario** aun cuando `npm` esté permitido. Ejecutarlos únicamente dentro de una sandbox rootless/desechable con UID no privilegiado, filesystem limitado al worktree, sin secretos ni sockets del host, límites CPU/RAM/tiempo/procesos y sin red por defecto. El paso que requiera registro npm accede solo al destino aprobado durante bootstrap, nunca a endpoints arbitrarios.
4. Separar claramente lectura, escritura de worktree y ejecución de efectos externos. Push, merge, publicación de paquetes, Cloudflare, comercio, migración de datos y despliegue no son permisos implícitos de `build`. Cada uno requiere operación y grant específico, confirmación del operador y auditoría. Integraciones downstream de la fase 4 mantendrán su propio gate de escritura.
5. Ningún comando tiene acceso a la rama `main` para escribir. El responsable usa `gh-main` mediante flujo autorizado; la cuenta `gh-review` no se expone al runner implementador. Revisiones ocurren en ejecución distinta de la que editó código, sobre SHA exacto.

## Ruta de despliegue separada

`release.request` no reinicia nada directamente. El controlador de release con política mantenida por el operador exige: repositorio/servicio allowlisted; SHA **mergeado en `main`**, CI requerido verde sobre el mismo candidato, revisión GitHub independiente aprobatoria y válida, attestations Panter-RDD cuando sean requeridas, consentimiento para el efecto de despliegue, ventana y plan de rollback. Descarga tarball del SHA exacto, instala release nuevo, ejecuta pruebas en sandbox, realiza **backup consistente de `data/` (incluido SQLite por API de backup/VACUUM INTO) y `etc/`** sin exponer contenido, cambia symlink atómicamente y reinicia **solo** la unidad autorizada. Comprueba `/health`, OAuth discovery, 401 sin bearer, cinco clientes OAuth y datos funcionales. Conserva release/backup para rollback y registra evidencia. No inventar reinicio, firma ni CI a partir de respuesta de modelo.

El controlador privilegiado de despliegue opera mediante una interfaz fija, sin `sudo` genérico para `panter-runner`. En caso de validación fallida o efectos desconocidos, detener y exigir reconciliación antes de reintentar. La gestión actual de respaldo nocturno queda fuera del alcance de este PR.

## Auditoría y privacidad

El runner conserva un diario **append-only** fuera de la sandbox, con esquema estable: marca temporal, secuencia, `prev_hash`, hash actual, ID de operador/grant, misión, intento, SHA, operación validada, resultado, tiempos, digest de stdout/stderr y evidencia de cuarentena/rollback. Añadir entradas con `O_APPEND`, `fsync`, rotación sellada y copia fuera del UID del runner. Un hash-chain en el mismo host detecta cambios accidentales pero **no es prueba de inmutabilidad ante compromiso del host**: debe exportarse periódicamente a almacenamiento independiente y verificarse la continuidad al reiniciar. Nunca persistir tokens, claves, cookies, variables de entorno ni volcados completos de logs no depurados.

## Alternativas rechazadas

- **Reutilizar Xanxittoo HostOps:** shell/SSH demasiado amplio; acopla ejecución, administración y autorización.
- **Dar `sudo` o shell al MCP Panter:** convierte contenido no confiable de modelos en capacidad directa de host.
- **Confiar solo en allowlist de `npm`/`git`:** scripts npm, hooks y opciones permiten ejecutar código no confiable.
- **Mismo UID para Panter, runner, revisor y deploy:** una fuga de credencial o proceso elimina la independencia.
- **Solo SQLite leases como aislamiento:** no detienen procesos zombis ni revocan credenciales remotas.

## Fases de implementación y criterios comprobables

1. **PR de este ADR:** solo decisión/documentación, sin servicio ni cambios en producción; revisión independiente de Claude.
2. **Runner mínimo:** UID/grupo, socket privado con `SO_PEERCRED`, API tipada, grants verificables, registro append-only, worktrees aislados; tests de deny-by-default, replay, scope, symlink/TOCTOU y reinicio.
3. **Sandbox de build/test:** ejecutar `npm ci`, `check`, `build` y `test` de un repositorio desechable en ARM64; demostrar que código malicioso de `package.json` no puede leer `/home/zana/panter-ai/etc`, `data/oauth.json`, llaves ni sockets, ni hacer llamadas de red externas.
4. **Operador y firma (fase 3):** provisionar `panter-review` aislado, llaves y recibos Ed25519 verificables, separación real autor/revisor, reglas de rama en GitHub.
5. **Release controlado:** ensayo en servicio de prueba con CI/SHA exactos, backup/restore SQLite, provocación de fallo y rollback, sin reiniciar otros servicios. Habilitar release real solo tras aprobación del operador y pruebas E2E.
6. **Retirada de HostOps:** solo después de que Panter cubra trabajo de repositorios y downstream, y de dos semanas de operación paralela sin regresiones; Xanxittoo no se apaga en este ADR.

**Condición de aceptación:** cada paso deberá tener PR propio, CI verde, revisión independiente sobre SHA exacto y evidencia real de seguridad y operación. Este ADR no declara implementado ni listo para producción el runner.
