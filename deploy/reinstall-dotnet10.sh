#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

INSTALL_ROOT="${INSTALL_ROOT:-/opt/sirk-central}"
SOURCE_DIR="${SOURCE_DIR:-${INSTALL_ROOT}/source}"
DATA_DIR="${DATA_DIR:-${INSTALL_ROOT}/data}"
SECRETS_DIR="${SECRETS_DIR:-${INSTALL_ROOT}/secrets}"
UPDATE_CACHE_DIR="${UPDATE_CACHE_DIR:-${INSTALL_ROOT}/updates}"
COMPOSE_FILE="${COMPOSE_FILE:-${INSTALL_ROOT}/compose.yml}"

REPO_URL="${REPO_URL:-https://github.com/Eris92/SIRK-Central.git}"
CENTRAL_REF="${CENTRAL_REF:-main}"
APP_COMMIT="${APP_COMMIT:-}"
IMAGE_NAME="${IMAGE_NAME:-sirk-central:dotnet10}"
CENTRAL_CONTAINER="${CENTRAL_CONTAINER:-sirk-central-test}"
CADDY_CONTAINER="${CADDY_CONTAINER:-sirk-central-caddy}"

CENTRAL_HOST="${CENTRAL_HOST:-central.sirkportal.com}"
WEBSITE_HOST="${WEBSITE_HOST:-sirkportal.com}"
BUSINESS_HOST="${BUSINESS_HOST:-sir-k.pl}"
AUTH_HOST="${AUTH_HOST:-auth.sirkportal.com}"
ACME_EMAIL="${ACME_EMAIL:-admin@sirkportal.com}"

# Release signing is intentionally outside the Central host. The installer only
# imports the public trust keyring plus the one GitHub read token owned by Central.
RELEASE_TRUST_SOURCE="${SIRK_RELEASE_TRUSTED_KEYS_FILE:-/root/sirk-release-trusted-keys.json}"
GITHUB_UPDATE_TOKEN_SOURCE="${SIRK_UPDATES_GITHUB_TOKEN_FILE:-/root/sirk-updates-github-token}"

FORCE="${FORCE:-0}"
LOG_FILE="/var/log/sirk-central-reinstall-$(date +%Y%m%d-%H%M%S).log"
exec > >(tee -a "$LOG_FILE") 2>&1

fail() {
    echo "ERROR: $*" >&2
    exit 1
}

on_error() {
    local code=$?
    echo
    echo "Instalacja zakonczona bledem: ${code}"
    echo "Log: ${LOG_FILE}"
    docker logs "$CENTRAL_CONTAINER" --tail 100 2>/dev/null || true
    docker logs "$CADDY_CONTAINER" --tail 100 2>/dev/null || true
    exit "$code"
}
trap on_error ERR

[[ $EUID -eq 0 ]] || fail "Uruchom jako root."
cd /

for command_name in docker git jq openssl curl awk grep find stat; do
    command -v "$command_name" >/dev/null 2>&1 || fail "Brak polecenia: ${command_name}"
done
docker compose version >/dev/null 2>&1 || fail "Brak Docker Compose v2."
systemctl is-active --quiet docker || fail "Docker nie dziala."

for domain in "$CENTRAL_HOST" "$WEBSITE_HOST" "$BUSINESS_HOST" "$AUTH_HOST"; do
    [[ "$domain" =~ ^[A-Za-z0-9.-]+$ ]] || fail "Nieprawidlowa domena: ${domain}"
done

[[ -f "$RELEASE_TRUST_SOURCE" ]] || fail "Brak publicznego release trust keyring: ${RELEASE_TRUST_SOURCE}"
[[ -f "$GITHUB_UPDATE_TOKEN_SOURCE" ]] || fail "Brak pliku Central GitHub update token: ${GITHUB_UPDATE_TOKEN_SOURCE}"
python3 - "$RELEASE_TRUST_SOURCE" <<'PY'
import json,re,sys
with open(sys.argv[1],encoding='utf-8') as f:
    d=json.load(f)
keys=d.get('keys')
if not isinstance(keys,list) or not 1 <= len(keys) <= 32:
    raise SystemExit('Release trust keyring must contain 1-32 keys.')
seen=set()
for key in keys:
    kid=str(key.get('keyId') or '')
    pem=str(key.get('publicKeyPem') or '')
    if not re.fullmatch(r'[A-Za-z0-9._-]{1,80}',kid) or kid in seen:
        raise SystemExit('Release trust keyring contains an invalid/duplicate keyId.')
    if 'BEGIN PUBLIC KEY' not in pem or 'PRIVATE KEY' in pem:
        raise SystemExit('Release trust keyring must contain public keys only.')
    seen.add(kid)
