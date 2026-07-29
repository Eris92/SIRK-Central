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

# Deployment hosts must run exactly the selected remote revision. Previous
# versions used git pull only, which could leave edited or stale frontend files
# in place and made Caddy continue serving an old configuration.
git checkout -B "$REPO_REF" "origin/$REPO_REF"
git reset --hard "origin/$REPO_REF"
log "Checked out $(git rev-parse --short HEAD) from origin/${REPO_REF}"

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

compose=(docker compose --profile auth)

log "Validating configuration"
"${compose[@]}" config >/dev/null

log "Building Central and Auth without cache"
"${compose[@]}" build --pull --no-cache central auth

# Force-recreate is required for Caddy as well. Its Caddyfile and public website
# are bind-mounted, but Caddy does not reload a changed configuration merely
# because the file on disk changed.
log "Recreating Central, Auth and Caddy"
"${compose[@]}" up -d --force-recreate --remove-orphans central auth caddy

log "Verifying deployed frontend"
"${compose[@]}" exec -T central sh -ec '
  test -f /app/public/permissions-layout.js
  test -f /app/public/login-current-tab.js
  grep -q "permissions-layout.js" /app/public/index.html
  grep -q "login-current-tab.js" /app/public/index.html
'

log "Verifying Caddy configuration"
"${compose[@]}" exec -T caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
"${compose[@]}" exec -T caddy sh -ec 'grep -q "script-src.*self" /etc/caddy/Caddyfile'

"${compose[@]}" ps
log "Update completed at commit $(git rev-parse --short HEAD); .env backup: ${backup_path}"
