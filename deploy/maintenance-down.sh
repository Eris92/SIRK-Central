#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

INSTALL_DIR="${SIRK_INSTALL_DIR:-/opt/sirk-central}"
BASE_COMPOSE_FILE="${SIRK_COMPOSE_FILE:-docker-compose.yml}"
RUNTIME_COMPOSE_FILE="${SIRK_RUNTIME_COMPOSE_FILE:-docker-compose.portal-runtime.yml}"

fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
[[ "$(id -u)" -eq 0 ]] || fail "Run as root or through sudo."
[[ -d "$INSTALL_DIR" ]] || fail "Missing installation directory: $INSTALL_DIR"
cd "$INSTALL_DIR"
[[ -f "$BASE_COMPOSE_FILE" && -f "$RUNTIME_COMPOSE_FILE" ]] || fail "Canonical Compose files are missing."

COMPOSE=(docker compose -f "$BASE_COMPOSE_FILE" -f "$RUNTIME_COMPOSE_FILE" --profile auth --profile maintenance)
"${COMPOSE[@]}" stop -t 15 updater || true
"${COMPOSE[@]}" rm -f updater || true

if "${COMPOSE[@]}" ps -q updater | grep -q .; then
  fail "Updater container is still present."
fi
printf 'Maintenance window closed. Docker socket is no longer mounted in a running SIRK container.\n'
