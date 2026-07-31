#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

INSTALL_DIR="${SIRK_INSTALL_DIR:-/opt/sirk-central}"
STATE_DIR="${SIRK_UPDATER_STATE_DIR:-/var/lib/sirk-updater}"
STATUS_FILE="${STATE_DIR}/status.json"
LOCK_DIR="${STATE_DIR}/update.lock"
LOCK_PID_FILE="${LOCK_DIR}/pid"
LOG_FILE="${STATE_DIR}/update-$(date -u +%Y%m%dT%H%M%SZ).log"
STARTED_AT="${SIRK_UPDATE_STARTED_AT:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"
REQUESTED_BY="${SIRK_UPDATE_REQUESTED_BY:-unknown}"
COMPOSE_FILE="${SIRK_COMPOSE_FILE:-${INSTALL_DIR}/docker-compose.yml}"
REPO_REF="${SIRK_REPO_REF:-}"
CURRENT_COMMIT=""
TARGET_COMMIT=""
BACKUP_DIR=""
DEPLOY_STARTED=0
ROLLBACK_RUNNING=0

mkdir -p "$STATE_DIR"
chmod 0700 "$STATE_DIR"

write_status() {
  local state="$1" message="$2" commit="${3:-}"
  python3 - "$STATUS_FILE" "$state" "$message" "$STARTED_AT" "$REQUESTED_BY" "$LOG_FILE" "$commit" "$CURRENT_COMMIT" "$TARGET_COMMIT" <<'PY'
import json, os, sys, tempfile, datetime
path,state,message,started,requested,log,commit,previous,target=sys.argv[1:]
data={
  "state":state,
  "running":state in ("starting","running","rollback"),
  "message":message,
  "startedAtUtc":started,
  "requestedBy":requested,
  "logFile":log
}
if commit: data["commit"]=commit
if previous: data["previousCommit"]=previous
if target: data["targetCommit"]=target
if state in ("completed","failed","rollback_completed"):
  data["finishedAtUtc"]=datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00","Z")
os.makedirs(os.path.dirname(path),exist_ok=True)
fd,tmp=tempfile.mkstemp(dir=os.path.dirname(path),prefix="status-",text=True)
with os.fdopen(fd,"w") as f:
  json.dump(data,f,indent=2)
  f.write("\n")
os.chmod(tmp,0o600)
os.replace(tmp,path)
PY
}

compose() {
  docker compose -f "$COMPOSE_FILE" --profile auth "$@"
}

central_healthy() {
  local healthy=0
  for _ in $(seq 1 60); do
    if curl -fsS --max-time 5 http://central:8080/healthz >/dev/null 2>&1; then
      healthy=1
      break
    fi
    sleep 2
  done
  [[ "$healthy" -eq 1 ]]
}

rollback() {
  local original_code="$1"
  [[ "$ROLLBACK_RUNNING" -eq 0 ]] || exit "$original_code"
  ROLLBACK_RUNNING=1
  trap - ERR
  write_status rollback "Update failed. Restoring the previous version." "${CURRENT_COMMIT:-}" || true

  local rollback_ok=0
  if [[ -n "$CURRENT_COMMIT" && -d "$INSTALL_DIR/.git" ]]; then
    cd "$INSTALL_DIR"
    if git reset --hard "$CURRENT_COMMIT"; then
      if [[ -n "$BACKUP_DIR" && -f "$BACKUP_DIR/.env" ]]; then
        cp -a "$BACKUP_DIR/.env" .env || true
        chmod 0600 .env || true
      fi
      if [[ "$DEPLOY_STARTED" -eq 1 ]]; then
        compose config >/dev/null || true
        compose build central auth || true
        compose up -d --force-recreate --remove-orphans central auth caddy || true
        if central_healthy; then rollback_ok=1; fi
      else
        rollback_ok=1
      fi
    fi
  fi

  if [[ "$rollback_ok" -eq 1 ]]; then
    write_status rollback_completed "Update failed, but the previous version was restored successfully." "${CURRENT_COMMIT:-}" || true
  else
    write_status failed "Update failed and the previous version could not be confirmed healthy. Check the updater log." "${CURRENT_COMMIT:-}" || true
  fi
  exit "$original_code"
}

fail() {
  local code=$?
  rollback "$code"
}
trap fail ERR

acquire_lock() {
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    printf '%s\n' "$$" > "$LOCK_PID_FILE"
    chmod 0600 "$LOCK_PID_FILE"
    return 0
  fi

  local existing_pid=""
  if [[ -f "$LOCK_PID_FILE" ]]; then
    existing_pid="$(cat "$LOCK_PID_FILE" 2>/dev/null || true)"
  fi
  if [[ "$existing_pid" =~ ^[0-9]+$ ]] && kill -0 "$existing_pid" 2>/dev/null; then
    return 1
  fi

  rm -rf "$LOCK_DIR"
  mkdir "$LOCK_DIR"
  printf '%s\n' "$$" > "$LOCK_PID_FILE"
  chmod 0600 "$LOCK_PID_FILE"
}

if ! acquire_lock; then
  write_status failed "Another update is already running."
  exit 1
fi
trap 'rm -rf "$LOCK_DIR"' EXIT

: > "$LOG_FILE"
chmod 0600 "$LOG_FILE"
exec > >(tee -a "$LOG_FILE") 2>&1
write_status running "Preparing update."

[[ -d "$INSTALL_DIR/.git" ]]
[[ -f "$INSTALL_DIR/.env" ]]
[[ -f "$COMPOSE_FILE" ]]
cd "$INSTALL_DIR"

CURRENT_COMMIT="$(git rev-parse HEAD)"
if [[ -z "$REPO_REF" ]]; then
  REPO_REF="$(git branch --show-current)"
fi
[[ -n "$REPO_REF" ]]
if ! git check-ref-format --branch "$REPO_REF" >/dev/null 2>&1; then
  write_status failed "Configured repository ref is invalid: $REPO_REF" "$CURRENT_COMMIT"
  exit 1
fi

BACKUP_DIR="${STATE_DIR}/backups/sirk-central-update-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$BACKUP_DIR"
chmod 0700 "${STATE_DIR}/backups" "$BACKUP_DIR"
cp -a .env "$BACKUP_DIR/.env"
git rev-parse HEAD > "$BACKUP_DIR/previous-commit.txt"
printf '%s\n' "$REPO_REF" > "$BACKUP_DIR/repository-ref.txt"
compose config > "$BACKUP_DIR/compose-before.yml"

write_status running "Fetching deployment source from $REPO_REF." "$CURRENT_COMMIT"
git fetch --prune origin "+refs/heads/${REPO_REF}:refs/remotes/origin/${REPO_REF}"
git checkout -B "$REPO_REF" "origin/$REPO_REF"
git reset --hard "origin/$REPO_REF"
TARGET_COMMIT="$(git rev-parse HEAD)"

write_status running "Running tests and validating configuration." "$TARGET_COMMIT"
npm ci
npm test
compose config >/dev/null

write_status running "Building updated application services." "$TARGET_COMMIT"
compose build --pull central auth

write_status running "Deploying updated application services." "$TARGET_COMMIT"
DEPLOY_STARTED=1
compose up -d --force-recreate --remove-orphans central auth caddy

central_healthy
CENTRAL_DOMAIN="${SIRK_CENTRAL_DOMAIN:-central.sirkportal.com}"
curl -fsS --max-time 10 "https://${CENTRAL_DOMAIN}/healthz" >/dev/null

write_status completed "Update completed successfully." "$TARGET_COMMIT"
