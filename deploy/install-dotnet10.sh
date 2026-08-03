#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

CENTRAL_REPO_URL="${CENTRAL_REPO_URL:-https://github.com/Eris92/SIRK-Central.git}"
CENTRAL_REF="${CENTRAL_REF:-rewrite/dotnet10}"
RAW_BASE="${RAW_BASE:-https://raw.githubusercontent.com/Eris92/SIRK-Central/${CENTRAL_REF}}"
INSTALLER_URL="${INSTALLER_URL:-${RAW_BASE}/deploy/reinstall-dotnet10.sh}"
IMAGE_NAME="${IMAGE_NAME:-sirk-central:2.0.0-test.4}"

TMP_INSTALLER="$(mktemp /tmp/sirk-central-install.XXXXXX.sh)"
cleanup() {
    rm -f "$TMP_INSTALLER"
}
trap cleanup EXIT

cd /
command -v curl >/dev/null 2>&1 || {
    echo "ERROR: Brak curl." >&2
    exit 1
}
command -v git >/dev/null 2>&1 || {
    echo "ERROR: Brak git." >&2
    exit 1
}

APP_COMMIT="${APP_COMMIT:-$(
    git ls-remote "$CENTRAL_REPO_URL" "refs/heads/${CENTRAL_REF}" |
        awk 'NR == 1 { print $1 }'
)}"
[[ "$APP_COMMIT" =~ ^[0-9a-f]{40}$ ]] || {
    echo "ERROR: Nie udalo sie ustalic commita ${CENTRAL_REF}." >&2
    exit 1
}

curl -fsSL "$INSTALLER_URL" -o "$TMP_INSTALLER"
chmod 0700 "$TMP_INSTALLER"

run_installer() {
    env \
        APP_COMMIT="$APP_COMMIT" \
        CENTRAL_REF="$CENTRAL_REF" \
        IMAGE_NAME="$IMAGE_NAME" \
        FORCE="${FORCE:-0}" \
        CENTRAL_HOST="${CENTRAL_HOST:-central.sirkportal.com}" \
        WEBSITE_HOST="${WEBSITE_HOST:-sirkportal.com}" \
        BUSINESS_HOST="${BUSINESS_HOST:-sir-k.pl}" \
        AUTH_HOST="${AUTH_HOST:-auth.sirkportal.com}" \
        ACME_EMAIL="${ACME_EMAIL:-admin@sirkportal.com}" \
        BG_USER="${BG_USER:-breakglass}" \
        BG_PASSWORD="${BG_PASSWORD:-}" \
        BG_ACCESS_CODE="${BG_ACCESS_CODE:-}" \
        KEEP_RELEASE_PRIVATE_KEY="${KEEP_RELEASE_PRIVATE_KEY:-0}" \
        bash "$TMP_INSTALLER"
}

if [[ -r /dev/tty && -w /dev/tty ]]; then
    run_installer </dev/tty
elif [[ -n "${BG_PASSWORD:-}" ]]; then
    run_installer
else
    echo "ERROR: Brak interaktywnego terminala. Ustaw BG_PASSWORD albo uruchom z TTY." >&2
    exit 1
fi
