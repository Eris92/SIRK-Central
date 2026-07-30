#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

INSTALL_DIR="${SIRK_INSTALL_DIR:-/opt/sirk-central}"
REPO_URL="${SIRK_REPO_URL:-https://github.com/Eris92/SIRK-Central.git}"
REPO_REF="${SIRK_REPO_REF:-feat/central-production-hardening}"
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
  --preserve-env       Preserve the current .env file (default).
  --new-env            Do not preserve .env; run interactive configuration again.
  --purge-data         Delete the central-data, updater-state and Caddy volumes.
  --no-smoke           Skip deploy/smoke-test.sh after installation.
  --ref <branch|tag>   Git ref to clone.
  --repo <url>         Git repository URL.
  --install-dir <path> Installation directory.
  -h, --help           Show help.

Safety:
  --purge-data permanently removes sessions, users, organizations, passkeys,
  recovery-code hashes, WebAuthn challenges and Caddy certificates/state.
  It requires the exact confirmation phrase: PURGE SIRK CENTRAL DATA
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
command -v git >/dev/null 2>&1 || die "git is required"
command -v docker >/dev/null 2>&1 || die "docker is required"
docker compose version >/dev/null 2>&1 || die "Docker Compose plugin is required"
[[ "$INSTALL_DIR" == /* && "$INSTALL_DIR" != "/" ]] || die "unsafe installation path"

WORK_DIR="$(mktemp -d /var/tmp/sirk-clean-reinstall-XXXXXX)"
chmod 0700 "$WORK_DIR"

if [[ -d "$INSTALL_DIR" ]]; then
  log "Existing installation detected: $INSTALL_DIR"
  if [[ "$PRESERVE_ENV" == "1" && -f "$INSTALL_DIR/.env" ]]; then
    cp -a "$INSTALL_DIR/.env" "$WORK_DIR/.env"
    chmod 0600 "$WORK_DIR/.env"
    log "Production .env saved temporarily"
  fi

  if [[ -f "$INSTALL_DIR/compose.yaml" || -f "$INSTALL_DIR/docker-compose.yml" ]]; then
    cd "$INSTALL_DIR"
    if [[ "$PURGE_DATA" == "1" ]]; then
      printf '\nWARNING: this will permanently remove all SIRK Central application data and Caddy state.\n'
      read -r -p 'Type exactly "PURGE SIRK CENTRAL DATA": ' confirmation
      [[ "$confirmation" == "PURGE SIRK CENTRAL DATA" ]] || die "purge confirmation did not match"
      log "Stopping stack and deleting project volumes"
      docker compose --profile auth down --volumes --remove-orphans
    else
      log "Stopping stack while preserving named volumes"
      docker compose --profile auth down --remove-orphans
    fi
  fi

  log "Removing old checkout"
  rm -rf --one-file-system "$INSTALL_DIR"
fi

log "Cloning $REPO_URL ref $REPO_REF"
install -d -m 0755 "$(dirname "$INSTALL_DIR")"
git clone --branch "$REPO_REF" --single-branch "$REPO_URL" "$INSTALL_DIR"
cd "$INSTALL_DIR"

if [[ "$PRESERVE_ENV" == "1" && -f "$WORK_DIR/.env" ]]; then
  install -m 0600 "$WORK_DIR/.env" "$INSTALL_DIR/.env"
  log "Restored preserved .env"
  log "Validating Compose configuration"
  docker compose --profile auth config >/dev/null
  log "Building and starting a completely fresh checkout"
  docker compose --profile auth up -d --build --remove-orphans central auth caddy
else
  log "No .env restored; starting the interactive clean installer"
  export SIRK_REPO_URL="$REPO_URL"
  export SIRK_REPO_REF="$REPO_REF"
  export SIRK_INSTALL_DIR="$INSTALL_DIR"
  bash deploy/configure-and-start.sh
fi

log "Waiting for container-local readiness"
ready=0
for _ in $(seq 1 90); do
  if docker compose exec -T central node -e "fetch('http://127.0.0.1:8080/readyz').then(async r=>{const j=await r.json();if(!r.ok||!j.ok)process.exit(1)}).catch(()=>process.exit(1))" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 2
done
[[ "$ready" == "1" ]] || { docker compose ps >&2 || true; docker compose logs --tail=200 central auth caddy >&2 || true; die "fresh installation did not become ready"; }

if [[ "$RUN_SMOKE" == "1" ]]; then
  chmod +x deploy/smoke-test.sh
  SIRK_SMOKE_RESTART=1 bash deploy/smoke-test.sh
fi

log "Clean reinstall completed"
printf 'Checkout: %s\n' "$(git rev-parse HEAD)"
printf 'Ref:      %s\n' "$REPO_REF"
printf 'Path:     %s\n' "$INSTALL_DIR"
printf 'Data:     %s\n' "$([[ "$PURGE_DATA" == "1" ]] && echo 'purged' || echo 'preserved in Docker volumes')"
