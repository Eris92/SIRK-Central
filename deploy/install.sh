#!/usr/bin/env bash
set -Eeuo pipefail
umask 022

REPO_URL="${SIRK_REPO_URL:-https://github.com/Eris92/SIRK-Central.git}"
REPO_REF="${SIRK_REPO_REF:-main}"
INSTALL_DIR="${SIRK_INSTALL_DIR:-/opt/sirk-central}"
FORCE_INSTALL="${SIRK_FORCE:-0}"
CONFIGURE_UFW="${SIRK_CONFIGURE_UFW:-1}"

log() { printf '[SIRK] %s\n' "$*"; }
die() { printf '[SIRK] ERROR: %s\n' "$*" >&2; exit 1; }
on_error() {
  local line="$1" command="$2"
  if [[ "${BASH_SUBSHELL:-0}" -eq 0 ]]; then
    printf '[SIRK] ERROR: installation failed at line %s: %s\n' "$line" "$command" >&2
  fi
}
trap 'on_error "$LINENO" "$BASH_COMMAND"' ERR

usage() {
  cat <<'EOF'
SIRK Central canonical flat runtime clean installer

Usage:
  sudo bash install.sh [--force] [--no-ufw]

The installer creates a clean deployment using docker-compose.yml together with
docker-compose.yml. The privileged updater worker is not started;
only the unprivileged updater gateway is part of the base stack.

Optional environment variables:
  SIRK_REPO_URL                    Git repository URL
  SIRK_REPO_REF                    Branch or tag, default: main
  SIRK_INSTALL_DIR                 Installation path, default: /opt/sirk-central
  SIRK_WEBSITE_DOMAIN              Public website domain
  SIRK_CENTRAL_DOMAIN              SIRK Central domain
  SIRK_AUTH_DOMAIN                 SIRK Auth domain
  SIRK_ACME_EMAIL                  Let's Encrypt contact address
  SIRK_ADMIN_USERNAME              Initial break-glass username
  SIRK_SESSION_IDLE_MINUTES        Idle timeout, 5-1440, default: 30
  SIRK_SESSION_ABSOLUTE_HOURS      Absolute lifetime, 1-168, default: 8
  SIRK_FORCE=1                     Archive an existing installation and continue
  SIRK_CONFIGURE_UFW=0             Do not modify UFW
  SIRK_SSH_PORT                    SSH port to allow in UFW
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --force) FORCE_INSTALL=1 ;;
    --no-ufw) CONFIGURE_UFW=0 ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
  shift
done

[[ "$(id -u)" -eq 0 ]] || die "run this installer through sudo or as root"
[[ -t 0 && -t 1 ]] || die "interactive terminal required; download the script first, then run it with sudo bash"

prompt_default() {
  local variable_name="$1" prompt="$2" default_value="$3"
  local current_value="${!variable_name:-}" entered=""
  [[ -n "$current_value" ]] && return
  read -r -p "${prompt} [${default_value}]: " entered
  printf -v "$variable_name" '%s' "${entered:-$default_value}"
}
valid_domain() { [[ "$1" =~ ^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$ ]]; }

prompt_default SIRK_WEBSITE_DOMAIN "Public website domain" "sirkportal.com"
prompt_default SIRK_CENTRAL_DOMAIN "SIRK Central domain" "central.${SIRK_WEBSITE_DOMAIN}"
prompt_default SIRK_AUTH_DOMAIN "SIRK Auth domain" "auth.${SIRK_WEBSITE_DOMAIN}"
prompt_default SIRK_ACME_EMAIL "Let's Encrypt email" "admin@${SIRK_WEBSITE_DOMAIN}"
prompt_default SIRK_ADMIN_USERNAME "Initial break-glass username" "admin"
prompt_default SIRK_SESSION_IDLE_MINUTES "Session idle timeout in minutes" "30"
prompt_default SIRK_SESSION_ABSOLUTE_HOURS "Absolute session lifetime in hours" "8"

valid_domain "$SIRK_WEBSITE_DOMAIN" || die "invalid website domain: $SIRK_WEBSITE_DOMAIN"
valid_domain "$SIRK_CENTRAL_DOMAIN" || die "invalid Central domain: $SIRK_CENTRAL_DOMAIN"
valid_domain "$SIRK_AUTH_DOMAIN" || die "invalid Auth domain: $SIRK_AUTH_DOMAIN"
[[ "$SIRK_ACME_EMAIL" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]] || die "invalid ACME email"
[[ "$SIRK_ADMIN_USERNAME" =~ ^[A-Za-z0-9._-]{3,64}$ ]] || die "administrator username must use 3-64 letters, digits, dots, underscores or hyphens"
[[ "$SIRK_SESSION_IDLE_MINUTES" =~ ^[0-9]+$ ]] || die "idle timeout must be numeric"
[[ "$SIRK_SESSION_ABSOLUTE_HOURS" =~ ^[0-9]+$ ]] || die "absolute session lifetime must be numeric"
(( SIRK_SESSION_IDLE_MINUTES >= 5 && SIRK_SESSION_IDLE_MINUTES <= 1440 )) || die "idle timeout must be between 5 and 1440 minutes"
(( SIRK_SESSION_ABSOLUTE_HOURS >= 1 && SIRK_SESSION_ABSOLUTE_HOURS <= 168 )) || die "absolute session lifetime must be between 1 and 168 hours"

[[ -r /etc/os-release ]] || die "/etc/os-release not found"
# shellcheck disable=SC1091
. /etc/os-release
case "${ID:-}" in ubuntu|debian) ;; *) die "supported systems: Ubuntu and Debian; detected: ${PRETTY_NAME:-unknown}" ;; esac
[[ -n "${VERSION_CODENAME:-}" ]] || die "VERSION_CODENAME is missing in /etc/os-release"

