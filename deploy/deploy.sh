#!/usr/bin/env bash
# Deploy one exact commit of main: build and test it in its own release directory, stop the service, back up the
# state, switch the `current` symlink, start it, and roll back automatically if /health does not report that commit.
#
#   PANTER_SOURCE_REPO=~/panter-ai/src-clone deploy/deploy.sh <full-40-hex-sha>
#
# Optional: PANTER_BASE (default ~/panter-ai), PANTER_UNIT (panter-ai.service), PANTER_HEALTH_URL
# (http://127.0.0.1:18080/health), PANTER_KEEP_RELEASES (3). Code rolls back automatically; the data does not
# (restore it by hand from the pre-<sha> backup if a release changed it; see docs/OPERATIONS.md).
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
RELEASES="$BASE/releases"
REL="$RELEASES/$S"

# One deploy at a time.
mkdir -p "$RELEASES"
exec 9>"$RELEASES/.deploy.lock"
flock -n 9 || { echo "deploy: another deploy is running" >&2; exit 2; }

# The live release, by name, however the symlink was written (relative, absolute, trailing slash).
PREV=""
if [ -L "$BASE/current" ]; then
  live=$(readlink -f "$BASE/current" || true)
  [ -n "$live" ] && [ "$(dirname "$live")" = "$(readlink -f "$RELEASES")" ] && PREV=$(basename "$live")
fi
[ "$PREV" = "$S" ] && { echo "deploy: $S is already live" >&2; exit 2; }
# A directory for this same commit (a failed attempt, or an older kept release being deployed again) is rebuilt; the
# live one never is (checked above).
[ -e "$REL" ] && { echo "deploy: removing leftover $REL from an earlier attempt"; rm -rf -- "$REL"; }

git -C "$SRC" fetch -q origin
git -C "$SRC" cat-file -e "$SHA^{commit}"
git -C "$SRC" merge-base --is-ancestor "$SHA" origin/main || { echo "deploy: $SHA is not on origin/main" >&2; exit 2; }

echo "deploy: building $S"
mkdir -p "$REL"
git -C "$SRC" archive "$SHA" | tar -x -C "$REL"
echo "$SHA" > "$REL/REVISION"
# Build and test with a clean environment, so a shell with the production env loaded never points tests at real data.
# (9>&-: a process left behind by the tests must not keep holding the deploy lock.)
if ! (cd "$REL" && env -i PATH="$PATH" HOME="$HOME" npm ci >"$REL.ci.log" 2>&1 9>&- \
      && env -i PATH="$PATH" HOME="$HOME" npm run build >"$REL.build.log" 2>&1 9>&- \
      && env -i PATH="$PATH" HOME="$HOME" npm test >"$REL.test.log" 2>&1 9>&-); then
  echo "deploy: build or tests failed (see $REL.*.log); nothing switched" >&2
  rm -rf -- "$REL"; exit 1
fi
grep -E '^# (tests|pass|fail) ' "$REL.test.log" || true

switch() { ln -sfn "releases/$1" "$BASE/current.new" && mv -Tf "$BASE/current.new" "$BASE/current"; }
restart() { systemctl --user reset-failed "$UNIT" >/dev/null 2>&1 || true; systemctl --user restart "$UNIT" || true; }

# The JSON stores are only consistent while the service is stopped, so the backup is taken with it stopped (a few
# seconds; the restart below was going to interrupt it anyway). etc/quiesce keeps the health check from restarting it
# meanwhile.
mkdir -p "$BASE/etc"; touch "$BASE/etc/quiesce"; trap 'rm -f "$BASE/etc/quiesce"' EXIT
echo "deploy: stopping $UNIT for a consistent backup"
systemctl --user stop "$UNIT"
if ! node "$REL/deploy/backup.mjs" --base "$BASE" --label "pre-$S-$(date -u +%Y%m%d%H%M%S)-$$" --release "$SHA" --stopped; then
  echo "deploy: backup failed; nothing switched, starting ${PREV:-the current release} again" >&2
  restart; rm -rf -- "$REL"; exit 1
fi
healthy() { # healthy <revision|any>: poll /health for about a minute
  for _ in $(seq 1 20); do
    sleep 3
    body=$(curl -fsS --max-time 3 "$HEALTH" 2>/dev/null || true)
    if [ "$1" = any ]; then [[ $body == *'"status":"ok"'* ]] && return 0
    else [[ $body == *"\"revision\":\"$1\""* ]] && return 0; fi
  done
  return 1
}

switch "$S"
restart
if ! healthy "$SHA"; then
  echo "deploy: $S did not come up healthy" >&2
  if [ -z "$PREV" ]; then echo "deploy: ROLLBACK IMPOSSIBLE: there was no previous release; $S stays live and unhealthy" >&2; exit 1; fi
  echo "deploy: rolling back to $PREV" >&2
  switch "$PREV"
  restart
  if healthy any; then echo "deploy: rolled back to $PREV, which is healthy" >&2; rm -rf -- "$REL"
  else echo "deploy: ROLLBACK FAILED: $PREV is live but /health does not answer; act now ($REL is kept: it may be the only release that runs on the current data)" >&2; fi
  exit 1
fi
echo "deploy: $S is live"

# Keep the newest $KEEP releases, always including the live one and the one just replaced.
keep=" $S $PREV "
kept=$(wc -w <<<"$keep")
for d in $(cd "$RELEASES" && ls -1td -- */ 2>/dev/null | sed 's#/$##' | grep -E '^[0-9a-f]{7}$'); do
  case "$keep" in *" $d "*) continue;; esac
  if [ "$kept" -lt "$KEEP" ]; then keep="$keep$d "; kept=$((kept + 1)); continue; fi
  rm -rf -- "${RELEASES:?}/$d" "$RELEASES/$d".ci.log "$RELEASES/$d".build.log "$RELEASES/$d".test.log "$RELEASES/$d".done
  echo "deploy: pruned release $d"
done
