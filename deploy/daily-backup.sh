#!/usr/bin/env bash
# Run by panter-backup.timer: the daily backup, taken with the service stopped for a few seconds, because the JSON
# stores are only consistent while it is stopped. Waits for a running deploy (same lock), and starts the service
# again only if it was running before.
set -euo pipefail
BASE=${PANTER_BASE:-$HOME/panter-ai}
UNIT=${PANTER_UNIT:-panter-ai.service}
KEEP=${PANTER_KEEP_DAILY:-14}
mkdir -p "$BASE/releases" "$BASE/etc"
exec 9>"$BASE/releases/.deploy.lock"
flock -w 900 9 || { echo "backup: a deploy kept the lock for 15 minutes" >&2; exit 1; }
was_active=no
systemctl --user is-active --quiet "$UNIT" && was_active=yes
touch "$BASE/etc/quiesce"
finish() {
  if [ "$was_active" = yes ]; then systemctl --user reset-failed "$UNIT" >/dev/null 2>&1 || true; systemctl --user start "$UNIT" || true; fi
  rm -f "$BASE/etc/quiesce"
}
trap finish EXIT
[ "$was_active" = yes ] && systemctl --user stop "$UNIT"
node "$BASE/current/deploy/backup.mjs" --base "$BASE" --daily --keep-daily "$KEEP" --stopped
