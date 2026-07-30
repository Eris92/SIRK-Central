#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

INSTALL_DIR="${SIRK_INSTALL_DIR:-/opt/sirk-central}"
COMPOSE_FILE="${SIRK_COMPOSE_FILE:-docker-compose.yml}"

[[ "$(id -u)" -eq 0 ]] || { echo "Run as root or through sudo." >&2; exit 1; }
[[ -d "$INSTALL_DIR" ]] || { echo "Missing installation directory: $INSTALL_DIR" >&2; exit 1; }
cd "$INSTALL_DIR"

[[ -f "$COMPOSE_FILE" ]] || { echo "Missing Compose file: $INSTALL_DIR/$COMPOSE_FILE" >&2; exit 1; }
if [[ -f compose.yaml && "$COMPOSE_FILE" != "compose.yaml" ]]; then
  echo "Disabling obsolete compose.yaml to prevent Docker Compose selecting the wrong stack."
  mv compose.yaml compose.yaml.disabled
fi

if [[ -f .env ]]; then
  echo ".env already exists; refusing to replace production credentials." >&2
  exit 1
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

[[ -s .env ]] || { echo "Configuration file was not created." >&2; exit 1; }
chmod 0600 .env

COMPOSE=(docker compose -f "$COMPOSE_FILE" --profile auth)
"${COMPOSE[@]}" config >/dev/null
"${COMPOSE[@]}" up -d --build --remove-orphans central auth caddy
"${COMPOSE[@]}" ps
