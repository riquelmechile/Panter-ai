# Operación de Panter-ai en producción

El despliegue de referencia corre en una VM Linux como servicio `systemd --user`, detrás de un túnel de Cloudflare. Este documento cubre el despliegue, los backups y el healthcheck.

## Estructura

```
~/panter-ai/
  current -> releases/<sha7>   release activo (symlink)
  releases/<sha7>/             cada release: código + REVISION + node_modules + dist
  releases/<sha7>.{ci,build,test}.log
  etc/panter.env               configuración (secretos; nunca en Git)
  etc/ops.env                  opcional: PANTER_ALERT_WEBHOOK para avisos
  etc/maintenance              si existe: el healthcheck no hace nada, deploy.sh se niega y el backup diario se salta
  etc/quiesce                  lo crean deploy.sh y el backup diario mientras detienen el servicio
  releases/.deploy.lock        lock compartido por deploy.sh y el backup diario
  data/panter.sqlite           estado (ledgers SQLite WAL)
  backups/pre-<sha7>-<fecha>-<pid>/  backup antes de cada deploy (no se borra solo)
  backups/daily-<fecha>/       backup diario (se guardan 14)
  bin/run                      lanzador (lee el token de GitHub desde gh)
```

## Desplegar

Solo se despliegan commits que ya estén en `main` (mergeados con CI verde y aprobación de la cuenta revisora):

```sh
PANTER_SOURCE_REPO=<clon del repo> ~/panter-ai/current/deploy/deploy.sh <sha completo de 40 caracteres>
```

La primera vez (cuando el release activo todavía no trae `deploy/`), se corre el script del clon: `PANTER_SOURCE_REPO=<clon> <clon>/deploy/deploy.sh <sha>`. Debe correr en una shell que llegue al bus de usuario de systemd (`systemctl --user status panter-ai` tiene que funcionar ahí); si no, el `stop` falla y el script termina sin tocar el servicio. Conviene correrlo dentro de tmux, para poder ver cómo termina. Si igual se corta la sesión, el script no deja nada detenido: si estaba en el backup, vuelve a levantar el release actual; si estaba esperando `/health` del release nuevo, vuelve al anterior; si estaba en el rollback, lo termina. `current` tiene que ser un symlink a `releases/<dir>` (o no existir); si es un directorio real, el script se niega.

El script:
1. Toma un lock (no corren dos deploys a la vez) y comprueba que el SHA exista y esté en `origin/main`.
2. Lo extrae en su propio `releases/<sha7>` y escribe ahí `REVISION`.
3. Corre `npm ci`, `npm run build` y `npm test` con un entorno limpio (sin las variables `PANTER_*` de producción). Si algo falla, no cambia nada y borra ese release; el mismo commit se puede reintentar.
4. Detiene el servicio y hace el backup `pre-<sha7>-<fecha>-<pid>` con `--stopped` (los JSON solo quedan consistentes con el servicio detenido; son unos segundos y el reinicio igual lo iba a cortar), con un máximo de 10 minutos (si no termina, se mata a los 30 segundos más). Si el backup falla, vuelve a levantar el release actual sin cambiar nada. Desde el `stop` hasta que el servicio vuelve a arrancar, cualquier salida (un error, Ctrl-C, una señal) lo levanta de nuevo: producción nunca queda detenida.
5. Cambia `current`, levanta el servicio y espera hasta un minuto (20 intentos) a que `/health` reporte **ese mismo SHA** en `revision`.
6. Si no responde, **vuelve solo al release anterior** (`current` apunta de nuevo a él), lo reinicia, comprueba que responda y borra el release malo. Si el anterior tampoco responde, avisa con `ROLLBACK FAILED`: `current` queda en el anterior, pero el directorio del release nuevo no se borra (puede ser el único que corre con los datos actuales). Si no había release anterior, avisa con `ROLLBACK IMPOSSIBLE` y el nuevo queda activo.
7. Deja los 3 releases más nuevos (siempre el activo y el anterior, aunque `current` se haya escrito a mano con ruta absoluta) y borra el resto. Solo toca directorios con nombre de 7 hex.

