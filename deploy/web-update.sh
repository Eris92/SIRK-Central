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
REPO_REF="${SIRK_REPO_REF:-}"
REQUIRE_SIGNED_COMMIT="${SIRK_UPDATE_REQUIRE_SIGNED_COMMIT:-false}"
CURRENT_COMMIT=""
TARGET_COMMIT=""
BACKUP_DIR=""
ROLLBACK_RUNNING=0

COMPOSE_FILE_PATHS=("${SIRK_COMPOSE_FILE:-${INSTALL_DIR}/docker-compose.yml}")
COMPOSE_ARGS=()
for compose_file in "${COMPOSE_FILE_PATHS[@]}"; do
  [[ -n "$compose_file" ]] || continue
  COMPOSE_ARGS+=( -f "$compose_file" )
done
PROFILE_ARGS=()
IFS=',' read -r -a COMPOSE_PROFILE_NAMES <<< "${SIRK_COMPOSE_PROFILES:-auth,maintenance}"
for profile in "${COMPOSE_PROFILE_NAMES[@]}"; do
  profile="${profile//[[:space:]]/}"
  [[ -n "$profile" ]] && PROFILE_ARGS+=( --profile "$profile" )
done
BASE_SERVICES=(central auth updater-gateway backup-manager caddy)
BUILD_SERVICES=(central auth updater-gateway updater backup-manager)

mkdir -p "$STATE_DIR"
chmod 0700 "$STATE_DIR"

write_status() {
  local state="$1" message="$2" commit="${3:-}"
  python3 - "$STATUS_FILE" "$state" "$message" "$STARTED_AT" "$REQUESTED_BY" "$LOG_FILE" "$commit" "$CURRENT_COMMIT" "$TARGET_COMMIT" <<'PY'
import datetime, json, os, sys, tempfile
path,state,message,started,requested,log,commit,previous,target=sys.argv[1:]
data={
  "state":state,
  "running":state in ("starting","running","rollback"),
  "message":message,
  "startedAtUtc":started,
  "requestedBy":requested,
  "logFile":log,
  "updaterRestartScheduled":False
}
if commit: data["commit"]=commit
if previous: data["previousCommit"]=previous
if target: data["targetCommit"]=target
if state in ("completed","failed","rollback_completed"):
  data["finishedAtUtc"]=datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00","Z")
os.makedirs(os.path.dirname(path),exist_ok=True)
fd,tmp=tempfile.mkstemp(dir=os.path.dirname(path),prefix="status-",text=True)
try:
  with os.fdopen(fd,"w") as f:
    json.dump(data,f,indent=2)
    f.write("\n")
    f.flush()
    os.fsync(f.fileno())
  os.chmod(tmp,0o600)
  os.replace(tmp,path)
except Exception:
  try: os.unlink(tmp)
  except OSError: pass
  raise
PY
}
compose() { docker compose "${COMPOSE_ARGS[@]}" "${PROFILE_ARGS[@]}" "$@"; }

central_healthy() {
  local container_id state
  container_id="$(compose ps -q central)"
  [[ -n "$container_id" ]] || return 1
  for _ in $(seq 1 60); do
    state="$(docker inspect "$container_id" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' 2>/dev/null || true)"
    [[ "$state" == "healthy" ]] && return 0
    [[ "$state" == "unhealthy" || "$state" == "exited" || "$state" == "dead" ]] && return 1
    sleep 2
  done
  return 1
}
validate_data_archive() {
  local archive="$1"
  node - "$archive" <<'NODE'
const archive = require('./updater/backup-archive');
archive.validateArchive(process.argv[2], {
  requireChecksum: true,
  maxArchiveBytes: Number(process.env.SIRK_BACKUP_MAX_ARCHIVE_BYTES || 50 * 1024 * 1024 * 1024),
  maxEntries: Number(process.env.SIRK_BACKUP_MAX_ENTRIES || 100000)
});
NODE
}
restore_data_archive() {
  local archive="$1"
  validate_data_archive "$archive"
  find /var/lib/sirk-central -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
  tar --extract --gzip --file "$archive" --directory /var/lib/sirk-central \
    --no-same-owner --no-same-permissions --delay-directory-restore
  chown -R 1000:1000 /var/lib/sirk-central
  find /var/lib/sirk-central -type d -exec chmod 0700 {} +
  find /var/lib/sirk-central -type f -exec chmod 0600 {} +
}
capture_safety_data() {
  BACKUP_DIR="${STATE_DIR}/backups/sirk-central-update-$(date -u +%Y%m%dT%H%M%SZ)"
  mkdir -p "$BACKUP_DIR"
  chmod 0700 "${STATE_DIR}/backups" "$BACKUP_DIR"
  cp --preserve=mode,timestamps .env "$BACKUP_DIR/.env"
  git rev-parse HEAD > "$BACKUP_DIR/previous-commit.txt"
  printf '%s\n' "$REPO_REF" > "$BACKUP_DIR/repository-ref.txt"
  compose config > "$BACKUP_DIR/compose-before.yml"
  tar --format=pax -czf "$BACKUP_DIR/central-data.tar.gz.partial" -C /var/lib/sirk-central .
  mv -- "$BACKUP_DIR/central-data.tar.gz.partial" "$BACKUP_DIR/central-data.tar.gz"
  node - "$BACKUP_DIR/central-data.tar.gz" <<'NODE'
const archive = require('./updater/backup-archive');
archive.writeChecksum(process.argv[2]);
archive.validateArchive(process.argv[2], { requireChecksum: true });
NODE
  chmod 0600 "$BACKUP_DIR/central-data.tar.gz" "$BACKUP_DIR/central-data.tar.gz.sha256"
}
rollback() {
  local original_code="$1"
  [[ "$ROLLBACK_RUNNING" -eq 0 ]] || exit "$original_code"
  ROLLBACK_RUNNING=1
  trap - ERR
  write_status rollback "Update failed. Restoring repository, configuration and Central data." "${CURRENT_COMMIT:-}" || true

  local rollback_ok=0
  if [[ -n "$CURRENT_COMMIT" && -d "$INSTALL_DIR/.git" && -n "$BACKUP_DIR" ]]; then
    cd "$INSTALL_DIR"
    compose stop central auth updater-gateway backup-manager >/dev/null 2>&1 || true
    if git reset --hard "$CURRENT_COMMIT" \
      && cp -- "$BACKUP_DIR/.env" .env \
      && chmod 0600 .env \
      && compose config >/dev/null \
      && compose build central auth updater-gateway backup-manager \
      && restore_data_archive "$BACKUP_DIR/central-data.tar.gz" \
      && compose up -d --force-recreate --remove-orphans "${BASE_SERVICES[@]}" \
      && central_healthy; then
      rollback_ok=1
    fi
  fi

  if [[ "$rollback_ok" -eq 1 ]]; then
    write_status rollback_completed "Update failed, but the previous repository, configuration and data were restored." "${CURRENT_COMMIT:-}" || true
  else
    write_status failed "Update failed and automatic rollback could not be confirmed healthy. Preserve the updater log and safety backup." "${CURRENT_COMMIT:-}" || true
  fi
  exit "$original_code"
}
fail() { local code=$?; rollback "$code"; }
trap fail ERR

