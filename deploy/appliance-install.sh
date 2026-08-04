#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

REPO_URL="${SIRK_REPO_URL:-https://github.com/Eris92/SIRK-Central.git}"
REPO_REF="${SIRK_REPO_REF:-main}"
INSTALL_DIR="${SIRK_INSTALL_DIR:-/opt/sirk-central}"
CENTRAL_DOMAIN="${SIRK_CENTRAL_DOMAIN:-central.sirkportal.com}"
AUTH_DOMAIN="${SIRK_AUTH_DOMAIN:-auth.sirkportal.com}"
WEBSITE_DOMAIN="${SIRK_WEBSITE_DOMAIN:-sirkportal.com}"
ACME_EMAIL="${SIRK_ACME_EMAIL:-admin@sirkportal.com}"
FORCE="${SIRK_FORCE:-0}"

log() { printf '[SIRK] %s\n' "$*"; }
die() { printf '[SIRK] ERROR: %s\n' "$*" >&2; exit 1; }
cleanup() {
  [[ -n "${PASSWORD_FILE:-}" ]] && rm -f -- "$PASSWORD_FILE"
  [[ -n "${RESULT_FILE:-}" ]] && rm -f -- "$RESULT_FILE"
  return 0
}
trap cleanup EXIT

[[ "$(id -u)" -eq 0 ]] || die "run through sudo or as root"
[[ -r /dev/tty && -w /dev/tty ]] || die "an interactive terminal is required for the Break-Glass password"

read_secret() {
  local prompt="$1" value
  IFS= read -r -s -p "$prompt" value </dev/tty
  printf '\n' >/dev/tty
  printf '%s' "$value"
}

