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

# Central and Auth Broker must always share the same signing secret. Older
# installations may not have it because Entra was configured later from UI.
if ! grep -Eq '^SIRK_SSO_SHARED_SECRET=.{43,}$' .env; then
  command -v openssl >/dev/null 2>&1 || die "openssl is required to generate SIRK_SSO_SHARED_SECRET"
  sso_secret="$(openssl rand -base64 48 | tr -d '\n')"
  if grep -q '^SIRK_SSO_SHARED_SECRET=' .env; then
    sed -i "s|^SIRK_SSO_SHARED_SECRET=.*$|SIRK_SSO_SHARED_SECRET=${sso_secret}|" .env
  else
    printf '\nSIRK_SSO_SHARED_SECRET=%s\n' "$sso_secret" >> .env
  fi
  chmod 0600 .env
  log "Generated missing SIRK_SSO_SHARED_SECRET"
fi

# Auth Broker is part of the standard SIRK Central deployment. Its Entra
# configuration may live in the persistent data volume instead of .env.
compose=(docker compose --profile auth)

log "Validating configuration"
"${compose[@]}" config >/dev/null

log "Building and applying update"
"${compose[@]}" up -d --build --remove-orphans

"${compose[@]}" ps
log "Update completed; .env backup: ${backup_path}"
