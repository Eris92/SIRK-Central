#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

INSTALL_DIR="${SIRK_INSTALL_DIR:-/opt/sirk-central}"
BASE_COMPOSE_FILE="${SIRK_COMPOSE_FILE:-docker-compose.yml}"
RUNTIME_COMPOSE_FILE="${SIRK_RUNTIME_COMPOSE_FILE:-docker-compose.portal-runtime.yml}"
TIMEOUT_SECONDS="${SIRK_MAINTENANCE_START_TIMEOUT_SECONDS:-60}"

fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
[[ "$(id -u)" -eq 0 ]] || fail "Run as root or through sudo."
[[ -d "$INSTALL_DIR" ]] || fail "Missing installation directory: $INSTALL_DIR"
cd "$INSTALL_DIR"
[[ -f "$BASE_COMPOSE_FILE" && -f "$RUNTIME_COMPOSE_FILE" && -f .env ]] || fail "Canonical Compose files or .env are missing."
[[ "$TIMEOUT_SECONDS" =~ ^[0-9]+$ ]] || fail "SIRK_MAINTENANCE_START_TIMEOUT_SECONDS must be an integer."

COMPOSE=(docker compose -f "$BASE_COMPOSE_FILE" -f "$RUNTIME_COMPOSE_FILE" --profile auth --profile maintenance)

"${COMPOSE[@]}" config >/dev/null
"${COMPOSE[@]}" up -d --build --no-deps updater
container_id="$("${COMPOSE[@]}" ps -q updater)"
[[ -n "$container_id" ]] || fail "Updater container was not created."

for _ in $(seq 1 "$TIMEOUT_SECONDS"); do
  state="$(docker inspect "$container_id" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}')"
  [[ "$state" == "healthy" ]] && {
    printf 'Maintenance window enabled. Updater container: %s\n' "$container_id"
    printf 'Close it after the operation: sudo bash %s/deploy/maintenance-down.sh\n' "$INSTALL_DIR"
    exit 0
  }
  [[ "$state" == "unhealthy" || "$state" == "exited" || "$state" == "dead" ]] && {
    "${COMPOSE[@]}" logs --tail=200 updater >&2 || true
    fail "Updater entered state: $state"
  }
  sleep 1
done

"${COMPOSE[@]}" logs --tail=200 updater >&2 || true
fail "Updater did not become healthy within ${TIMEOUT_SECONDS}s."
