#!/usr/bin/env bash
# Single-use deploy wrapper. The fence is the first filesystem mutation.
set -euo pipefail

[[ $# -eq 3 && $1 == deploy.commit ]] || { echo "usage: run-action.sh deploy.commit <actionId> <sha>" >&2; exit 2; }
ACTION_ID=$2
SHA=$3
[[ $ACTION_ID =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]] || exit 2
[[ $SHA =~ ^[0-9a-f]{40}$ ]] || exit 2

BASE=${PANTER_BASE:-$HOME/panter-ai}
ACTIONS="$BASE/etc/actions"
FENCE="$ACTIONS/$ACTION_ID.fence"
# Phase 1 provisions etc/actions. Never create a record or invoke deploy without this fence.
if ! ln -s -T -- run "$FENCE" 2>/dev/null; then
  [[ -e $FENCE || -L $FENCE ]] && exit 0
  echo "run-action: cannot create fence" >&2
  exit 1
fi

RECORD="$ACTIONS/$ACTION_ID.json"
LOG="$ACTIONS/$ACTION_ID.log"
atomic_record() {
  node - "$RECORD" "$ACTION_ID" "$SHA" "$1" "$2" "$3" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const [file, actionId, sha, state, exit, revision] = process.argv.slice(2);
const final = state !== 'RUNNING';
const data = {actionId, sha, state, at: new Date().toISOString(),
  exitCode: final ? Number(exit) : null, revision: revision || null};
const tmp = file + '.' + crypto.randomUUID() + '.tmp';
try {
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(data) + '\n'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
  const dir = fs.openSync(path.dirname(file), 'r');
  try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
} finally { try { fs.unlinkSync(tmp); } catch {} }
NODE
}

atomic_record RUNNING '' ''
set +e
"$BASE/current/deploy/deploy.sh" "$SHA" >"$LOG" 2>&1
EXIT_CODE=$?
set -e

HEALTH=${PANTER_HEALTH_URL:-http://127.0.0.1:18080/health}
BODY=$(curl -fsS --max-time 3 "$HEALTH" 2>/dev/null || true)
REVISION=$(printf '%s' "$BODY" | node -e '
let input = ""; process.stdin.on("data", c => input += c);
process.stdin.on("end", () => { try {
  const r = JSON.parse(input).revision;
  process.stdout.write(typeof r === "string" ? r : "");
} catch {} });
')
STATE=FAILED
if [[ $EXIT_CODE -eq 0 && $REVISION == "$SHA" ]]; then
  STATE=LIVE
elif grep -Fq 'deploy: another deploy is running' "$LOG"; then
  STATE=LOCKED
elif grep -Fq 'deploy: build or tests failed' "$LOG"; then
  STATE=BUILD_FAILED
elif grep -Eq 'deploy: rolled back to .* which is healthy' "$LOG"; then
  STATE=ROLLED_BACK
fi
atomic_record "$STATE" "$EXIT_CODE" "$REVISION"
exit "$EXIT_CODE"