El rollback automático es del código. Los datos no se devuelven solos: si un release cambió el estado, se restauran a mano desde el backup `pre-…` (ver más abajo).

`/health` responde `{"status":"ok","name":"panter-ai","version":"<package.json>","revision":"<sha>"}`. `revision` es `null` en releases instalados sin `deploy.sh`.

## Backups

`deploy/backup.mjs` copia el SQLite, `etc/panter.env` y todos los `data/*.json` (las revisiones nativas y Panter-RDD todavía guardan su estado ahí), con permisos 0700/0600. La copia del SQLite es consistente aunque el servicio esté escribiendo, pero los JSON solo son consistentes entre sí y con el ledger con el servicio **detenido**: por eso el deploy y el backup diario lo detienen unos segundos y pasan `--stopped`. El manifest anota `consistency` (`service stopped` u `online: …`). Después **prueba la restauración**: abre en otro lugar una copia del backup, corre `integrity_check` y compara cada ledger con el backup. La huella de cada ledger se calcula sobre el backup mismo, así que las escrituras en vivo no hacen fallar el chequeo. Si algo falla, no deja un backup a medias ni la copia temporal. Requiere Node 22.16 o más.

- Antes de cada deploy: `--label pre-<sha7>-<fecha>-<pid> --release <sha> --stopped` (nunca se sobrescribe).
- Diario: `panter-backup.timer` corre `deploy/daily-backup.sh`, que espera el lock de deploy, detiene el servicio (solo si estaba corriendo), hace `--daily --keep-daily 14 --stopped` (máximo 10 minutos; la unit tiene `TimeoutStartSec=30min`) y lo vuelve a levantar, también si lo interrumpen. Si existe `etc/maintenance`, ese día no hace backup. Si ya se tomó el del día, lo salta; si quedó a medias, lo rehace. Solo borra diarios viejos, nunca backups de deploy.

### Restaurar

```sh
touch ~/panter-ai/etc/maintenance            # el healthcheck no reinicia nada mientras tanto
systemctl --user stop panter-ai.service
B=~/panter-ai/backups/<backup>
cp -p $B/panter.sqlite ~/panter-ai/data/panter.sqlite
rm -f ~/panter-ai/data/panter.sqlite-wal ~/panter-ai/data/panter.sqlite-shm
for f in $B/*.json; do [ "$(basename $f)" = manifest.json ] || cp -p $f ~/panter-ai/data/; done
# si el release del backup era otro: ln -sfn releases/<sha7 del manifest> ~/panter-ai/current
systemctl --user start panter-ai.service
rm ~/panter-ai/etc/maintenance
```

`manifest.json` registra el release activo al momento del backup, la huella SHA-256 de cada ledger y los conteos de OAuth.

Las acciones de servidor (`docs/SERVER_ACTIONS.md`) guardan su autoridad en ese mismo `panter.sqlite`: el ledger `server_actions` (autorizaciones del operador y acciones) y la tabla `server_action_slots` (el cupo único). Por eso un backup contiene siempre los permisos del mesh y esa autoridad en la misma instantánea, la prueba de restauración compara también la tabla de cupos (`serverActionSlots` en el manifest) y restaurar no necesita pasos extra. Los archivos de `etc/actions/` (cercas, registros y logs de cada acción) no van en el backup: quedan en su lugar y nunca se borran.

### Habilitar acciones de servidor (apagado por defecto)

Con esto un trabajador, con un permiso de un solo uso que le entrega el líder, puede pedirle a Panter que ejecute `deploy/deploy.sh <sha>` por él. Panter no le da una shell ni otro comando: verifica el commit y lanza ese script, sin cambios, en una unidad transitoria de systemd. El diseño completo está en `docs/SERVER_ACTIONS.md`. Nada de esto ocurre mientras `PANTER_SERVER_ACTIONS` no esté definido.

