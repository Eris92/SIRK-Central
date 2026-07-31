#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

INSTALL_DIR="${SIRK_INSTALL_DIR:-/opt/sirk-central}"
BASE_COMPOSE_FILE="${SIRK_COMPOSE_FILE:-docker-compose.yml}"
RUNTIME_COMPOSE_FILE="${SIRK_RUNTIME_COMPOSE_FILE:-docker-compose.portal-runtime.yml}"
PROFILE="${SIRK_COMPOSE_PROFILE:-auth}"

fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
require() { command -v "$1" >/dev/null 2>&1 || fail "Missing required command: $1"; }

[[ "$(id -u)" -eq 0 ]] || fail "Run as root or through sudo."
require docker
[[ -d "$INSTALL_DIR" ]] || fail "Missing installation directory: $INSTALL_DIR"
cd "$INSTALL_DIR"

[[ -f "$BASE_COMPOSE_FILE" ]] || fail "Missing Compose file: $INSTALL_DIR/$BASE_COMPOSE_FILE"
[[ -f "$RUNTIME_COMPOSE_FILE" ]] || fail "Missing runtime overlay: $INSTALL_DIR/$RUNTIME_COMPOSE_FILE"
if [[ -f compose.yaml && "$BASE_COMPOSE_FILE" != "compose.yaml" ]]; then
  echo "Disabling obsolete compose.yaml to prevent Docker Compose selecting the wrong stack."
  mv compose.yaml compose.yaml.disabled
fi

if [[ -f .env ]]; then
  fail ".env already exists; refusing to replace production credentials."
fi

read -r -p 'Website domain [sirkportal.com]: ' SIRK_WEBSITE_DOMAIN
SIRK_WEBSITE_DOMAIN="${SIRK_WEBSITE_DOMAIN:-sirkportal.com}"
read -r -p "Central domain [central.${SIRK_WEBSITE_DOMAIN}]: " SIRK_CENTRAL_DOMAIN
SIRK_CENTRAL_DOMAIN="${SIRK_CENTRAL_DOMAIN:-central.${SIRK_WEBSITE_DOMAIN}}"
read -r -p "Auth domain [auth.${SIRK_WEBSITE_DOMAIN}]: " SIRK_AUTH_DOMAIN
SIRK_AUTH_DOMAIN="${SIRK_AUTH_DOMAIN:-auth.${SIRK_WEBSITE_DOMAIN}}"
read -r -p "ACME email [admin@${SIRK_WEBSITE_DOMAIN}]: " SIRK_ACME_EMAIL
SIRK_ACME_EMAIL="${SIRK_ACME_EMAIL:-admin@${SIRK_WEBSITE_DOMAIN}}"
read -r -p 'BreakGlass username [admin]: ' SIRK_ADMIN_USERNAME
SIRK_ADMIN_USERNAME="${SIRK_ADMIN_USERNAME:-admin}"

: "${SIRK_SESSION_IDLE_MINUTES:=30}"
: "${SIRK_SESSION_ABSOLUTE_HOURS:=8}"

printf 'Building one-time configuration image...\n'
docker build --tag sirk-central:setup .
docker run --rm -it \
  --user 0:0 \
  --volume "${INSTALL_DIR}:/config" \
  --env SIRK_CONFIG_TARGET=/config \
  --env "SIRK_WEBSITE_DOMAIN=${SIRK_WEBSITE_DOMAIN}" \
  --env "SIRK_CENTRAL_DOMAIN=${SIRK_CENTRAL_DOMAIN}" \
  --env "SIRK_AUTH_DOMAIN=${SIRK_AUTH_DOMAIN}" \
  --env "SIRK_ACME_EMAIL=${SIRK_ACME_EMAIL}" \
  --env "SIRK_ADMIN_USERNAME=${SIRK_ADMIN_USERNAME}" \
  --env "SIRK_SESSION_IDLE_MINUTES=${SIRK_SESSION_IDLE_MINUTES}" \
  --env "SIRK_SESSION_ABSOLUTE_HOURS=${SIRK_SESSION_ABSOLUTE_HOURS}" \
  sirk-central:setup node scripts/configure-production.js

[[ -s .env ]] || fail "Configuration file was not created."
chmod 0600 .env

COMPOSE=(docker compose -f "$BASE_COMPOSE_FILE" -f "$RUNTIME_COMPOSE_FILE" --profile "$PROFILE")
SERVICES=(central auth backup-manager caddy)

printf 'Validating canonical Compose stack...\n'
"${COMPOSE[@]}" config >/dev/null

printf 'Building and starting canonical v15 services without Docker socket access...\n'
"${COMPOSE[@]}" up -d --build --remove-orphans "${SERVICES[@]}"
"${COMPOSE[@]}" ps "${SERVICES[@]}"

for service in central auth backup-manager; do
  container_id="$("${COMPOSE[@]}" ps -q "$service")"
  [[ -n "$container_id" ]] || fail "Service $service was not created."
done

if docker ps --format '{{.Names}}' | grep -Eq '(^|[-_])updater($|[-_])'; then
  fail "Updater is unexpectedly running outside a maintenance window."
fi

printf 'Configuration completed. The privileged updater is disabled by default.\n'
printf 'Open a maintenance window only when required: sudo bash %s/deploy/maintenance-up.sh\n' "$INSTALL_DIR"
printf 'Close it immediately after update/restore: sudo bash %s/deploy/maintenance-down.sh\n' "$INSTALL_DIR"
printf 'Run deploy/acceptance-test.sh before production use.\n'
