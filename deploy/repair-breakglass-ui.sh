#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

REPO_URL="${CENTRAL_REPO_URL:-https://github.com/Eris92/SIRK-Central.git}"
RAW_ROOT="${RAW_ROOT:-https://raw.githubusercontent.com/Eris92/SIRK-Central}"
INSTALL_ROOT="${INSTALL_ROOT:-/opt/sirk-central}"
SOURCE_DIR="${SOURCE_DIR:-${INSTALL_ROOT}/source}"
COMPOSE_FILE="${COMPOSE_FILE:-${INSTALL_ROOT}/compose.yml}"
CENTRAL_CONTAINER="${CENTRAL_CONTAINER:-sirk-central-test}"
CENTRAL_HOST="${CENTRAL_HOST:-central.sirkportal.com}"
WEBSITE_HOST="${WEBSITE_HOST:-sirkportal.com}"
BUSINESS_HOST="${BUSINESS_HOST:-sir-k.pl}"
AUTH_HOST="${AUTH_HOST:-auth.sirkportal.com}"
ACME_EMAIL="${ACME_EMAIL:-admin@sirkportal.com}"

fail() { echo "ERROR: $*" >&2; exit 1; }
[[ $EUID -eq 0 ]] || fail "Uruchom jako root przez sudo."
for command_name in curl git docker grep stat; do
    command -v "$command_name" >/dev/null 2>&1 || fail "Brak polecenia: $command_name"
done

TARGET_COMMIT="$(git ls-remote "$REPO_URL" refs/heads/main | awk 'NR == 1 {print $1}')"
[[ "$TARGET_COMMIT" =~ ^[0-9a-f]{40}$ ]] || fail "Nie udalo sie ustalic aktualnego commita main."

echo "Naprawa Break Glass UI z commita: $TARGET_COMMIT"
TMP_SCRIPT="$(mktemp /tmp/sirk-central-ui-repair.XXXXXX.sh)"
trap 'rm -f "$TMP_SCRIPT"' EXIT
curl -fsSL "$RAW_ROOT/$TARGET_COMMIT/deploy/upgrade-dotnet10-vps.sh" -o "$TMP_SCRIPT"
chmod 0700 "$TMP_SCRIPT"

env \
    CENTRAL_REF="$TARGET_COMMIT" \
    CENTRAL_HOST="$CENTRAL_HOST" \
    WEBSITE_HOST="$WEBSITE_HOST" \
    BUSINESS_HOST="$BUSINESS_HOST" \
    AUTH_HOST="$AUTH_HOST" \
    ACME_EMAIL="$ACME_EMAIL" \
    bash "$TMP_SCRIPT"

[[ -f "$SOURCE_DIR/public/workspace-bootstrap.js" ]] || fail "Brak workspace-bootstrap.js w source."
grep -q 'sirkCompatibilityFetch' "$SOURCE_DIR/public/workspace-bootstrap.js" || \
    fail "Source nadal zawiera stary workspace-bootstrap.js."

docker exec "$CENTRAL_CONTAINER" sh -c \
    "grep -q 'sirkCompatibilityFetch' /app/public/workspace-bootstrap.js" || \
    fail "Kontener nadal zawiera stary workspace-bootstrap.js."

PUBLIC_ASSET="$(curl -fsS -H 'Cache-Control: no-cache' "https://${CENTRAL_HOST}/workspace-bootstrap.js?repair=${TARGET_COMMIT}")"
grep -q 'sirkCompatibilityFetch' <<<"$PUBLIC_ASSET" || \
    fail "Publiczny HTTPS nadal zwraca stary workspace-bootstrap.js."

INVALID_CODE_STATUS="$(curl -sS -o /tmp/sirk-invalid-access.json -w '%{http_code}' \
    -H 'Authorization: Bearer invalid-access-code' \
    "https://${CENTRAL_HOST}/api/access")"
[[ "$INVALID_CODE_STATUS" == "200" ]] || fail "/api/access dla blednego kodu zwrocil HTTP $INVALID_CODE_STATUS."
grep -q '"localLoginEnabled":false' /tmp/sirk-invalid-access.json || \
    fail "Backend nie odrzuca blednego Access Code."
rm -f /tmp/sirk-invalid-access.json

printf '\nBREAK_GLASS_UI_REPAIR_PASS\nCommit: %s\nAsset bytes: %s\n' \
    "$TARGET_COMMIT" "${#PUBLIC_ASSET}"
