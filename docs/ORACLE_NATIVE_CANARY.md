# Canary nativo privado — systemd --user

## Alcance, autoridad y estado

Runbook de **canary privado**, sin Docker/Podman, proxy, túnel, reglas de firewall ni exposición externa. El servicio `panter-ai` es independiente de los servicios existentes. Las operaciones sobre otra unidad, puertos ya ocupados o archivos ajenos al directorio de Panter están fuera de alcance. No autoriza merge ni publicación.

**Estado de la ejecución registrada (30-oct-2026):** canary **en ejecución y validado** sobre el release `f6580088fb4a979031d0a3b4f5c4bac43b3f4679`.

| Prueba | Resultado |
| --- | --- |
| Release | `npm ci`, `check`, `build`, `test` y los tres smokes en verde |
| Secretos | generados en el host sin pasar por stdout, argumentos ni logs; `etc/panter.env` y `etc/operator.token` en `0600` |
| 4a | unidad activa; único listener nuevo en loopback del puerto reservado |
| 4b | `/health` 200 con `name=panter-ai` |
| 4c | `/mcp` sin credenciales 401; token del operador **por TCP** 401 |
| 4d | `data/` `0700`, socket `0600`; por socket token válido 200 (`tools/list` incluye `panter_oauth_clients` y `panter_oauth_client_revoke`), token erróneo 401 |
| 4e | flujo OAuth completo (DCR → PKCE S256 → consentimiento con clave de operador → código → token): `/mcp` 200; tras reiniciar, el token sigue válido; `panter_oauth_client_revoke` revoca el grant y el mismo token pasa a 401, cliente `revoked: true` |
| 4f | `kill -9` al proceso de Panter: `Restart=on-failure` lo levanta en ~1 s, socket recuperado |
| Backup | `tar.gz` de `data/` en `0600` con digest SHA-256 (solo en el informe privado) |
| Restauración | instancia temporal en otro puerto de loopback con datos y socket propios: `/health` 200, cliente revocado sigue revocado y el token sigue en 401; instancia cancelada y temporales borrados |
| Rollback | `stop` libera el puerto; `start` vuelve a `/health` 200 |
| Foto final | procesos y PID de los servicios preexistentes intactos, hashes de configuración del proxy idénticos; único listener nuevo el del canary |

**Pendiente del responsable:** `host.system.service enable` (arranque automático tras reiniciar la VM) no se ejecutó: requiere autorización explícita. Mientras tanto, el canary corre pero no sobrevive a un reinicio del host.

Nota operativa: al probar con `curl`, pasar los Bearer con `-H @archivo` (archivo `0600`, borrado al terminar), nunca en la línea de comandos, porque los argumentos son visibles para otros procesos del mismo usuario.

La autorización de operaciones es acotada al canary y debe reevaluarse si cambia el SHA o el alcance. Para nuevos intentos, el operador debe verificar que la unidad sigue inactiva y los puertos de pruebas siguen libres.

## Por qué nativo y no Compose

El host del operador cuenta con Node y npm sobre ARM64 y **no** tiene Docker ni Podman. Este canary utiliza Node directamente y un servicio **systemd --user** con sesión persistente (*linger*). Esta arquitectura **se desvía explícitamente** del runbook de Compose y reduce el aislamiento disponible: no implica que las garantías de la imagen de contenedor estén probadas por el servicio nativo.

No usar `systemctl` por ejecución genérica: el host expone exclusivamente la acción estructurada `host.system.service` para unidades de usuario. `systemd-run` no está disponible. No usar `sudo` para administrar este servicio; la cuenta dedicada y la unidad de sistema quedan pendientes.

## Disposición de archivos y liberaciones inmutables

Rutas del tipo `<home del usuario de servicio>/panter-ai` (en unidades systemd de usuario se usa `%h/panter-ai`):

