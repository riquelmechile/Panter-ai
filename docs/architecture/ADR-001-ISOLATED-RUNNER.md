# ADR-001: Runner de ejecución aislado para Panter-ai

- **Estado:** PROPUESTO — diseño, sin implementación ni autorización de despliegue
- **Fecha:** 2026-10-31
- **Fase:** 2, migración Xanxittoo → Panter-ai
- **Decisores:** responsable del proyecto y revisión independiente de Claude en PR
- **Referencias:** `docs/CANONICAL_HARNESS_POLICY.md`, `docs/XANXITO_MIGRATION.md`, `docs/PANTER_RDD_NATIVE.md`, `docs/UNCERTAIN_WRITER_RECOVERY.md`, `docs/SQLITE_MIGRATION.md`

## Contexto y decisión

Panter-ai es el único **control plane** previsto; Xanxittoo HostOps es temporal. Panter recibe las solicitudes, mantiene grants/leases en SQLite, decide automáticamente el ODD y revisa evidencias. **No** interpreta comandos de shell recibidos de modelos ni accede a `sudo` o `ssh` por una herramienta MCP genérica. La ejecución corre en un servicio local independiente `panter-runner` con UID Unix dedicado, invocado exclusivamente mediante socket Unix privado. Se divide el dominio de ejecución no confiable (repositorios, scripts de build/test) del dominio privilegiado de release/deploy.

Este ADR adopta **diseño de confianza cero entre el control plane y el ejecutor**: el bearer OAuth por sí solo no es una credencial del runner. **Modelo de un solo dueño:** un host autenticado cuya identidad figure en `PANTER_OWNER_TRUSTED_HOSTS` es un principal administrativo de Panter y puede emitir sus propios grants acotados sin pedir a Zana una nueva confirmación por cada tarea o deploy; también puede hacerlo el operador autenticado en el socket Unix privado. El control plane valida esa identidad en servidor, emite y firma el grant; el runner solo acepta el grant firmado, dentro de su scope, vigencia y protección anti-replay. Ningún texto generado por el modelo —incluidos los informes de harness— es por sí mismo un grant o un recibo firmado. Las cinco identidades OAuth actuales continúan intactas; el runner no las administra. Este poder administrativo supone **un único dueño de todos los hosts confiables**, registro de nuevos clientes cerrado en el borde y riesgo aceptado de que el robo de un bearer de host confiable concede poder admin hasta su revocación (ver `docs/OAUTH_EMBEDDED.md` y `docs/ROADMAP.md`). **Sin `PANTER_OWNER_TRUSTED_HOSTS` rige el modo estricto:** solo el operador del socket privado puede emitir grants de administración y pueden exigirse confirmaciones humanas según la política de servicio.

## Límites de confianza y despliegue

