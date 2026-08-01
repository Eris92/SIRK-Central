#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

INSTALL_DIR="${SIRK_INSTALL_DIR:-/opt/sirk-central}"
REPO_REF="${SIRK_REPO_REF:-main}"
EXPECTED_REMOTE="${SIRK_EXPECTED_REMOTE:-https://github.com/Eris92/SIRK-Central}"
LOG_DIR="/root/sirk-central-appliance-migration-$(date -u +%Y%m%dT%H%M%SZ)"
ENV_BACKUP="${LOG_DIR}/environment.env"
STATE_FILE="${LOG_DIR}/state.env"
PREVIOUS_COMMIT=""
TARGET_COMMIT=""
MIGRATION_COMPLETE=0

log() { printf '[SIRK] %s\n' "$*"; }
die() { printf '[SIRK] ERROR: %s\n' "$*" >&2; exit 1; }
compose_base() { docker compose -f docker-compose.yml --profile auth "$@"; }
compose_appliance() { docker compose -f docker-compose.yml -f docker-compose.appliance.yml --profile auth "$@"; }

rollback() {
    local code="$1"
    [[ "$MIGRATION_COMPLETE" == "0" ]] || exit "$code"
    trap - ERR
    log "Migration failed; restoring previous repository and base stack"
    if [[ -n "$PREVIOUS_COMMIT" && -d "$INSTALL_DIR/.git" ]]; then
        cd "$INSTALL_DIR"
        git reset --hard "$PREVIOUS_COMMIT" || true
        if [[ -s "$ENV_BACKUP" ]]; then
            install -m 0600 "$ENV_BACKUP" .env || true
        fi
        docker compose -f docker-compose.yml --profile auth up -d --build --force-recreate --remove-orphans \
            central auth updater-gateway backup-manager caddy || true
    fi
    printf '[SIRK] Migration log: %s\n' "$LOG_DIR" >&2
    exit "$code"
}
trap 'rollback $?' ERR

[[ "$(id -u)" -eq 0 ]] || die "run through sudo or as root"
[[ -d "$INSTALL_DIR/.git" ]] || die "existing SIRK Central repository not found at $INSTALL_DIR"
[[ -f "$INSTALL_DIR/.env" ]] || die "existing production .env not found"
for command in git docker node npm curl; do command -v "$command" >/dev/null 2>&1 || die "required command is missing: $command"; done
docker compose version >/dev/null 2>&1 || die "Docker Compose plugin is unavailable"

install -d -m 0700 "$LOG_DIR"
exec > >(tee -a "${LOG_DIR}/migration.log") 2>&1
cd "$INSTALL_DIR"

PREVIOUS_COMMIT="$(git rev-parse HEAD)"
REMOTE_URL="$(git remote get-url origin)"
case "$REMOTE_URL" in
    "$EXPECTED_REMOTE"|"${EXPECTED_REMOTE}.git") ;;
    *) die "unexpected Git origin: $REMOTE_URL" ;;
esac

install -m 0600 .env "$ENV_BACKUP"
printf 'PREVIOUS_COMMIT=%q\n' "$PREVIOUS_COMMIT" > "$STATE_FILE"
chmod 0600 "$STATE_FILE"

log "Creating pre-migration safety backup"
SIRK_BACKUP_REQUIRE_ENCRYPTION=false bash deploy/backup.sh

log "Fetching canonical appliance release"
git fetch --prune origin "+refs/heads/${REPO_REF}:refs/remotes/origin/${REPO_REF}"
TARGET_COMMIT="$(git rev-parse "origin/${REPO_REF}")"
[[ "$TARGET_COMMIT" =~ ^[0-9a-f]{40}$ ]] || die "target commit is invalid"
printf 'TARGET_COMMIT=%q\n' "$TARGET_COMMIT" >> "$STATE_FILE"

git checkout -B "$REPO_REF" "origin/$REPO_REF"
git reset --hard "$TARGET_COMMIT"
[[ -f docker-compose.appliance.yml ]] || die "appliance overlay is missing"
[[ -f updater/appliance-restore-server.js ]] || die "encrypted restore worker is missing"
install -m 0600 "$ENV_BACKUP" .env

log "Running source, security and dependency validation"
npm ci
npm run check:syntax
SIRK_CONCURRENCY_TEST_REQUESTS="${SIRK_CONCURRENCY_TEST_REQUESTS:-24}" npm test
npm audit --omit=dev --audit-level=high

log "Validating appliance Compose configuration"
compose_appliance config > "${LOG_DIR}/compose-appliance.yml"
mapfile -t SERVICES < <(compose_appliance config --services)
for required in central auth caddy updater-gateway updater backup-manager; do
    printf '%s\n' "${SERVICES[@]}" | grep -qx "$required" || die "appliance service missing: $required"
done

log "Building appliance images"
compose_appliance build --pull central auth updater-gateway updater backup-manager

log "Starting appliance stack"
compose_appliance up -d --force-recreate --remove-orphans \
    central auth updater-gateway updater backup-manager caddy

log "Waiting for healthy services"
for attempt in $(seq 1 90); do
    unhealthy=0
    for service in central auth updater-gateway updater backup-manager; do
        id="$(compose_appliance ps -q "$service")"
        [[ -n "$id" ]] || { unhealthy=1; continue; }
        state="$(docker inspect "$id" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' 2>/dev/null || true)"
        [[ "$state" == "healthy" || "$state" == "running" ]] || unhealthy=1
    done
    if [[ "$unhealthy" == "0" ]]; then break; fi
    [[ "$attempt" -lt 90 ]] || die "appliance services did not become healthy"
    sleep 2
done

CENTRAL_DOMAIN="$(python3 scripts/read-env-value.py .env SIRK_CENTRAL_DOMAIN 2>/dev/null || true)"
CENTRAL_DOMAIN="${CENTRAL_DOMAIN:-central.sirkportal.com}"
curl -fsS --max-time 30 "https://${CENTRAL_DOMAIN}/readyz" > "${LOG_DIR}/readyz.json"

docker inspect "$(compose_appliance ps -q updater)" --format '{{json .NetworkSettings.Ports}}' > "${LOG_DIR}/updater-ports.json"
if grep -Eq '0\.0\.0\.0|:::' "${LOG_DIR}/updater-ports.json"; then
    die "privileged updater unexpectedly publishes a host port"
fi

MIGRATION_COMPLETE=1
trap - ERR

log "Appliance migration completed"
printf '\n============================================================\n'
printf 'SIRK Central appliance mode is active.\n'
printf 'Commit: %s\n' "$TARGET_COMMIT"
printf 'Open: https://%s\n' "$CENTRAL_DOMAIN"
printf 'Updates, backups, restore and diagnostics are now available in the web UI.\n'
printf 'Migration log: %s\n' "$LOG_DIR"
printf '============================================================\n'