| Ruta relativa al directorio `panter-ai` | Función |
| --- | --- |
| `releases/<sha>` | Árbol del release fijado por SHA; no editar el código desplegado |
| `current` | Enlace simbólico a la liberación activa |
| `data/` | Datos persistentes y socket de administración |
| `backups/` | Copias de datos, fuera del árbol de código |
| `bin/run` | Lanzador estable que ejecuta `node current/dist/server.js` |
| `etc/panter.env` | Entorno confidencial, nunca versionado |
| `etc/operator.token` | Token administrativo protegido, nunca versionado |

Crear los directorios privados con permisos `0700`. El lanzador es ejecutable y no contiene secretos. El entorno y el archivo del token deben ser `0600`. No adjuntar archivos de datos, token, configuración privada, snapshots o backups a issues, CI ni PRs.

## Preflight y release

1. Tomar una foto **antes** de procesos existentes (identificador y comando), listeners y huellas SHA-256 de los archivos de configuración de proxy. Guardar la evidencia en el entorno privado, no en Git. Verificar que el puerto del canary y el de restauración temporal no estén ocupados. Si están ocupados, **detenerse sin desalojarlos**.
2. Leer por API de GitHub el SHA de `main` y comprobar que coincide exactamente con la revisión autorizada. Exigir checks `test` y `arm64-image` exitosos **para ese mismo SHA**.
3. Descargar el tarball público del commit fijado desde GitHub/codeload, sin credenciales; extraerlo dentro de `releases/<sha>`, nunca sobre `current`. Confirmar la identidad del release antes de activarlo.
4. Ejecutar desde el release `npm ci`, `npm run check`, `npm run build`, `npm test`, `npm run smoke:http`, `npm run smoke:oauth` y `npm run smoke:embedded`. Todas las salidas deben ser exitosas.
5. Preparar `current` como enlace al release. Generar **localmente** dos secretos aleatorios diferentes, cada uno de al menos 48 caracteres, sin mostrar el valor en stdout, historial, argumentos, trazas, issues ni logs. Proteger `etc/panter.env` y `etc/operator.token` con `0600`. Validar la configuración contra `deploy/panter.env.example`; no declarar un archivo vacío o de ejemplo como configuración válida.
6. Configurar únicamente autenticación embedded, bind en loopback, lista de Host permitidos local, URL pública **ficticia y no enrutable**, callbacks OAuth aprobados, directorio de datos privado, socket de administración y política de repositorio/revisor. La lista de proxies confiables es vacía, Engram está apagado y **no** se configura token de GitHub para el repositorio público.

## Servicio de usuario

Copiar y adaptar `deploy/systemd/panter-ai.service` como unidad de usuario, **antes del primer arranque**, y crear `bin/run` con `exec /usr/bin/node <home del usuario de servicio>/panter-ai/current/dist/server.js` usando ruta absoluta real. `run` debe tener permiso `0700`.

Con `host.system.service` habilitar y luego iniciar **solo** `panter-ai.service`. Los límites `MemoryMax=1G` y `TasksMax=128` son obligatorios en este canary. Si la unidad no arranca o alguno de ellos falla, detenerse: no editar a ciegas la unidad, pues el host no proporciona `daemon-reload`. No utilizar `systemctl` a través de shell genérico ni tocar otro servicio.

## Pruebas obligatorias, con evidencia mínima

| ID | Verificación | Criterio |
| --- | --- | --- |
| 4a | Estado y listener | Unidad active; **un solo listener nuevo**, en loopback del puerto reservado |
| 4b | Salud HTTP | `GET /health`: HTTP 200 y JSON `name=panter-ai` |
| 4c | Aislamiento TCP | `POST /mcp` sin credenciales: 401; también 401 usando token del operador **por TCP** |
| 4d | Socket privado | `data/` es 0700; `operator.sock` es 0600 y del usuario del servicio; MCP `initialize` y `tools/list` por socket con token válido: 200, herramienta `panter_oauth_clients` presente; token erróneo: 401 |
| 4e | Persistencia y revocación | DCR `POST /register` con callback permitido; reiniciar solo Panter; cliente persiste en `panter_oauth_clients`; revocar con `panter_oauth_client_revoke` y confirmar estado revocado |
| 4f | Reinicio abrupto | Obtener PID **solo** del proceso Node de Panter; `kill -9` exclusivamente a ese PID; esperar a `Restart=on-failure` o iniciar con `host.system.service`; socket y salud vuelven a estar disponibles |

