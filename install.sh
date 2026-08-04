#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

RAW_BASE="${RAW_BASE:-https://raw.githubusercontent.com/Eris92/SIRK-Central/main}"
BOOTSTRAP_URL="${BOOTSTRAP_URL:-${RAW_BASE}/deploy/bootstrap-ubuntu.sh}"
INSTALLER_URL="${INSTALLER_URL:-${RAW_BASE}/deploy/install-dotnet10.sh}"

fail() {
    echo "ERROR: $*" >&2
    exit 1
}

[[ $EUID -eq 0 ]] || fail "Uruchom przez sudo."
command -v curl >/dev/null 2>&1 || fail "Brak curl."

TMP_DIR="$(mktemp -d /tmp/sirk-central-one-line.XXXXXX)"
cleanup() {
    rm -rf "$TMP_DIR"
}
trap cleanup EXIT

curl -fsSL "$BOOTSTRAP_URL" -o "$TMP_DIR/bootstrap.sh"
curl -fsSL "$INSTALLER_URL" -o "$TMP_DIR/install-dotnet10.sh"
chmod 0700 "$TMP_DIR/bootstrap.sh" "$TMP_DIR/install-dotnet10.sh"

# Bootstrap can be made less invasive explicitly, but secure defaults remain on.
env \
    SIRK_SSH_PORT="${SIRK_SSH_PORT:-22}" \
    SIRK_CONFIGURE_UFW="${SIRK_CONFIGURE_UFW:-1}" \
    SIRK_HARDEN_SSH="${SIRK_HARDEN_SSH:-1}" \
    SIRK_ALLOW_SSH_LOCKOUT_RISK="${SIRK_ALLOW_SSH_LOCKOUT_RISK:-false}" \
    bash "$TMP_DIR/bootstrap.sh"

env \
    CENTRAL_REF="${CENTRAL_REF:-main}" \
    FORCE="${FORCE:-1}" \
    CENTRAL_HOST="${CENTRAL_HOST:-central.sirkportal.com}" \
    WEBSITE_HOST="${WEBSITE_HOST:-sirkportal.com}" \
    BUSINESS_HOST="${BUSINESS_HOST:-sir-k.pl}" \
    AUTH_HOST="${AUTH_HOST:-auth.sirkportal.com}" \
    ACME_EMAIL="${ACME_EMAIL:-admin@sirkportal.com}" \
    BG_USER="${BG_USER:-breakglass}" \
    BG_PASSWORD="${BG_PASSWORD:-}" \
    BG_ACCESS_CODE="${BG_ACCESS_CODE:-}" \
    KEEP_RELEASE_PRIVATE_KEY="${KEEP_RELEASE_PRIVATE_KEY:-0}" \
    bash "$TMP_DIR/install-dotnet10.sh"
