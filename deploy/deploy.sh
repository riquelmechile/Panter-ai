#!/usr/bin/env bash
# Deploy one exact commit of main: build and test it in its own release directory, back up the live state, switch the
# `current` symlink, restart, and roll back automatically if /health does not report that commit.
#
#   PANTER_SOURCE_REPO=~/panter-ai/src-clone deploy/deploy.sh <full-40-hex-sha>
#
# Optional: PANTER_BASE (default ~/panter-ai), PANTER_UNIT (panter-ai.service), PANTER_HEALTH_URL
# (http://127.0.0.1:18080/health), PANTER_KEEP_RELEASES (3). Code rolls back automatically; the data does not
# (restore it by hand from the pre-<sha> backup if a release changed it).
set -euo pipefail
SHA=${1:-}
[[ $SHA =~ ^[0-9a-f]{40}$ ]] || { echo "deploy: a full 40-hex commit SHA is required" >&2; exit 2; }
BASE=${PANTER_BASE:-$HOME/panter-ai}
SRC=${PANTER_SOURCE_REPO:?deploy: PANTER_SOURCE_REPO must point to a clone of the repository}
UNIT=${PANTER_UNIT:-panter-ai.service}
HEALTH=${PANTER_HEALTH_URL:-http://127.0.0.1:18080/health}
KEEP=${PANTER_KEEP_RELEASES:-3}
[[ $KEEP =~ ^[0-9]+$ ]] && (( KEEP >= 2 )) || { echo "deploy: PANTER_KEEP_RELEASES must be 2 or more" >&2; exit 2; }
S=${SHA:0:7}
REL="$BASE/releases/$S"
LOGS="$BASE/releases/$S"
[ -e "$REL" ] && { echo "deploy: $REL already exists" >&2; exit 2; }

git -C "$SRC" fetch -q origin
git -C "$SRC" cat-file -e "$SHA^{commit}"
git -C "$SRC" merge-base --is-ancestor "$SHA" origin/main || { echo "deploy: $SHA is not on origin/main" >&2; exit 2; }

echo "deploy: building $S"
mkdir -p "$REL"
git -C "$SRC" archive "$SHA" | tar -x -C "$REL"
echo "$SHA" > "$REL/REVISION"
if ! (cd "$REL" && npm ci >"$LOGS.ci.log" 2>&1 && npm run build >"$LOGS.build.log" 2>&1 && npm test >"$LOGS.test.log" 2>&1); then
  echo "deploy: build or tests failed (see $LOGS.*.log); nothing switched" >&2; exit 1
fi
grep -E '^# (tests|pass|fail) ' "$LOGS.test.log" || true

node "$REL/deploy/backup.mjs" --base "$BASE" --label "pre-$S-$(date -u +%Y%m%d%H%M)" --release "$SHA"

PREV=$(readlink "$BASE/current" || true)
switch() { ln -sfn "$1" "$BASE/current.new" && mv -Tf "$BASE/current.new" "$BASE/current"; }
switch "releases/$S"
systemctl --user restart "$UNIT"
ok=0
for _ in $(seq 1 30); do
  sleep 2
  if curl -fsS --max-time 5 "$HEALTH" 2>/dev/null | grep -q "\"revision\":\"$SHA\""; then ok=1; break; fi
done
if [ "$ok" != 1 ]; then
  echo "deploy: $S did not come up healthy; rolling back to ${PREV:-nothing}" >&2
  if [ -n "$PREV" ]; then switch "$PREV"; systemctl --user restart "$UNIT"; fi
  exit 1
fi
echo "deploy: $S is live"

# Keep the newest $KEEP releases, always including the live one and the one just replaced.
cd "$BASE/releases"
keep=" $S ${PREV#releases/} "
for d in $(ls -1td -- */ 2>/dev/null | sed 's#/$##'); do
  case "$keep" in *" $d "*) continue;; esac
  if [ "$(wc -w <<<"$keep")" -lt "$KEEP" ]; then keep="$keep$d "; continue; fi
  rm -rf -- "$d" "$d.ci.log" "$d.build.log" "$d.test.log" "$d.done"
  echo "deploy: pruned release $d"
done
