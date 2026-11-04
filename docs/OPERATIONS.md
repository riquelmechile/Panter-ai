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
1. Comprueba que el SHA exista y esté en `origin/main`.
2. Lo extrae en su propio `releases/<sha7>` y escribe ahí `REVISION`.
3. Corre `npm ci`, `npm run build` y `npm test`. Si algo falla, no cambia nada.
4. Hace el backup `pre-<sha7>-<fecha>`.
5. Cambia `current`, reinicia el servicio y espera a que `/health` reporte **ese mismo SHA** en `revision`.
6. Si no responde en unos 60 segundos, **vuelve solo al release anterior** y termina con error.
7. Deja los 3 releases más nuevos (siempre el activo y el anterior) y borra el resto.

El rollback automático es del código. Los datos no se devuelven solos: si un release cambió el estado, se restauran a mano desde el backup `pre-…` (ver más abajo).

`/health` responde `{"status":"ok","name":"panter-ai","version":"<package.json>","revision":"<sha>"}`. `revision` es `null` en releases instalados sin `deploy.sh`.

## Backups

`deploy/backup.mjs` copia en línea el SQLite (copia consistente sin detener el servicio), `etc/panter.env` y el estado JSON antiguo si existe, con permisos 0700/0600. Después **prueba la restauración**: abre una copia del backup en otro lugar, corre `integrity_check` y compara cada ledger con el original. Si algo falla, no deja un backup a medias.

- Antes de cada deploy: `--label pre-<sha7>-<fecha> --release <sha>` (nunca se sobrescribe).
- Diario: `--daily --keep-daily 14` desde `panter-backup.timer`. Si ya se tomó el del día, lo salta; si quedó a medias, lo rehace. Solo borra diarios viejos, nunca backups de deploy.

### Restaurar

```sh
systemctl --user stop panter-ai.service
cp -p ~/panter-ai/backups/<backup>/panter.sqlite ~/panter-ai/data/panter.sqlite
rm -f ~/panter-ai/data/panter.sqlite-wal ~/panter-ai/data/panter.sqlite-shm
# si el release del backup era otro: ln -sfn releases/<sha7 del manifest> ~/panter-ai/current
systemctl --user start panter-ai.service
```

`manifest.json` registra el release activo al momento del backup, la huella SHA-256 de cada ledger y los conteos de OAuth.

## Healthcheck

`panter-healthcheck.timer` corre `deploy/healthcheck.sh` cada 5 minutos. Con dos fallos seguidos de `/health`, reinicia `panter-ai.service`. Si `etc/ops.env` define `PANTER_ALERT_WEBHOOK`, avisa ahí en cada fallo; el JSON incluye `text` y `content`, así que sirve para webhooks de Slack o Discord.

## Instalar los timers

```sh
cp ~/panter-ai/current/deploy/systemd/panter-{backup,healthcheck}.{service,timer} ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now panter-backup.timer panter-healthcheck.timer
systemctl --user list-timers
```

Los timers llaman a los scripts a través de `current`, así que cada deploy los actualiza sin reinstalar.
