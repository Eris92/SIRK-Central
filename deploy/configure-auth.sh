#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

INSTALL_DIR="${SIRK_INSTALL_DIR:-/opt/sirk-central}"
BASE_COMPOSE_FILE="${SIRK_COMPOSE_FILE:-docker-compose.yml}"
RUNTIME_COMPOSE_FILE="${SIRK_RUNTIME_COMPOSE_FILE:-docker-compose.portal-runtime.yml}"

fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
[[ "$(id -u)" -eq 0 ]] || fail "Run as root or through sudo."
[[ -t 0 && -t 1 ]] || fail "Interactive terminal required."
[[ -d "$INSTALL_DIR" ]] || fail "Missing installation directory: $INSTALL_DIR"
cd "$INSTALL_DIR"
[[ -f .env ]] || fail ".env is missing."
[[ -f "$BASE_COMPOSE_FILE" && -f "$RUNTIME_COMPOSE_FILE" ]] || fail "Canonical Compose files are missing."

command -v openssl >/dev/null 2>&1 || {
  apt-get update
  apt-get install -y openssl
}

read -r -p "Microsoft Entra Application (client) ID: " CLIENT_ID
read -r -p "Allowed admin identities (tenant-id:object-id, comma-separated): " ADMIN_IDENTITIES
read -r -s -p "Microsoft Entra client secret: " CLIENT_SECRET
printf '\n'
read -r -s -p "Repeat client secret: " CLIENT_SECRET_CONFIRM
printf '\n'

UUID='[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'
[[ "$CLIENT_ID" =~ ^${UUID}$ ]] || fail "Invalid client ID."
[[ -n "$CLIENT_SECRET" && "${#CLIENT_SECRET}" -le 2048 ]] || fail "Client secret is empty or too long."
[[ "$CLIENT_SECRET" == "$CLIENT_SECRET_CONFIRM" ]] || fail "Client secrets do not match."
[[ "$CLIENT_SECRET" != *$'\n'* && "$CLIENT_SECRET" != *$'\r'* ]] || fail "Client secret contains a newline."
IFS=',' read -ra IDENTITIES <<< "$ADMIN_IDENTITIES"
[[ "${#IDENTITIES[@]}" -gt 0 ]] || fail "At least one admin identity is required."
NORMALIZED_IDENTITIES=()
for identity in "${IDENTITIES[@]}"; do
  identity="${identity//[[:space:]]/}"
  [[ "$identity" =~ ^${UUID}:${UUID}$ ]] || fail "Invalid admin identity: $identity"
  NORMALIZED_IDENTITIES+=("$identity")
done
ADMIN_IDENTITIES="$(IFS=,; printf '%s' "${NORMALIZED_IDENTITIES[*]}")"
unset CLIENT_SECRET_CONFIRM

AUTH_DOMAIN="${SIRK_AUTH_DOMAIN:-auth.sirkportal.com}"
ENTRA_TENANT="${SIRK_ENTRA_TENANT:-organizations}"
[[ "$AUTH_DOMAIN" =~ ^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$ ]] || fail "Invalid Auth domain."
[[ "$ENTRA_TENANT" =~ ^(organizations|common|consumers|${UUID})$ ]] || fail "Invalid Entra tenant value."
SHARED_SECRET="$(openssl rand -base64 48 | tr -d '\n' | tr '+/' '-_')"
TMP="$(mktemp "$INSTALL_DIR/.env.auth.XXXXXX")"
trap 'rm -f "$TMP"; unset CLIENT_SECRET SHARED_SECRET ADMIN_IDENTITIES' EXIT

# Docker Compose dotenv double-quoted values use backslash escaping.
dotenv_escape() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  printf '%s' "$value"
}

awk '!/^SIRK_AUTH_DOMAIN=|^SIRK_AUTH_ORIGIN=|^SIRK_ENTRA_TENANT=|^SIRK_ENTRA_CLIENT_ID=|^SIRK_ENTRA_CLIENT_SECRET=|^SIRK_ENTRA_ADMIN_IDENTITIES=|^SIRK_SSO_SHARED_SECRET=/' .env > "$TMP"
{
  printf 'SIRK_AUTH_DOMAIN="%s"\n' "$(dotenv_escape "$AUTH_DOMAIN")"
  printf 'SIRK_AUTH_ORIGIN="https://%s"\n' "$(dotenv_escape "$AUTH_DOMAIN")"
  printf 'SIRK_ENTRA_TENANT="%s"\n' "$(dotenv_escape "$ENTRA_TENANT")"
  printf 'SIRK_ENTRA_CLIENT_ID="%s"\n' "$(dotenv_escape "$CLIENT_ID")"
  printf 'SIRK_ENTRA_CLIENT_SECRET="%s"\n' "$(dotenv_escape "$CLIENT_SECRET")"
  printf 'SIRK_ENTRA_ADMIN_IDENTITIES="%s"\n' "$(dotenv_escape "$ADMIN_IDENTITIES")"
  printf 'SIRK_SSO_SHARED_SECRET="%s"\n' "$(dotenv_escape "$SHARED_SECRET")"
} >> "$TMP"

chmod 0600 "$TMP"
# Validate the new file through canonical Compose before replacing production .env.
COMPOSE=(docker compose -f "$BASE_COMPOSE_FILE" -f "$RUNTIME_COMPOSE_FILE" --profile auth)
MAINTENANCE_COMPOSE=(docker compose -f "$BASE_COMPOSE_FILE" -f "$RUNTIME_COMPOSE_FILE" --profile auth --profile maintenance)
mv .env .env.before-auth
chmod 0600 .env.before-auth
mv "$TMP" .env
TMP=""
if ! "${COMPOSE[@]}" config >/dev/null; then
  mv .env .env.invalid-auth
  mv .env.before-auth .env
  fail "Canonical Compose rejected the new Auth configuration; previous .env restored."
fi

SERVICES=(central auth updater-gateway backup-manager caddy)
if ! "${COMPOSE[@]}" up -d --build --force-recreate --remove-orphans "${SERVICES[@]}"; then
  mv .env .env.failed-auth
  mv .env.before-auth .env
  "${COMPOSE[@]}" up -d --force-recreate --remove-orphans "${SERVICES[@]}" || true
  fail "Auth deployment failed; previous .env restored."
fi
rm -f .env.before-auth
[[ -z "$("${MAINTENANCE_COMPOSE[@]}" ps -q updater)" ]] || fail "Privileged updater worker is running outside maintenance."

"${COMPOSE[@]}" ps "${SERVICES[@]}"
printf '\nAuth Broker configured.\n'
printf 'Login URL: https://%s/login\n' "$AUTH_DOMAIN"
printf 'Updater gateway active; privileged worker stopped.\n'
