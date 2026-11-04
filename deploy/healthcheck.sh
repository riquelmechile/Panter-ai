#!/usr/bin/env bash
# Run by panter-healthcheck.timer: restart the service after two failed /health checks in a row, and post to an
# optional alert webhook (PANTER_ALERT_WEBHOOK, e.g. a Slack/Discord-compatible incoming webhook) on every failure.
set -uo pipefail
HEALTH=${PANTER_HEALTH_URL:-http://127.0.0.1:18080/health}
UNIT=${PANTER_UNIT:-panter-ai.service}
STATE=${XDG_RUNTIME_DIR:-/tmp}/panter-healthcheck.failures
if curl -fsS --max-time 5 "$HEALTH" 2>/dev/null | grep -q '"status":"ok"'; then rm -f "$STATE"; exit 0; fi
n=$(( $(cat "$STATE" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$STATE"
msg="Panter health check failed ($n in a row) on $(hostname)"
if [ "$n" -ge 2 ]; then systemctl --user restart "$UNIT" && msg="$msg; restarted $UNIT"; echo 0 > "$STATE"; fi
echo "$msg" >&2
if [ -n "${PANTER_ALERT_WEBHOOK:-}" ]; then
  curl -fsS --max-time 5 -X POST -H 'content-type: application/json' --data "{\"text\":\"$msg\",\"content\":\"$msg\"}" "$PANTER_ALERT_WEBHOOK" >/dev/null 2>&1 || true
fi
exit 1
