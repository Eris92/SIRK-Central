#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

INSTALL_DIR="${SIRK_INSTALL_DIR:-/opt/sirk-central}"
ARCHIVE="${1:-}"
CONFIRM="${SIRK_RESTORE_CONFIRM:-}"
ALLOW_LEGACY="${SIRK_RESTORE_ALLOW_LEGACY_WITHOUT_CHECKSUM:-false}"
WORK_DIR=""
SAFETY_DIR=""
ROLLBACK_ARMED=false
COMPOSE_FILES=(-f docker-compose.yml -f docker-compose.portal-runtime.yml)
PROFILE_ARGS=(--profile auth --profile maintenance)
BASE_SERVICES=(central auth updater-gateway backup-manager caddy)
BUILD_SERVICES=(central auth updater-gateway updater backup-manager)

log() { printf '\n==> %s\n' "$*"; }
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
compose() { docker compose "${COMPOSE_FILES[@]}" "${PROFILE_ARGS[@]}" "$@"; }
cleanup() { [[ -n "$WORK_DIR" && -d "$WORK_DIR" ]] && rm -rf -- "$WORK_DIR"; }

wait_ready() {
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
replace_volume_data() {
  local source_dir="$1"
  [[ -d "$source_dir" ]] || fail "Restore data directory is missing: $source_dir"
  compose run --rm --no-deps --user 0:0 \
    -v "$source_dir:/sirk-restore-source:ro" \
    --entrypoint /bin/sh central -ec '
      find /var/lib/sirk-central -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
      cp -a /sirk-restore-source/. /var/lib/sirk-central/
      chown -R node:node /var/lib/sirk-central
      find /var/lib/sirk-central -type d -exec chmod 0700 {} +
      find /var/lib/sirk-central -type f -exec chmod 0600 {} +
    '
}
capture_safety_state() {
  SAFETY_DIR="$WORK_DIR/safety"
  mkdir -p "$SAFETY_DIR/data"
  chmod 0700 "$SAFETY_DIR" "$SAFETY_DIR/data"
  cp --preserve=mode,timestamps .env "$SAFETY_DIR/.env"
  git rev-parse HEAD > "$SAFETY_DIR/commit.txt"
  git status --porcelain=v1 > "$SAFETY_DIR/git-status.txt"
  if compose ps --services | grep -qx central; then
    rm -rf -- "$SAFETY_DIR/data"
    compose cp central:/var/lib/sirk-central "$SAFETY_DIR/data"
  elif [[ -d "$INSTALL_DIR/data" ]]; then
    rm -rf -- "$SAFETY_DIR/data"
    cp -a -- "$INSTALL_DIR/data" "$SAFETY_DIR/data"
  else
    fail "Unable to capture current Central data."
  fi
  find "$SAFETY_DIR" -type d -exec chmod 0700 {} +
  find "$SAFETY_DIR" -type f -exec chmod 0600 {} +
}
rollback() {
  local original_code="$1"
  trap - ERR
  set +e
  log "Restore failed; rolling back to captured safety state"
  cd "$INSTALL_DIR" || return 1
  compose stop central auth updater-gateway updater backup-manager >/dev/null 2>&1 || true
  cp -- "$SAFETY_DIR/.env" .env
  chmod 0600 .env
  local safety_commit
  safety_commit="$(tr -d '[:space:]' < "$SAFETY_DIR/commit.txt")"
  git reset --hard "$safety_commit" || return 1
  [[ -f docker-compose.portal-runtime.yml && -f updater/Dockerfile.gateway ]] || return 1
  compose build "${BUILD_SERVICES[@]}" || return 1
  replace_volume_data "$SAFETY_DIR/data" || return 1
  compose rm -sf updater >/dev/null 2>&1 || true
  compose up -d --force-recreate "${BASE_SERVICES[@]}" || return 1
  [[ -z "$(compose ps -q updater)" ]] || return 1
  wait_ready || return 1
  printf 'Rollback completed after restore failure (original exit code %s).\n' "$original_code" >&2
  return 0
}
on_error() {
  local code=$? line="${BASH_LINENO[0]:-unknown}"
  if [[ "$ROLLBACK_ARMED" == "true" ]]; then
    if ! rollback "$code"; then
      printf 'CRITICAL: automatic rollback failed. Safety state remains at %s. Failure near line %s.\n' "$SAFETY_DIR" "$line" >&2
      trap - EXIT
      exit 90
    fi
  fi
  printf 'Restore aborted near line %s.\n' "$line" >&2
  exit "$code"
}
trap cleanup EXIT
trap on_error ERR

[[ "$(id -u)" -eq 0 ]] || fail "Run as root."
[[ -n "$ARCHIVE" && -f "$ARCHIVE" ]] || fail "Usage: sudo SIRK_RESTORE_CONFIRM='RESTORE SIRK CENTRAL' $0 <archive.tar.gz|archive.tar.gz.age>"
[[ "$CONFIRM" == "RESTORE SIRK CENTRAL" ]] || fail "Set SIRK_RESTORE_CONFIRM='RESTORE SIRK CENTRAL'."
[[ -d "$INSTALL_DIR/.git" ]] || fail "Missing Git installation in $INSTALL_DIR."
for command in python3 sha256sum docker git; do command -v "$command" >/dev/null 2>&1 || fail "$command is required."; done

WORK_DIR="$(mktemp -d /var/tmp/sirk-restore-XXXXXX)"
chmod 0700 "$WORK_DIR"
SOURCE="$ARCHIVE"
CHECKSUM_FILE="$ARCHIVE.sha256"

log "Verifying archive checksum"
if [[ -f "$CHECKSUM_FILE" ]]; then
  (cd "$(dirname "$ARCHIVE")" && sha256sum -c "$(basename "$CHECKSUM_FILE")")
elif [[ "$ALLOW_LEGACY" != "true" ]]; then
  fail "Backup checksum is missing. Set SIRK_RESTORE_ALLOW_LEGACY_WITHOUT_CHECKSUM=true only for a trusted legacy archive."
else
  printf 'WARNING: restoring a legacy archive without checksum.\n' >&2
fi

if [[ "$ARCHIVE" == *.age ]]; then
  command -v age >/dev/null 2>&1 || fail "age is required."
  : "${SIRK_BACKUP_AGE_IDENTITY:?Set SIRK_BACKUP_AGE_IDENTITY to the age identity file}"
  [[ -f "$SIRK_BACKUP_AGE_IDENTITY" ]] || fail "age identity file does not exist."
  SOURCE="$WORK_DIR/backup.tar.gz"
  age -d -i "$SIRK_BACKUP_AGE_IDENTITY" -o "$SOURCE.partial" "$ARCHIVE"
  mv -- "$SOURCE.partial" "$SOURCE"
  chmod 0600 "$SOURCE"
fi

log "Validating and safely extracting archive"
EXTRACT_ROOT="$WORK_DIR/extracted"
TOP_LEVEL="$(python3 "$INSTALL_DIR/scripts/validate-backup-archive.py" "$SOURCE" --extract-to "$EXTRACT_ROOT")"
BACKUP_DIR="$EXTRACT_ROOT/$TOP_LEVEL"
[[ -f "$BACKUP_DIR/commit.txt" && -f "$BACKUP_DIR/.env" && -d "$BACKUP_DIR/data" ]] || fail "Backup structure is invalid."
TARGET_COMMIT="$(tr -d '[:space:]' < "$BACKUP_DIR/commit.txt")"
[[ "$TARGET_COMMIT" =~ ^[0-9a-fA-F]{40}$ ]] || fail "Backup commit is invalid."

cd "$INSTALL_DIR"
[[ -f docker-compose.yml && -f docker-compose.portal-runtime.yml ]] || fail "Canonical Compose files are missing."

log "Fetching and validating target commit before stopping services"
git fetch --prune origin
git cat-file -e "$TARGET_COMMIT^{commit}" || fail "Backup commit is unavailable."
for required_path in \
  Dockerfile.portal-runtime docker-compose.yml docker-compose.portal-runtime.yml \
  src/server-v15.js updater/Dockerfile.gateway updater/gateway-server.js; do
  git cat-file -e "$TARGET_COMMIT:$required_path" || fail "Backup commit is missing: $required_path"
done

log "Capturing safety state"
capture_safety_state
ROLLBACK_ARMED=true

log "Stopping application and maintenance services"
compose stop central auth updater-gateway updater backup-manager || true

log "Restoring repository and configuration"
cp -- "$BACKUP_DIR/.env" .env
chmod 0600 .env
git reset --hard "$TARGET_COMMIT"
[[ -f docker-compose.portal-runtime.yml && -f updater/Dockerfile.gateway ]] || fail "Target commit is missing canonical runtime files."

log "Building restored images"
compose build "${BUILD_SERVICES[@]}"

log "Replacing persistent Central data"
replace_volume_data "$BACKUP_DIR/data"

log "Starting restored base stack without privileged worker"
compose rm -sf updater >/dev/null 2>&1 || true
compose up -d --force-recreate "${BASE_SERVICES[@]}"
[[ -z "$(compose ps -q updater)" ]] || fail "Privileged updater remained after restore."
wait_ready || fail "Restored Central did not become healthy."

ROLLBACK_ARMED=false
log "Restore completed"
printf 'Commit=%s\n' "$TARGET_COMMIT"
printf 'Updater worker=stopped; gateway=active\n'
printf 'Safety state was removed after successful validation.\n'
