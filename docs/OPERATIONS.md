# Operación de Panter-ai en producción

Producción corre en la VM de Oracle (`zana-main`) como servicio `systemd --user`, detrás de un túnel de Cloudflare. Este documento cubre el despliegue, los backups y el healthcheck.

## Estructura

```
~/panter-ai/
  current -> releases/<sha7>   release activo (symlink)
  releases/<sha7>/             cada release: código + REVISION + node_modules + dist
  releases/<sha7>.{ci,build,test}.log
  etc/panter.env               configuración (secretos; nunca en Git)
  etc/ops.env                  opcional: PANTER_ALERT_WEBHOOK para avisos
  etc/maintenance              si existe, el healthcheck no hace nada (mantención)
  data/panter.sqlite           estado (ledgers SQLite WAL)
  backups/pre-<sha7>-<fecha>/  backup antes de cada deploy (no se borra solo)
  backups/daily-<fecha>/       backup diario (se guardan 14)
  bin/run                      lanzador (lee el token de GitHub desde gh)
```

## Desplegar

Solo se despliegan commits que ya estén en `main` (mergeados con CI verde y aprobación de la cuenta revisora):

```sh
PANTER_SOURCE_REPO=<clon del repo> ~/panter-ai/current/deploy/deploy.sh <sha completo de 40 caracteres>
```

El script:
1. Toma un lock (no corren dos deploys a la vez) y comprueba que el SHA exista y esté en `origin/main`.
2. Lo extrae en su propio `releases/<sha7>` y escribe ahí `REVISION`.
3. Corre `npm ci`, `npm run build` y `npm test` con un entorno limpio (sin las variables `PANTER_*` de producción). Si algo falla, no cambia nada y borra ese release; el mismo commit se puede reintentar.
4. Hace el backup `pre-<sha7>-<fecha>-<pid>`.
5. Cambia `current`, reinicia el servicio y espera hasta un minuto (20 intentos) a que `/health` reporte **ese mismo SHA** en `revision`.
6. Si no responde, **vuelve solo al release anterior**, lo reinicia y comprueba que responda. Si el anterior tampoco responde, lo avisa con `ROLLBACK FAILED`. El release malo se borra.
7. Deja los 3 releases más nuevos (siempre el activo y el anterior, aunque `current` se haya escrito a mano con ruta absoluta) y borra el resto.

El rollback automático es del código. Los datos no se devuelven solos: si un release cambió el estado, se restauran a mano desde el backup `pre-…` (ver más abajo).

`/health` responde `{"status":"ok","name":"panter-ai","version":"<package.json>","revision":"<sha>"}`. `revision` es `null` en releases instalados sin `deploy.sh`.

## Backups

`deploy/backup.mjs` copia en línea el SQLite (una copia consistente aunque el servicio esté escribiendo), `etc/panter.env` y todos los `data/*.json` (las revisiones nativas y Panter-RDD todavía guardan su estado ahí), con permisos 0700/0600. Después **prueba la restauración**: abre en otro lugar una copia del backup, corre `integrity_check` y compara cada ledger con el backup. La huella de cada ledger se calcula sobre el backup mismo, así que las escrituras en vivo no hacen fallar el chequeo. Si algo falla, no deja un backup a medias ni la copia temporal. Requiere Node 22.16 o más.

- Antes de cada deploy: `--label pre-<sha7>-<fecha> --release <sha>` (nunca se sobrescribe).
- Diario: `--daily --keep-daily 14` desde `panter-backup.timer`. Si ya se tomó el del día, lo salta; si quedó a medias, lo rehace. Solo borra diarios viejos, nunca backups de deploy.

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

## Healthcheck

`panter-healthcheck.timer` corre `deploy/healthcheck.sh` cada 5 minutos. Con dos fallos seguidos de `/health`, reinicia `panter-ai.service`. Mientras exista `etc/maintenance` no hace nada. Si `etc/ops.env` define `PANTER_ALERT_WEBHOOK`, avisa ahí en cada fallo; el JSON incluye `text` y `content`, así que sirve para webhooks de Slack o Discord.

## Instalar los timers

```sh
cp ~/panter-ai/current/deploy/systemd/panter-{backup,healthcheck}.{service,timer} ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now panter-backup.timer panter-healthcheck.timer
systemctl --user list-timers
```

Los timers llaman a los scripts a través de `current`, así que cada deploy los actualiza sin reinstalar.