PY
GITHUB_TOKEN_LENGTH="$(tr -d '\r\n' <"$GITHUB_UPDATE_TOKEN_SOURCE" | wc -c)"
[[ "$GITHUB_TOKEN_LENGTH" -ge 20 && "$GITHUB_TOKEN_LENGTH" -le 512 ]] || fail "Central GitHub update token ma nieprawidlowa dlugosc."
[[ -z "$(tr -d '\r\n' <"$GITHUB_UPDATE_TOKEN_SOURCE" | grep -o '[[:space:]]' || true)" ]] || fail "Central GitHub update token zawiera whitespace."

if [[ -z "$APP_COMMIT" ]]; then
    APP_COMMIT="$(
        git ls-remote "$REPO_URL" "refs/heads/${CENTRAL_REF}" |
            awk 'NR == 1 { print $1 }'
    )"
fi
[[ "$APP_COMMIT" =~ ^[0-9a-f]{40}$ ]] || fail "Nieprawidlowy APP_COMMIT."

confirm_reinstall() {
    [[ "$FORCE" == "1" ]] && return
    echo "UWAGA: zostana usuniete dane aplikacji i sekrety z ${INSTALL_ROOT}."
    local confirmation=""
    if [[ -r /dev/tty ]]; then
        read -r -p "Wpisz REINSTALL SIRK CENTRAL: " confirmation </dev/tty
    else
        fail "Brak interaktywnego terminala. Ustaw FORCE=1."
    fi
    [[ "$confirmation" == "REINSTALL SIRK CENTRAL" ]] || fail "Anulowano."
}
confirm_reinstall

echo "=== Zatrzymywanie obecnego runtime ==="
if [[ -f "$COMPOSE_FILE" ]]; then
    docker compose -f "$COMPOSE_FILE" down --remove-orphans || true
fi
docker rm -f "$CENTRAL_CONTAINER" "$CADDY_CONTAINER" \
    sirk-central-failclosed-test sirk-central-second-writer 2>/dev/null || true

# Caddy certificate directories, update cache and independent sir-k.pl are
# intentionally preserved. Central identity/data/source/secrets are rebuilt.
rm -rf --one-file-system "$DATA_DIR" "$SECRETS_DIR" "$SOURCE_DIR"
rm -f "$COMPOSE_FILE" "$INSTALL_ROOT/APP_UID" "$INSTALL_ROOT/APP_GID"
rm -f /root/sirk-central-breakglass-user.txt
rm -f /root/sirk-central-breakglass-access-code.txt
# Delete the historical on-host signing key if an old installation left it.
rm -f /root/sirk-release-signing-private-key.pem

mkdir -p "$INSTALL_ROOT" "$DATA_DIR/security" "$SECRETS_DIR" "$UPDATE_CACHE_DIR"
chmod 0700 "$INSTALL_ROOT" "$DATA_DIR" "$DATA_DIR/security" "$SECRETS_DIR" "$UPDATE_CACHE_DIR"

echo "=== Pobieranie SIRK Central ${APP_COMMIT} (bootstrap only) ==="
git clone "$REPO_URL" "$SOURCE_DIR"
git -C "$SOURCE_DIR" checkout --force --detach "$APP_COMMIT"
git -C "$SOURCE_DIR" clean -ffdqx
[[ "$(git -C "$SOURCE_DIR" rev-parse HEAD)" == "$APP_COMMIT" ]] || fail "Checkout niewlasciwego commita."

echo "=== Import publicznego release trust root i Central GitHub token ==="
install -m 0600 "$RELEASE_TRUST_SOURCE" "$SECRETS_DIR/sirk-release-trusted-keys.json"
install -m 0600 "$GITHUB_UPDATE_TOKEN_SOURCE" "$SECRETS_DIR/sirk-updates-github-token"
# Host-control token authenticates only loopback host->Central update preparation.
openssl rand -base64 48 | tr -d '\r\n' >"$SECRETS_DIR/sirk-update-host-token"
chmod 0600 "$SECRETS_DIR/sirk-update-host-token"

echo "=== Generowanie chronionego Data Protection certificate ==="
PFX_PASSWORD_FILE="$SECRETS_DIR/sirk-central-dataprotection-password"
PFX_FILE="$SECRETS_DIR/sirk-central-dataprotection.pfx"
TMP_KEY="$SECRETS_DIR/.dataprotection.key"
TMP_CERT="$SECRETS_DIR/.dataprotection.crt"
openssl rand -base64 48 | tr -d '\r\n' >"$PFX_PASSWORD_FILE"
PFX_PASSWORD="$(cat "$PFX_PASSWORD_FILE")"
openssl req \
    -x509 \
    -newkey rsa:4096 \
    -sha256 \
    -nodes \
    -days 1825 \
    -subj '/CN=SIRK Central Data Protection/O=SIRK' \
    -keyout "$TMP_KEY" \
    -out "$TMP_CERT"
openssl pkcs12 \
    -export \
    -inkey "$TMP_KEY" \
    -in "$TMP_CERT" \
    -name 'SIRK Central Data Protection' \
    -passout "pass:${PFX_PASSWORD}" \
    -out "$PFX_FILE"
