#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

INSTALL_DIR="${SIRK_INSTALL_DIR:-/opt/sirk-central}"
REPO_URL="${SIRK_REPO_URL:-https://github.com/Eris92/SIRK-Central.git}"
REPO_REF="${SIRK_REPO_REF:-feat/central-production-hardening}"
BASE_COMPOSE_FILE="docker-compose.yml"
RUNTIME_COMPOSE_FILE="docker-compose.portal-runtime.yml"
PRESERVE_ENV=1
PURGE_DATA=0
RUN_SMOKE=1
WORK_DIR=""

log() { printf '[SIRK CLEAN] %s\n' "$*"; }
die() { printf '[SIRK CLEAN] ERROR: %s\n' "$*" >&2; exit 1; }
cleanup() { [[ -n "$WORK_DIR" && -d "$WORK_DIR" ]] && rm -rf "$WORK_DIR"; }
trap cleanup EXIT

usage() {
  cat <<'EOF'
Usage:
  sudo bash clean-reinstall.sh [options]

Options:
  --preserve-env       Preserve current .env (default).
  --new-env            Create a new .env interactively.
  --purge-data         Delete application, updater and Caddy volumes.
  --no-smoke           Skip deploy/smoke-test.sh.
  --ref <branch|tag>   Git ref to clone.
  --repo <url>         Git repository URL.
  --install-dir <path> Installation directory.

--purge-data requires: PURGE SIRK CENTRAL DATA
The privileged updater worker is always stopped/removed before checkout replacement.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --preserve-env) PRESERVE_ENV=1 ;;
    --new-env) PRESERVE_ENV=0 ;;
    --purge-data) PURGE_DATA=1 ;;
    --no-smoke) RUN_SMOKE=0 ;;
    --ref) shift; [[ $# -gt 0 ]] || die "--ref requires a value"; REPO_REF="$1" ;;
    --repo) shift; [[ $# -gt 0 ]] || die "--repo requires a value"; REPO_URL="$1" ;;
    --install-dir) shift; [[ $# -gt 0 ]] || die "--install-dir requires a value"; INSTALL_DIR="$1" ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
  shift
done

[[ "$(id -u)" -eq 0 ]] || die "run as root"
[[ -t 0 && -t 1 ]] || die "interactive terminal required"
for command in git docker; do command -v "$command" >/dev/null 2>&1 || die "$command is required"; done
docker compose version >/dev/null 2>&1 || die "Docker Compose plugin is required"
[[ "$INSTALL_DIR" == /* && "$INSTALL_DIR" != "/" ]] || die "unsafe installation path"

WORK_DIR="$(mktemp -d /var/tmp/sirk-clean-reinstall-XXXXXX)"
chmod 0700 "$WORK_DIR"

if [[ -d "$INSTALL_DIR" ]]; then
  log "Existing installation detected: $INSTALL_DIR"
  if [[ "$PRESERVE_ENV" == "1" && -f "$INSTALL_DIR/.env" ]]; then
    cp -a "$INSTALL_DIR/.env" "$WORK_DIR/.env"
    chmod 0600 "$WORK_DIR/.env"
  fi

  if [[ -f "$INSTALL_DIR/$BASE_COMPOSE_FILE" ]]; then
    OLD_COMPOSE=(docker compose -f "$INSTALL_DIR/$BASE_COMPOSE_FILE")
    [[ -f "$INSTALL_DIR/$RUNTIME_COMPOSE_FILE" ]] && OLD_COMPOSE+=(-f "$INSTALL_DIR/$RUNTIME_COMPOSE_FILE")
    OLD_COMPOSE+=(--profile auth --profile maintenance)
    if [[ "$PURGE_DATA" == "1" ]]; then
      printf '\nWARNING: this permanently removes SIRK Central data and Caddy state.\n'
      read -r -p 'Type exactly "PURGE SIRK CENTRAL DATA": ' confirmation
      [[ "$confirmation" == "PURGE SIRK CENTRAL DATA" ]] || die "purge confirmation did not match"
      "${OLD_COMPOSE[@]}" down --volumes --remove-orphans
    else
      "${OLD_COMPOSE[@]}" down --remove-orphans
    fi
  elif [[ -f "$INSTALL_DIR/compose.yaml" ]]; then
    (cd "$INSTALL_DIR" && docker compose --profile auth down --remove-orphans) || true
  fi

  cd /
  rm -rf --one-file-system "$INSTALL_DIR"
fi

log "Cloning $REPO_URL ref $REPO_REF"
install -d -m 0755 "$(dirname "$INSTALL_DIR")"
git clone --branch "$REPO_REF" --single-branch "$REPO_URL" "$INSTALL_DIR"
cd "$INSTALL_DIR"
[[ -f "$BASE_COMPOSE_FILE" && -f "$RUNTIME_COMPOSE_FILE" ]] || die "canonical Compose files are missing"
[[ -f Dockerfile.portal-runtime && -f updater/Dockerfile.gateway ]] || die "canonical Dockerfiles are missing"
if [[ -f compose.yaml ]]; then mv compose.yaml compose.yaml.disabled; fi

if [[ "$PRESERVE_ENV" == "1" && -f "$WORK_DIR/.env" ]]; then
  install -m 0600 "$WORK_DIR/.env" "$INSTALL_DIR/.env"
  log "Restored preserved .env"
else
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

  docker build --tag sirk-central:setup .
  docker run --rm -it \
    --user 0:0 \
    --volume "$INSTALL_DIR:/config" \
    --env SIRK_CONFIG_TARGET=/config \
    --env "SIRK_WEBSITE_DOMAIN=$SIRK_WEBSITE_DOMAIN" \
    --env "SIRK_CENTRAL_DOMAIN=$SIRK_CENTRAL_DOMAIN" \
    --env "SIRK_AUTH_DOMAIN=$SIRK_AUTH_DOMAIN" \
    --env "SIRK_ACME_EMAIL=$SIRK_ACME_EMAIL" \
    --env "SIRK_ADMIN_USERNAME=$SIRK_ADMIN_USERNAME" \
    sirk-central:setup node scripts/configure-production.js
  [[ -s .env ]] || die "configuration file was not created"
  chmod 0600 .env
fi

COMPOSE=(docker compose -f "$BASE_COMPOSE_FILE" -f "$RUNTIME_COMPOSE_FILE" --profile auth)
MAINTENANCE_COMPOSE=(docker compose -f "$BASE_COMPOSE_FILE" -f "$RUNTIME_COMPOSE_FILE" --profile auth --profile maintenance)
SERVICES=(central auth updater-gateway backup-manager caddy)

log "Validating canonical Compose configuration"
"${COMPOSE[@]}" config >/dev/null
mapfile -t active_services < <("${COMPOSE[@]}" config --services)
printf '%s\n' "${active_services[@]}" >/tmp/sirk-clean-services.txt
for service in "${SERVICES[@]}"; do grep -qx "$service" /tmp/sirk-clean-services.txt || die "missing service: $service"; done
if grep -qx updater /tmp/sirk-clean-services.txt; then die "privileged updater is active in base profile"; fi

log "Building and starting canonical base stack"
"${COMPOSE[@]}" up -d --build --remove-orphans "${SERVICES[@]}"
[[ -z "$("${MAINTENANCE_COMPOSE[@]}" ps -q updater)" ]] || die "privileged updater remains after clean reinstall"

log "Waiting for container-local readiness"
ready=0
for _ in $(seq 1 90); do
  if "${COMPOSE[@]}" exec -T central node -e "fetch('http://127.0.0.1:8080/readyz').then(async r=>{const j=await r.json();if(!r.ok||!j.ok)process.exit(1)}).catch(()=>process.exit(1))" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 2
done
[[ "$ready" == "1" ]] || {
  "${COMPOSE[@]}" ps >&2 || true
  "${COMPOSE[@]}" logs --tail=200 "${SERVICES[@]}" >&2 || true
  die "fresh installation did not become ready"
}

if [[ "$RUN_SMOKE" == "1" ]]; then
  SIRK_COMPOSE_FILE="$BASE_COMPOSE_FILE" \
  SIRK_RUNTIME_COMPOSE_FILE="$RUNTIME_COMPOSE_FILE" \
  SIRK_SMOKE_RESTART=1 \
  bash deploy/smoke-test.sh
fi

log "Clean reinstall completed"
printf 'Checkout: %s\n' "$(git rev-parse HEAD)"
printf 'Ref:      %s\n' "$REPO_REF"
printf 'Path:     %s\n' "$INSTALL_DIR"
printf 'Compose:  %s + %s\n' "$BASE_COMPOSE_FILE" "$RUNTIME_COMPOSE_FILE"
printf 'Worker:   stopped (gateway active)\n'
printf 'Data:     %s\n' "$([[ "$PURGE_DATA" == "1" ]] && echo 'purged' || echo 'preserved in Docker volumes')"