```text
Host OAuth admin confiable / operador Unix → Panter MCP
                    │ ODD + grant acotado firmado por Panter
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
- Solo un componente de release con autorización por **política verificable por servicio** puede efectuar el reinicio de una unidad allowlisted. Para `panter-ai`, el principal administrador confiable puede solicitar release automáticamente si pasan todos los gates sin confirmación humana recurrente; servicios con impacto financiero (commerce, pagos) pueden requerir aprobación humana configurable. El runner de desarrollo no obtiene acceso a `/etc`, llaves SSH, tokens de GitHub, credenciales downstream, Docker socket, sockets Postgres/Redis ni al estado OAuth de producción.
- La lista de repos y raíces de checkout permitidas procede de configuración **fuera de Git, administrada por el operador**, vinculada a repositorio GitHub canónico y origen permitido. Soportar repos de Zana por política explícita; no admitir comodines globales.
- **Dos dominios criptográficos sin reutilización de claves.** (a) La clave privada Ed25519 de **firma de grants** reside bajo el servicio de control Panter en una ruta privada fuera de worktrees y del contexto de modelos; la clave pública se fija en la configuración del runner para verificar issuer/audience. Solo código de autorización en Panter puede firmar tras comprobar un principal administrativo válido. (b) `panter-review` y la clave de **atestación Ed25519 de revisiones** están aislados de quien implementa y del firmante de grants; `PANTER_RDD_RUNNER_KEYS_FILE` solo expone claves públicas de revisión y las reglas locales viven fuera de Git. Un grant de Panter nunca se acepta como firma 4R. La fase 3 concretará esta segunda separación.

## Protocolo de tareas y grants

El socket recibe operaciones tipadas con versionado `panter.runner/v1`; **no** hay operación `exec(command)` ni cadenas de shell. Las operaciones iniciales previstas son `workspace.prepare`, `git.inspect`, `build.install`, `build.check`, `build.compile`, `test.run`, `git.diff`, `workspace.cleanup` y `release.request`. Respuestas: `run_id`, `task_id`, `lease_generation`, `operation`, `status`, `exit_code` limitado, digest de salida y punteros de evidencia sin secretos. Limitar solicitud/respuesta, cuota, tiempo y bytes de log.

Cada operación exige un **grant Ed25519 firmado por Panter** tras autenticar a un principal admin (operador del socket o host OAuth listado en `PANTER_OWNER_TRUSTED_HOSTS`), comprobado **dentro del runner** y no solo en Panter: `grant_id`, `issuer`, `audience`, `subject`, `mission_id`, `work_id`, `attempt_id`, `lease_generation`, `repository`, `candidate_sha` o ref permitido, conjunto de operaciones, rutas relativas, clasificación de efecto, `not_before`, `expires_at`, `max_uses`, límites de recursos y nonce. El runner valida firma, key id/pinning y algoritmo esperado, emisor, destinatario, identidad, scope y SHA del grant firmado con la clave **pública** de Panter. La clave privada del firmante no está disponible ni para el runner ni para los worktrees. Jamás confiar en un UUID, en un bearer presentado al socket o en una afirmación del modelo sin grant verificable. Registrar el consumo en almacenamiento transaccional para impedir replay. Grants vencidos, revocados, reutilizados, con SHA/actor/proyecto distintos o scopes superpuestos incompatibles fallan cerrados.

El trabajo en cola no concede permisos. Cada claim adquiere un lease *fenced*; antes de abrir archivos o producir efectos se comprueba su generación y su vigencia. El operador puede revocar el grant, detener el cgroup y poner la tarea en cuarentena. Una expiración de lease **no mata por sí sola** el proceso: no liberar scopes hasta comprobar terminación y revisar efectos conforme a `UNCERTAIN_WRITER_RECOVERY.md`.

## Worktrees y comandos permitidos

1. Preparar checkout en una raíz privada por `mission/work/attempt`, a partir de SHA remoto verificado y repositorio autorizado. Usar `git worktree add --detach` en un mirror administrado por el runner. Validar `realpath`, `O_NOFOLLOW`/equivalentes, tipos de entrada y pertenencia de rutas después de operaciones de Git; rechazar traversal, symlinks fuera de raíz, submódulos no aprobados y hooks arbitrarios. No reutilizar el mismo worktree entre tareas.
2. Todas las ejecuciones toman un descriptor tipado, no `sh -c`, `bash -c`, `eval`, PTY, redirecciones, variables de entorno del usuario ni argumentos concatenados. Definir una matriz exacta por operación de **binario absoluto, subcomando, opciones, argumentos y cwd**, con rechazado por defecto. La mera allowlist de binarios no es suficiente.
3. `npm ci`, `npm run build`, `npm test` y cualquier script de repositorio **pueden ejecutar código arbitrario** aun cuando `npm` esté permitido. Ejecutarlos únicamente dentro de una sandbox rootless/desechable con UID no privilegiado, filesystem limitado al worktree, sin secretos ni sockets del host, límites CPU/RAM/tiempo/procesos y sin red por defecto. El paso que requiera registro npm accede solo al destino aprobado durante bootstrap, nunca a endpoints arbitrarios.
4. Separar claramente lectura, escritura de worktree y ejecución de efectos externos. Push, merge, publicación de paquetes, Cloudflare, comercio, migración de datos y despliegue no son permisos implícitos de `build`. Cada uno requiere una operación, grant de alcance/TTL específicos y auditoría; **un host administrativo confiable puede autorizar la operación sin intervención humana por efecto**. La confirmación humana es una regla **opcional, por servicio y categoría de efecto**, obligatoria donde la política así lo exija (p. ej. comercio/pagos), no un gate general de todos los commits o deployments. Integraciones downstream de la fase 4 mantienen su propio gate de escritura.
5. Ningún comando tiene acceso a la rama `main` para escribir. El responsable usa `gh-main` mediante flujo autorizado; la cuenta `gh-review` no se expone al runner implementador. Revisiones ocurren en ejecución distinta de la que editó código, sobre SHA exacto.

## Ruta de despliegue separada

`release.request` no reinicia nada directamente. El controlador de release verifica automáticamente: repositorio/servicio allowlisted; SHA **mergeado en `main`**, CI requerido verde para el SHA objetivo exacto, revisión GitHub independiente aprobatoria y válida vinculada al candidato y su merge, atestaciones Panter-RDD cuando sean exigibles, grant de release firmado y vigente, backup previo correcto, ventana permitida y plan de rollback. **Para `panter-ai` en modo de un solo dueño, estos gates suficientes autorizan el despliegue sin esperar una confirmación humana adicional.** Confirmación humana solo si la política de ese servicio/efecto la exige; por defecto para rutas de commerce/pagos es obligatoria hasta una aprobación explícita de su política. Sin `PANTER_OWNER_TRUSTED_HOSTS`, la emisión de grants vuelve a requerir operador por socket privado. Descarga tarball del SHA exacto, instala release nuevo, ejecuta pruebas en sandbox, realiza **backup consistente de `data/` (incluido SQLite por API de backup/VACUUM INTO) y `etc/`** sin exponer contenido, cambia symlink atómicamente y reinicia **solo** la unidad autorizada. Comprueba `/health`, OAuth discovery, 401 sin bearer, cinco clientes OAuth y datos funcionales. Conserva release/backup para rollback y registra evidencia. No inventar reinicio, firma ni CI a partir de respuesta de modelo.

El controlador privilegiado de despliegue opera mediante una interfaz fija, sin `sudo` genérico para `panter-runner`. Una **política de servicios versionada y mantenida fuera de los worktrees** asocia cada `service_id` a repositorio, rama, unidad systemd, rutas release/data/backup, checks, comandos fijos permitidos y requisito de confirmación humana. Agregar `plasticov-storefront`, `plasticov-backend` o `commerce-mcp` exige un PR/política específica y revisión del nuevo alcance; no permite que un grant de `panter-ai` reinicie otras unidades ni que el runner gane privilegios genéricos. Sin servicio allowlisted, denegar. En caso de validación fallida o efectos desconocidos, detener y exigir reconciliación antes de reintentar. La gestión actual de respaldo nocturno queda fuera del alcance de este PR.

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
5. **Release controlado:** ensayo en servicio de prueba con CI/SHA exactos, backup/restore SQLite, fallo provocado y rollback, sin reiniciar otros servicios. Habilitar release real tras superar gates técnicos y pruebas E2E, con ejecución automática para servicios que lo autoricen (inicialmente `panter-ai`) y confirmación humana únicamente para servicios/efectos cuya política la requiera.
6. **Capacidades HostOps fuera de este ADR:** navegador y perfiles persistentes `plasticov`/`maustian` (incluido Product Ads de Mercado Libre), automatización de PC y manejo de perfiles/cookies **no pasan** al runner de Git/build. La operación de PC queda en `controlmcp` únicamente donde sus herramientas y autorizaciones existentes lo permitan; navegador con perfiles comerciales necesitará un ADR, aislamiento y pruebas propios de fase 4 o posterior. Hasta entonces permanecen en Xanxittoo cuando sean imprescindibles, sin declarar retirada completa ni copiar sus secretos al runner.
7. **Retirada de HostOps:** solo después de que Panter cubra trabajo de repositorios, downstream, navegador y PC por vías explícitamente aprobadas, y de dos semanas de operación paralela sin regresiones; Xanxittoo no se apaga en este ADR.

**Condición de aceptación:** cada paso deberá tener PR propio, CI verde, revisión independiente sobre SHA exacto y evidencia real de seguridad y operación. Este ADR no declara implementado ni listo para producción el runner.