PASSWORD="$(read_secret 'Break-Glass password: ')"
CONFIRMATION="$(read_secret 'Repeat password: ')"
[[ "$PASSWORD" == "$CONFIRMATION" ]] || die "passwords do not match"
[[ ${#PASSWORD} -ge 14 ]] || die "password must contain at least 14 characters"
unset CONFIRMATION

[[ -r /etc/os-release ]] || die "/etc/os-release not found"
# shellcheck disable=SC1091
. /etc/os-release
case "${ID:-}" in ubuntu|debian) ;; *) die "supported systems: Ubuntu and Debian" ;; esac
[[ -n "${VERSION_CODENAME:-}" ]] || die "VERSION_CODENAME is missing"

log "Installing prerequisites"
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl git gnupg ufw

if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
  log "Installing Docker Engine and Compose"
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL "https://download.docker.com/linux/${ID}/gpg" | gpg --dearmor --yes -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
  cat >/etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/${ID}
Suites: ${VERSION_CODENAME}
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.gpg
EOF
  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
systemctl enable --now docker

if [[ -e "$INSTALL_DIR" ]]; then
  [[ "$FORCE" == "1" ]] || die "$INSTALL_DIR already exists; use SIRK_FORCE=1 only for an intentional clean reinstall"
  archive="${INSTALL_DIR}.backup-$(date -u +%Y%m%dT%H%M%SZ)"
  log "Archiving existing installation to $archive"
  if [[ -f "$INSTALL_DIR/docker-compose.appliance.yml" ]]; then
    (cd "$INSTALL_DIR" && docker compose -f docker-compose.yml -f docker-compose.appliance.yml --profile auth down --remove-orphans) || true
  else
    (cd "$INSTALL_DIR" && docker compose --profile auth --profile maintenance down --remove-orphans) || true
  fi
  mv "$INSTALL_DIR" "$archive"
fi

log "Downloading SIRK Central"
install -d -m 0755 "$(dirname "$INSTALL_DIR")"
git clone --branch "$REPO_REF" --single-branch "$REPO_URL" "$INSTALL_DIR"
cd "$INSTALL_DIR"

[[ -f docker-compose.yml ]]
[[ -f docker-compose.appliance.yml ]]
[[ -f deploy/appliance-web-update.sh ]]

PASSWORD_FILE="$(mktemp /root/.sirk-password.XXXXXX)"
RESULT_FILE="$(mktemp /root/.sirk-result.XXXXXX)"
printf '%s' "$PASSWORD" >"$PASSWORD_FILE"
chmod 0600 "$PASSWORD_FILE" "$RESULT_FILE"
unset PASSWORD

log "Generating production configuration"
docker build --tag sirk-central:setup . >/dev/null

docker run --rm \
  --user 0:0 \
  --volume "$INSTALL_DIR:/config" \
  --volume "$PASSWORD_FILE:/run/secrets/breakglass-password:ro" \
  --volume "$RESULT_FILE:/run/sirk-install-result" \
  --env SIRK_CONFIG_TARGET=/config \
  --env SIRK_ADMIN_PASSWORD_FILE=/run/secrets/breakglass-password \
  --env SIRK_INSTALL_RESULT_FILE=/run/sirk-install-result \
  --env "SIRK_WEBSITE_DOMAIN=$WEBSITE_DOMAIN" \
  --env "SIRK_CENTRAL_DOMAIN=$CENTRAL_DOMAIN" \
  --env "SIRK_AUTH_DOMAIN=$AUTH_DOMAIN" \
  --env "SIRK_ACME_EMAIL=$ACME_EMAIL" \
  sirk-central:setup node scripts/configure-production.js

[[ -s .env ]] || die "production configuration was not created"
chmod 0600 .env

log "Configuring firewall"
SSH_PORT="${SIRK_SSH_PORT:-22}"
ufw allow "${SSH_PORT}/tcp" comment SSH >/dev/null
ufw allow 80/tcp comment 'SIRK HTTP' >/dev/null
ufw allow 443/tcp comment 'SIRK HTTPS' >/dev/null
ufw status | grep -q '^Status: active' || ufw --force enable >/dev/null

COMPOSE=(docker compose -f docker-compose.yml -f docker-compose.appliance.yml --profile auth)
SERVICES=(central auth updater updater-gateway backup-manager caddy)

log "Validating appliance configuration"
"${COMPOSE[@]}" config >/dev/null
mapfile -t active_services < <("${COMPOSE[@]}" config --services)
for service in "${SERVICES[@]}"; do
  printf '%s\n' "${active_services[@]}" | grep -qx "$service" || die "missing appliance service: $service"
done

log "Starting appliance"
"${COMPOSE[@]}" up -d --build --remove-orphans "${SERVICES[@]}"

log "Waiting for readiness"
ready=0
for _ in $(seq 1 90); do
  if curl -fsS --max-time 5 "https://${CENTRAL_DOMAIN}/readyz" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 2
done
if [[ "$ready" != "1" ]]; then
  "${COMPOSE[@]}" ps >&2 || true
  "${COMPOSE[@]}" logs --tail=200 "${SERVICES[@]}" >&2 || true
  die "SIRK Central did not become ready"
fi

for service in central auth updater updater-gateway backup-manager; do
  container_id="$("${COMPOSE[@]}" ps -q "$service")"
  [[ -n "$container_id" ]] || die "$service container is missing"
  state="$(docker inspect "$container_id" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}')"
  [[ "$state" == "healthy" || "$state" == "running" ]] || die "$service is not healthy: $state"
done

log "Running first safety backup"
SIRK_BACKUP_REQUIRE_ENCRYPTION=false bash deploy/backup.sh >/dev/null

ACCESS_URL="$(node -e 'const fs=require("node:fs");const p=process.argv[1];const v=JSON.parse(fs.readFileSync(p,"utf8"));if(!v.accessUrl)process.exit(1);process.stdout.write(v.accessUrl)' "$RESULT_FILE")"
[[ -n "$ACCESS_URL" ]] || die "installer result does not contain an Access URL"

printf '\n============================================================\n'
printf 'SIRK Central installation completed.\n\n'
printf 'Open this one-time Break-Glass Access URL:\n\n%s\n' "$ACCESS_URL"
printf '============================================================\n'
printf 'Updates, backups, restore and administration are available in the web UI.\n'
printf 'SSH is reserved for infrastructure emergency access.\n'