Los mensajes MCP deben usar el formato de protocolo y cabeceras adecuados. Nunca registrar un Bearer real en la evidencia de pruebas. Si un paso devuelve algo inesperado, **detener y conservar únicamente trazas saneadas**.

## Backup y restauración aislada

1. Detener solo `panter-ai.service` mediante `host.system.service` con la confirmación destructiva exigida.
2. Crear en `backups/` un archivo comprimido `tar.gz` del directorio `data/`, permiso `0600`; calcular su huella usando `openssl dgst -sha256`. Conservar nombre y digest solo en el informe privado; no publicarlos en el PR.
3. Reiniciar exclusivamente Panter y verificar `/health`.
4. Extraer el backup en un directorio temporal `0700`; iniciar una segunda instancia con `host.process.start` y lanzador protegido que cargue el entorno local sin imprimir secretos. Sobrescribir únicamente puerto (libre y de loopback), directorio de datos temporal y socket temporal; **no reutilizar el socket ni los datos activos**.
5. Verificar que la instancia temporal responde a `/health` y que el cliente de DCR revocado sigue revocado. Cancelar exclusivamente la sesión de prueba con `host.process.cancel`, comprobar que su puerto quedó libre y borrar el directorio temporal. Si el host no puede iniciar el proceso o no permite cargar secretos de forma segura, detenerse en vez de imprimirlos o pasarlos a logs.

## Rollback y reversión

Para desactivar sin afectar otros servicios: `host.system.service stop` seguido de `disable` (con `CONFIRM_DESTRUCTIVE` cuando corresponda), comprobar que el listener desapareció; `enable` y `start` para recuperar y confirmar salud.

Para regresar de release: respaldar los datos antes del cambio; detener Panter; apuntar el symlink `current` a un release anterior **ya validado**, reiniciar y verificar los endpoints. Si el estado no es compatible, restaurar el backup correspondiente con el servicio detenido y verificar nuevamente. El lanzador estable evita editar la unidad al cambiar `current`.

## Comparación final y condiciones de detención

Repetir exactamente las mismas mediciones de procesos, listeners y hashes de configuración del preflight. Los procesos preexistentes deben conservar sus PID, sus hashes deben ser idénticos y el **único listener agregado** debe ser el del canary en loopback. Cualquier diferencia ajena a Panter exige detenerse y reportar, sin modificar servicios ajenos. Los PID/hashes reales son evidencia privada y nunca se comiten.

## Pendiente antes de exponer

- Migrar a un **usuario de sistema dedicado** sin login ni sudo, con unidad de sistema y permisos mínimos, separando estado y releases.
- Separar las credenciales `gh` del usuario del servicio y aislar la identidad `panter-review` del implementador.
- Preparar un proceso de `daemon-reload` realizado y controlado por un **humano**.
- Configurar un dominio y TLS, y únicamente entonces un proxy nginx o túnel con `X-Panter-Client-IP` verificado y `PANTER_TRUSTED_PROXY_CIDRS` restringido a los proxies reales. No reutilizar la configuración privada en una ruta pública.
- Verificar OAuth real extremo a extremo con ChatGPT y Claude, política de redirects, cookies, CSRF, revocación y límites de tráfico.
- Habilitar Engram solo con **su propio directorio de datos** y permisos apropiados, previa auditoría.
- Exigir evidencias de CI, revisión independiente de SHA exacto, snapshot final, restauración y rollback antes de proponer exposición. La aprobación del issue y la decisión de merge corresponden al responsable.

La preparación documental no constituye validación operativa ni autorización de publicación.
