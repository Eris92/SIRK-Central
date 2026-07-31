#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

INSTALL_DIR="${SIRK_INSTALL_DIR:-/opt/sirk-central}"
REPO_REF="${SIRK_REPO_REF:-main}"
BASE_COMPOSE_FILE="${SIRK_COMPOSE_FILE:-docker-compose.yml}"
RUNTIME_COMPOSE_FILE="${SIRK_RUNTIME_COMPOSE_FILE:-docker-compose.portal-runtime.yml}"
KEEP_MAINTENANCE_OPEN="${SIRK_UPDATE_KEEP_MAINTENANCE_OPEN:-false}"

log() { printf '[SIRK UPDATE] %s\n' "$*"; }
die() { printf '[SIRK UPDATE] ERROR: %s\n' "$*" >&2; exit 1; }

[[ "$(id -u)" -eq 0 ]] || die "run this script through sudo or as root"
[[ -d "${INSTALL_DIR}/.git" ]] || die "${INSTALL_DIR} is not a Git clone"
[[ -f "${INSTALL_DIR}/.env" ]] || die "${INSTALL_DIR}/.env is missing"
[[ -f "${INSTALL_DIR}/${BASE_COMPOSE_FILE}" ]] || die "missing ${BASE_COMPOSE_FILE}"
[[ -f "${INSTALL_DIR}/${RUNTIME_COMPOSE_FILE}" ]] || die "missing ${RUNTIME_COMPOSE_FILE}"
[[ -f "${INSTALL_DIR}/deploy/web-update.sh" ]] || die "transactional update script is missing"
[[ -f "${INSTALL_DIR}/deploy/maintenance-up.sh" ]] || die "maintenance-up.sh is missing"
[[ -f "${INSTALL_DIR}/deploy/maintenance-down.sh" ]] || die "maintenance-down.sh is missing"
command -v docker >/dev/null 2>&1 || die "docker is required"
docker compose version >/dev/null 2>&1 || die "Docker Compose plugin is required"
git check-ref-format --branch "$REPO_REF" >/dev/null 2>&1 || die "invalid repository ref: $REPO_REF"

cd "$INSTALL_DIR"
COMPOSE=(docker compose -f "$BASE_COMPOSE_FILE" -f "$RUNTIME_COMPOSE_FILE" --profile auth --profile maintenance)

close_maintenance() {
  if [[ "$KEEP_MAINTENANCE_OPEN" != "true" ]]; then
    SIRK_INSTALL_DIR="$INSTALL_DIR" \
    SIRK_COMPOSE_FILE="$BASE_COMPOSE_FILE" \
    SIRK_RUNTIME_COMPOSE_FILE="$RUNTIME_COMPOSE_FILE" \
      bash deploy/maintenance-down.sh || true
  fi
}
trap close_maintenance EXIT

log "Opening the explicit updater maintenance window"
SIRK_INSTALL_DIR="$INSTALL_DIR" \
SIRK_COMPOSE_FILE="$BASE_COMPOSE_FILE" \
SIRK_RUNTIME_COMPOSE_FILE="$RUNTIME_COMPOSE_FILE" \
  bash deploy/maintenance-up.sh

updater_id="$("${COMPOSE[@]}" ps -q updater)"
[[ -n "$updater_id" ]] || die "privileged updater worker is not running"

requested_by="cli:$(id -un)@$(hostname -s 2>/dev/null || hostname)"
started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
log "Running transactional update to origin/${REPO_REF}"

"${COMPOSE[@]}" exec -T \
  -e "SIRK_REPO_REF=${REPO_REF}" \
  -e "SIRK_UPDATE_REQUESTED_BY=${requested_by}" \
  -e "SIRK_UPDATE_STARTED_AT=${started_at}" \
  updater /usr/bin/env bash /opt/sirk-central/deploy/web-update.sh

log "Verifying canonical base stack"
BASE_COMPOSE=(docker compose -f "$BASE_COMPOSE_FILE" -f "$RUNTIME_COMPOSE_FILE" --profile auth)
for service in central auth updater-gateway backup-manager caddy; do
  [[ -n "$("${BASE_COMPOSE[@]}" ps -q "$service")" ]] || die "base service is missing after update: $service"
done

central_id="$("${BASE_COMPOSE[@]}" ps -q central)"
docker exec "$central_id" node -e "fetch('http://127.0.0.1:8080/readyz').then(async r=>{const b=await r.json();if(!r.ok||!b.ok)process.exit(1)}).catch(()=>process.exit(1))" \
  || die "Central readiness validation failed after update"

log "Transactional update completed at commit $(git rev-parse --short HEAD)"
if [[ "$KEEP_MAINTENANCE_OPEN" == "true" ]]; then
  log "Maintenance worker intentionally remains open because SIRK_UPDATE_KEEP_MAINTENANCE_OPEN=true"
else
  log "Maintenance worker will now be stopped and removed"
fi
