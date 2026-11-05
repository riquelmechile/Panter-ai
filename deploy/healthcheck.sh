#!/usr/bin/env bash
# Run by panter-healthcheck.timer: restart the service after two failed /health checks in a row, and post to an
# optional alert webhook (PANTER_ALERT_WEBHOOK, e.g. a Slack/Discord-compatible incoming webhook) on every failure.
# While $PANTER_BASE/etc/maintenance exists (e.g. during a restore) it does nothing; nor while etc/quiesce is fresh.
set -uo pipefail
BASE=${PANTER_BASE:-$HOME/panter-ai}
HEALTH=${PANTER_HEALTH_URL:-http://127.0.0.1:18080/health}
UNIT=${PANTER_UNIT:-panter-ai.service}
[ -e "$BASE/etc/maintenance" ] && exit 0
# A deploy or the daily backup stopped the service on purpose (a marker older than 30 minutes is stale and ignored).
[ -n "$(find "$BASE/etc/quiesce" -mmin -30 2>/dev/null)" ] && exit 0
STATE_DIR=${XDG_RUNTIME_DIR:-$BASE/etc}
STATE="$STATE_DIR/panter-healthcheck.failures"
if curl -fsS --max-time 5 "$HEALTH" 2>/dev/null | grep -q '"status":"ok"'; then rm -f "$STATE"; exit 0; fi
prev=$(cat "$STATE" 2>/dev/null || true)
[[ $prev =~ ^[0-9]{1,6}$ ]] || prev=0
n=$((prev + 1))
echo "$n" > "$STATE"
msg="Panter health check failed ($n in a row)"
if [ "$n" -ge 2 ]; then
  systemctl --user reset-failed "$UNIT" >/dev/null 2>&1 || true
  systemctl --user restart "$UNIT" && msg="$msg; restarted $UNIT"
  echo 0 > "$STATE"
fi
echo "$msg" >&2
if [ -n "${PANTER_ALERT_WEBHOOK:-}" ]; then
  safe=${msg//[^A-Za-z0-9 ();.,_-]/}
  curl -fsS --max-time 5 -X POST -H 'content-type: application/json' --data "{\"text\":\"$safe\",\"content\":\"$safe\"}" "$PANTER_ALERT_WEBHOOK" >/dev/null 2>&1 || true
fi
exit 1
