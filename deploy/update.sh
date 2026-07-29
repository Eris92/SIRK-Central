#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

INSTALL_DIR="${SIRK_INSTALL_DIR:-/opt/sirk-central}"
REPO_REF="${SIRK_REPO_REF:-main}"

log() {
  printf '[SIRK] %s\n' "$*"
}

die() {
  printf '[SIRK] ERROR: %s\n' "$*" >&2
  exit 1
}

[[ "$(id -u)" -eq 0 ]] || die "run this script through sudo or as root"
[[ -d "${INSTALL_DIR}/.git" ]] || die "${INSTALL_DIR} is not a Git clone; use deploy/install.sh for a clean installation"
[[ -f "${INSTALL_DIR}/.env" ]] || die "${INSTALL_DIR}/.env is missing"

cd "$INSTALL_DIR"
backup_path="/root/sirk-central-env-$(date -u +%Y%m%dT%H%M%SZ).bak"
cp -a .env "$backup_path"
chmod 0600 "$backup_path"

log "Fetching origin/${REPO_REF}"
git fetch --prune origin
git checkout "$REPO_REF"
git pull --ff-only origin "$REPO_REF"

compose=(docker compose)
if grep -q '^SIRK_ENTRA_CLIENT_ID=' .env; then
  compose+=(--profile auth)
fi

log "Validating configuration"
"${compose[@]}" config >/dev/null

log "Building and applying update"
"${compose[@]}" up -d --build --remove-orphans

"${compose[@]}" ps
log "Update completed; .env backup: ${backup_path}"
