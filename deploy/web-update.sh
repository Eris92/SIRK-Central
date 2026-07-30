#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

INSTALL_DIR="${SIRK_INSTALL_DIR:-/opt/sirk-central}"
REPO_REF="${SIRK_REPO_REF:-main}"
STATE_DIR="${SIRK_UPDATER_STATE_DIR:-/var/lib/sirk-updater}"
STATUS_FILE="${STATE_DIR}/status.json"
LOCK_DIR="${STATE_DIR}/update.lock"
LOG_FILE="${STATE_DIR}/update-$(date -u +%Y%m%dT%H%M%SZ).log"
STARTED_AT="${SIRK_UPDATE_STARTED_AT:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"
REQUESTED_BY="${SIRK_UPDATE_REQUESTED_BY:-unknown}"

mkdir -p "$STATE_DIR"
chmod 0700 "$STATE_DIR"

write_status() {
  local state="$1" message="$2" commit="${3:-}"
  python3 - "$STATUS_FILE" "$state" "$message" "$STARTED_AT" "$REQUESTED_BY" "$LOG_FILE" "$commit" <<'PY'
import json, os, sys, tempfile, datetime
path,state,message,started,requested,log,commit=sys.argv[1:]
data={"state":state,"running":state in ("starting","running"),"message":message,"startedAtUtc":started,"requestedBy":requested,"logFile":log}
if commit:data["commit"]=commit
if state in ("completed","failed"):data["finishedAtUtc"]=datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00","Z")
os.makedirs(os.path.dirname(path),exist_ok=True)
fd,tmp=tempfile.mkstemp(dir=os.path.dirname(path),prefix="status-",text=True)
with os.fdopen(fd,"w") as f: json.dump(data,f,indent=2); f.write("\n")
os.chmod(tmp,0o600); os.replace(tmp,path)
PY
}

fail() {
  local code=$?
  write_status failed "Update failed. Check the updater log." || true
  exit "$code"
}
trap fail ERR

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  write_status failed "Another update is already running."
  exit 1
fi
trap 'rm -rf "$LOCK_DIR"' EXIT

exec > >(tee -a "$LOG_FILE") 2>&1
chmod 0600 "$LOG_FILE"
write_status running "Preparing update."

[[ -d "$INSTALL_DIR/.git" ]]
[[ -f "$INSTALL_DIR/.env" ]]
cd "$INSTALL_DIR"

CURRENT_COMMIT="$(git rev-parse HEAD)"
BACKUP_DIR="/root/sirk-central-web-update-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$BACKUP_DIR"
chmod 0700 "$BACKUP_DIR"
cp -a .env "$BACKUP_DIR/.env"
git rev-parse HEAD > "$BACKUP_DIR/previous-commit.txt"
docker compose --profile auth config > "$BACKUP_DIR/compose-before.yml"

write_status running "Fetching signed deployment source." "$CURRENT_COMMIT"
git fetch --prune origin
git checkout -B "$REPO_REF" "origin/$REPO_REF"
git reset --hard "origin/$REPO_REF"
TARGET_COMMIT="$(git rev-parse HEAD)"

write_status running "Running tests and validating configuration." "$TARGET_COMMIT"
npm ci
npm test
docker compose --profile auth config >/dev/null

write_status running "Building updated services." "$TARGET_COMMIT"
docker compose --profile auth build --pull central auth updater

write_status running "Deploying updated services." "$TARGET_COMMIT"
docker compose --profile auth up -d --force-recreate --remove-orphans central auth caddy

for _ in $(seq 1 60); do
  if curl -fsS --max-time 5 http://central:8080/healthz >/dev/null 2>&1 || curl -fsS --max-time 5 https://central.sirkportal.com/healthz >/dev/null 2>&1; then
    break
  fi
  sleep 2
done
curl -fsS --max-time 10 https://central.sirkportal.com/healthz >/dev/null

docker compose --profile auth up -d --force-recreate updater
write_status completed "Update completed successfully." "$TARGET_COMMIT"