log "Installing operating-system prerequisites"
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl git gnupg ufw

if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
  log "Installing Docker Engine and Compose plugin"
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL "https://download.docker.com/linux/${ID}/gpg" | gpg --dearmor --yes -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
  cat > /etc/apt/sources.list.d/docker.sources <<EOF
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

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
if [[ -e "$INSTALL_DIR" ]]; then
  [[ "$FORCE_INSTALL" == "1" ]] || die "$INSTALL_DIR already exists; use --force or SIRK_FORCE=1 to archive it"
  backup_dir="${INSTALL_DIR}.backup-${timestamp}"
  log "Stopping and archiving existing installation to ${backup_dir}"
  if [[ -f "${INSTALL_DIR}/docker-compose.yml" ]]; then
    old_compose=(docker compose -f "${INSTALL_DIR}/docker-compose.yml")
    [[ -f "${INSTALL_DIR}/docker-compose.yml" ]] && old_compose+=(-f "${INSTALL_DIR}/docker-compose.yml")
    "${old_compose[@]}" --profile auth --profile maintenance down --remove-orphans || true
  elif [[ -f "${INSTALL_DIR}/compose.yaml" ]]; then
    (cd "$INSTALL_DIR" && docker compose down --remove-orphans) || true
  fi
  mv "$INSTALL_DIR" "$backup_dir"
fi

log "Cloning ${REPO_URL} (${REPO_REF}) into ${INSTALL_DIR}"
install -d -m 0755 "$(dirname "$INSTALL_DIR")"
git clone --branch "$REPO_REF" --single-branch "$REPO_URL" "$INSTALL_DIR"
cd "$INSTALL_DIR"

[[ -f docker-compose.yml ]] || die "canonical Compose files are missing"
[[ -f Dockerfile ]] || die "canonical runtime Dockerfile is missing"

log "Building setup image"
docker build --tag sirk-central:setup .

log "Creating production configuration"
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

[[ -s .env ]] || die "configuration file was not created"
chmod 0600 .env

if [[ "$CONFIGURE_UFW" == "1" ]]; then
  SSH_PORT="${SIRK_SSH_PORT:-}"
  [[ -z "$SSH_PORT" && -n "${SSH_CONNECTION:-}" ]] && SSH_PORT="${SSH_CONNECTION##* }"
  SSH_PORT="${SSH_PORT:-22}"
  [[ "$SSH_PORT" =~ ^[0-9]+$ ]] || die "invalid SSH port: $SSH_PORT"
  log "Configuring UFW for SSH ${SSH_PORT}/tcp, HTTP and HTTPS"
  ufw allow "${SSH_PORT}/tcp" comment "SSH"
  ufw allow 80/tcp comment "SIRK ACME HTTP"
  ufw allow 443/tcp comment "SIRK HTTPS"
  ufw status | grep -q '^Status: active' || ufw --force enable
fi

COMPOSE=(docker compose -f docker-compose.yml --profile auth)
MAINTENANCE_COMPOSE=(docker compose -f docker-compose.yml --profile auth --profile maintenance)
SERVICES=(central auth updater-gateway backup-manager caddy)

log "Validating canonical Docker Compose configuration"
"${COMPOSE[@]}" config >/dev/null
mapfile -t active_services < <("${COMPOSE[@]}" config --services)
printf '%s\n' "${active_services[@]}" >/tmp/sirk-install-services.txt
for service in "${SERVICES[@]}"; do grep -qx "$service" /tmp/sirk-install-services.txt || die "missing base service: $service"; done
if grep -qx updater /tmp/sirk-install-services.txt; then die "privileged updater worker is active in the base profile"; fi

log "Starting canonical SIRK Central v15 stack"
"${COMPOSE[@]}" up -d --build --remove-orphans "${SERVICES[@]}"
[[ -z "$("${MAINTENANCE_COMPOSE[@]}" ps -q updater)" ]] || die "privileged updater worker started outside maintenance window"

log "Waiting for public readiness"
ready=0
for _ in $(seq 1 90); do
  if curl -fsS --max-time 5 "https://${SIRK_CENTRAL_DOMAIN}/readyz" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 2
done

if [[ "$ready" != "1" ]]; then
  "${COMPOSE[@]}" ps >&2 || true
  "${COMPOSE[@]}" logs --tail=200 central auth updater-gateway backup-manager caddy >&2 || true
  die "SIRK Central did not become ready"
fi

"${COMPOSE[@]}" ps "${SERVICES[@]}"
printf '\nSIRK Central v15 clean installation completed.\n\n'
printf 'Website:      https://%s\n' "$SIRK_WEBSITE_DOMAIN"
printf 'Central:      https://%s\n' "$SIRK_CENTRAL_DOMAIN"
printf 'Auth:         https://%s\n' "$SIRK_AUTH_DOMAIN"
printf 'Readiness:    https://%s/readyz\n' "$SIRK_CENTRAL_DOMAIN"
printf 'Username:     %s\n\n' "$SIRK_ADMIN_USERNAME"
printf 'The one-time Access URL was displayed by the configuration step above.\n'
printf 'Updater gateway is active without Docker socket; the privileged worker is disabled.\n'
printf 'Open maintenance only when required: sudo bash %s/deploy/maintenance-up.sh\n' "$INSTALL_DIR"
printf 'Close it immediately afterward: sudo bash %s/deploy/maintenance-down.sh\n' "$INSTALL_DIR"
printf 'Run acceptance before production use: sudo bash %s/deploy/acceptance-test.sh\n' "$INSTALL_DIR"