1. **La release activa tiene que traer `deploy/run-action.sh`.** La unidad ejecuta el wrapper desde `current`, así que la primera release que lo contiene se despliega a mano, como siempre (`deploy/deploy.sh <sha>`). Si falta, Panter rechaza la acción con `SERVER_ACTIONS_UNAVAILABLE` antes de gastar el permiso.
2. **Variables en `panter.env`** (ver `deploy/panter.env.example`): `PANTER_SERVER_ACTIONS=deploy.commit`, `PANTER_SERVER_DEPLOY_REPOSITORY`, `PANTER_SERVER_DEPLOY_SOURCE` (el clon que usa `deploy.sh`), `PANTER_SERVER_DEPLOY_CHECKS` y `PANTER_GITHUB_INDEPENDENT_REVIEWER`. Si `deploy.sh` necesita `PANTER_UNIT`, `PANTER_HEALTH_URL` o `PANTER_KEEP_RELEASES`, defínalas ahí también: Panter le pasa a la unidad solo esas tres, además de `PANTER_SOURCE_REPO`, `PANTER_BASE` y el `PATH`.
3. **Autorización del operador.** Por release, con `panter_server_authorize` desde el principal operador, o permanente con `PANTER_SERVER_DEPLOY_STANDING_AUTHORIZATION=1`. Habilitar las acciones no autoriza ningún despliegue por sí solo.
4. **Probar primero en seco.** Con `PANTER_SERVER_DEPLOY_DRY_RUN=1` Panter recorre todas las verificaciones, gasta el permiso, reserva la acción y termina en `DRY_RUN` sin lanzar nada. Sirve para confirmar la configuración (repositorio, checks, cuenta revisora) con un commit real. Quite la variable para que las acciones se ejecuten.
5. Reinicie Panter. Al arrancar crea `etc/actions` (modo 0700) si no existe.

Cada acción deja en `etc/actions/` tres archivos con su id: la cerca (`.fence`), el registro que escribe el wrapper (`.json`) y la salida de `deploy.sh` (`.log`). El estado, quién la pidió y con qué permiso, cada verificación y el resultado se ven con `panter_server_status`; al terminar, el líder y el trabajador reciben un mensaje en su inbox.

Como el despliegue reinicia Panter, quien pidió la acción pierde la conexión a mitad de camino. Es lo esperado: la unidad sigue corriendo, y el Panter que vuelve a arrancar lee el registro del wrapper, cierra la acción y envía los avisos.

**Si una acción termina en `UNKNOWN`** Panter no pudo explicar lo que encontró (por ejemplo, la unidad terminó sin dejar un registro final, o el registro no calza con la acción). No reintenta nada. Mire `/health` para saber qué commit está activo, lea `etc/actions/<id>.log` y `journalctl --user -u panter-action-<id>`, y decida a mano. El cupo queda libre: la siguiente acción no está bloqueada. `ABANDONED` y `START_FAILED` significan que el despliegue nunca empezó (la cerca quedó en `closed`).

## Healthcheck

`panter-healthcheck.timer` corre `deploy/healthcheck.sh` cada 5 minutos. Con dos fallos seguidos de `/health`, reinicia `panter-ai.service`. Mientras exista `etc/maintenance` no hace nada; tampoco mientras exista `etc/quiesce` (lo crean el deploy y el backup diario mientras detienen el servicio; si tiene más de 30 minutos se ignora). Si `etc/ops.env` define `PANTER_ALERT_WEBHOOK`, avisa ahí en cada fallo; el JSON incluye `text` y `content`, así que sirve para webhooks de Slack o Discord.

## Instalar los timers

Los timers corren los scripts de `current/deploy/`, así que siguen al release activo. Si se vuelve a un release anterior a estos scripts, dejan de correr hasta el siguiente deploy.

```sh
cp ~/panter-ai/current/deploy/systemd/panter-{backup,healthcheck}.{service,timer} ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now panter-backup.timer panter-healthcheck.timer
systemctl --user list-timers
```

Los timers llaman a los scripts a través de `current`, así que cada deploy los actualiza sin reinstalar.