rm -f "$TMP_KEY" "$TMP_CERT"
chmod 0600 "$PFX_PASSWORD_FILE" "$PFX_FILE"
openssl pkcs12 -in "$PFX_FILE" -passin "pass:${PFX_PASSWORD}" -info -noout
unset PFX_PASSWORD

echo "=== Bootstrap Break Glass ==="
BG_USER="${BG_USER:-breakglass}"
BG_PASSWORD="${BG_PASSWORD:-}"
BG_ACCESS_CODE="${BG_ACCESS_CODE:-}"
[[ "$BG_USER" =~ ^[a-z0-9._-]{3,64}$ ]] || fail "Nieprawidlowy BG_USER."

if [[ -z "$BG_PASSWORD" ]]; then
    [[ -r /dev/tty ]] || fail "Brak TTY. Ustaw BG_PASSWORD."
    while true; do
        read -r -s -p "Break Glass password (16-256 znakow): " BG_PASSWORD </dev/tty
        printf '\n' >/dev/tty
        read -r -s -p "Powtorz haslo: " BG_PASSWORD_CONFIRM </dev/tty
        printf '\n' >/dev/tty
        [[ "$BG_PASSWORD" == "$BG_PASSWORD_CONFIRM" ]] || {
            echo "Hasla nie sa identyczne." >/dev/tty
            continue
        }
        ((${#BG_PASSWORD} >= 16 && ${#BG_PASSWORD} <= 256)) || {
            echo "Nieprawidlowa dlugosc hasla." >/dev/tty
            continue
        }
        break
    done
fi
((${#BG_PASSWORD} >= 16 && ${#BG_PASSWORD} <= 256)) || fail "Nieprawidlowa dlugosc BG_PASSWORD."

if [[ -z "$BG_ACCESS_CODE" ]]; then
    BG_ACCESS_CODE="$(
        openssl rand -base64 48 |
            tr '+/' '-_' |
            tr -d '=\r\n'
    )"
fi
[[ "$BG_ACCESS_CODE" =~ ^[A-Za-z0-9_-]{24,128}$ ]] || fail "Nieprawidlowy BG_ACCESS_CODE."

jq -n \
    --arg userName "$BG_USER" \
    --arg password "$BG_PASSWORD" \
    --arg accessCode "$BG_ACCESS_CODE" \
    '{userName:$userName,password:$password,accessCode:$accessCode}' \
    >"$DATA_DIR/security/break-glass-bootstrap.json"
chmod 0600 "$DATA_DIR/security/break-glass-bootstrap.json"
printf '%s\n' "$BG_USER" >/root/sirk-central-breakglass-user.txt
printf '%s\n' "$BG_ACCESS_CODE" >/root/sirk-central-breakglass-access-code.txt
chmod 0600 \
    /root/sirk-central-breakglass-user.txt \
    /root/sirk-central-breakglass-access-code.txt
unset BG_PASSWORD BG_PASSWORD_CONFIRM BG_ACCESS_CODE

# The shared non-destructive deploy is the single source of truth for runtime.
echo "=== Uruchamianie finalnego deploymentu ==="
env \
    INSTALL_ROOT="$INSTALL_ROOT" \
    SOURCE_DIR="$SOURCE_DIR" \
    DATA_DIR="$DATA_DIR" \
    SECRETS_DIR="$SECRETS_DIR" \
    UPDATE_CACHE_DIR="$UPDATE_CACHE_DIR" \
    CENTRAL_REF="$APP_COMMIT" \
    IMAGE_NAME="$IMAGE_NAME" \
    CENTRAL_HOST="$CENTRAL_HOST" \
    WEBSITE_HOST="$WEBSITE_HOST" \
    BUSINESS_HOST="$BUSINESS_HOST" \
    AUTH_HOST="$AUTH_HOST" \
    ACME_EMAIL="$ACME_EMAIL" \
    bash "$SOURCE_DIR/deploy/upgrade-dotnet10-vps.sh"

[[ ! -e "$DATA_DIR/security/break-glass-bootstrap.json" ]] ||
    fail "Jednorazowy bootstrap Break Glass nie zostal usuniety."
[[ ! -e /root/sirk-release-signing-private-key.pem ]] ||
    fail "Prywatny release signing key nie moze znajdowac sie na Central runtime host."

echo
echo "============================================================"
echo "SIRK Central clean reinstall: PASS"
echo "Commit:            ${APP_COMMIT}"
echo "Central:           https://${CENTRAL_HOST}"
echo "Product website:   https://${WEBSITE_HOST}"
echo "Business website:  https://${BUSINESS_HOST}"
echo "Break Glass user:  /root/sirk-central-breakglass-user.txt"
echo "Access code:       /root/sirk-central-breakglass-access-code.txt"
echo "Release trust:     ${SECRETS_DIR}/sirk-release-trusted-keys.json (public only)"
echo "Update cache:      ${UPDATE_CACHE_DIR}"
echo "Log:               ${LOG_FILE}"
echo "============================================================"
