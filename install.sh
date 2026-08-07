#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

RAW_BASE="${RAW_BASE:-https://raw.githubusercontent.com/Eris92/SIRK-Central/main}"
BOOTSTRAP_URL="${BOOTSTRAP_URL:-${RAW_BASE}/deploy/bootstrap-ubuntu.sh}"
INSTALLER_URL="${INSTALLER_URL:-${RAW_BASE}/deploy/install-dotnet10.sh}"
CENTRAL_HOST="${CENTRAL_HOST:-central.sirkportal.com}"

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
    CENTRAL_HOST="$CENTRAL_HOST" \
    WEBSITE_HOST="${WEBSITE_HOST:-sirkportal.com}" \
    BUSINESS_HOST="${BUSINESS_HOST:-sir-k.pl}" \
    AUTH_HOST="${AUTH_HOST:-auth.sirkportal.com}" \
    ACME_EMAIL="${ACME_EMAIL:-admin@sirkportal.com}" \
    BG_USER="${BG_USER:-breakglass}" \
    BG_PASSWORD="${BG_PASSWORD:-}" \
    BG_ACCESS_CODE="${BG_ACCESS_CODE:-}" \
    SIRK_RELEASE_TRUSTED_KEYS_FILE="${SIRK_RELEASE_TRUSTED_KEYS_FILE:-/root/sirk-release-trusted-keys.json}" \
    SIRK_UPDATES_GITHUB_TOKEN_FILE="${SIRK_UPDATES_GITHUB_TOKEN_FILE:-/root/sirk-updates-github-token}" \
    bash "$TMP_DIR/install-dotnet10.sh"

ACCESS_CODE_FILE="/root/sirk-central-breakglass-access-code.txt"
ACCESS_URL_FILE="/root/sirk-central-breakglass-access-url.txt"
[[ -s "$ACCESS_CODE_FILE" ]] || fail "Brak wygenerowanego Access Code: $ACCESS_CODE_FILE"
ACCESS_CODE="$(tr -d '\r\n' < "$ACCESS_CODE_FILE")"
[[ "$ACCESS_CODE" =~ ^[A-Za-z0-9_-]{24,128}$ ]] || fail "Nieprawidlowy wygenerowany Access Code."
printf 'https://%s/#access=%s\n' "$CENTRAL_HOST" "$ACCESS_CODE" > "$ACCESS_URL_FILE"
chmod 0600 "$ACCESS_URL_FILE"

echo
echo "============================================================"
echo "BREAK GLASS ACCESS URL:"
cat "$ACCESS_URL_FILE"
echo "Zapisano rowniez w: $ACCESS_URL_FILE"
echo "============================================================"
unset ACCESS_CODE