acquire_lock() {
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    printf '%s\n' "$$" > "$LOCK_PID_FILE"
    chmod 0600 "$LOCK_PID_FILE"
    return 0
  fi
  local existing_pid=""
  [[ -f "$LOCK_PID_FILE" ]] && existing_pid="$(cat "$LOCK_PID_FILE" 2>/dev/null || true)"
  if [[ "$existing_pid" =~ ^[0-9]+$ ]] && kill -0 "$existing_pid" 2>/dev/null; then return 1; fi
  rm -rf -- "$LOCK_DIR"
  mkdir "$LOCK_DIR"
  printf '%s\n' "$$" > "$LOCK_PID_FILE"
  chmod 0600 "$LOCK_PID_FILE"
}

if ! acquire_lock; then
  write_status failed "Another update is already running."
  exit 1
fi
trap 'rm -rf -- "$LOCK_DIR"' EXIT

: > "$LOG_FILE"
chmod 0600 "$LOG_FILE"
exec > >(tee -a "$LOG_FILE") 2>&1
write_status running "Preparing update."

[[ -d "$INSTALL_DIR/.git" ]]
[[ -f "$INSTALL_DIR/.env" ]]
[[ "${#COMPOSE_ARGS[@]}" -ge 4 ]]
for command in python3 node npm docker git curl tar; do command -v "$command" >/dev/null 2>&1; done
cd "$INSTALL_DIR"

CURRENT_COMMIT="$(git rev-parse HEAD)"
[[ -n "$REPO_REF" ]] || REPO_REF="$(git branch --show-current)"
[[ -n "$REPO_REF" ]]
git check-ref-format --branch "$REPO_REF" >/dev/null
if [[ -n "$(git status --porcelain=v1 --untracked-files=no)" ]]; then
  write_status failed "Deployment repository contains tracked local changes. Refusing destructive update." "$CURRENT_COMMIT"
  exit 1
fi

write_status running "Fetching deployment source from ${REPO_REF}." "$CURRENT_COMMIT"
git fetch --prune origin "+refs/heads/${REPO_REF}:refs/remotes/origin/${REPO_REF}"
TARGET_COMMIT="$(git rev-parse "origin/${REPO_REF}")"
[[ "$TARGET_COMMIT" =~ ^[0-9a-f]{40}$ ]]
for required_path in \
  Dockerfile docker-compose.yml \
  src/server.js updater/Dockerfile.gateway updater/gateway-server.js \
  updater/backup-archive.js updater/restore-transaction.js; do
  git cat-file -e "${TARGET_COMMIT}:${required_path}"
done
if [[ "$REQUIRE_SIGNED_COMMIT" == "true" ]]; then git verify-commit "$TARGET_COMMIT"; fi

write_status running "Creating pre-update repository and data safety backup." "$CURRENT_COMMIT"
capture_safety_data

git checkout -B "$REPO_REF" "origin/$REPO_REF"
git reset --hard "$TARGET_COMMIT"

write_status running "Running syntax, tests, dependency audit and Compose validation." "$TARGET_COMMIT"
npm ci
npm run check:syntax
SIRK_CONCURRENCY_TEST_REQUESTS="${SIRK_CONCURRENCY_TEST_REQUESTS:-24}" npm test
npm audit --omit=dev --audit-level=high
compose config >/dev/null

write_status running "Building Central, Auth, gateway, worker and backup-manager images." "$TARGET_COMMIT"
compose build --pull "${BUILD_SERVICES[@]}"

write_status running "Deploying the non-privileged base stack." "$TARGET_COMMIT"
compose up -d --force-recreate --remove-orphans "${BASE_SERVICES[@]}"
central_healthy

CENTRAL_DOMAIN="${SIRK_CENTRAL_DOMAIN:-central.sirkportal.com}"
curl -fsS --max-time 15 "https://${CENTRAL_DOMAIN}/readyz" >/dev/null

write_status completed "Update completed. Close the maintenance window to remove the privileged updater worker." "$TARGET_COMMIT"
