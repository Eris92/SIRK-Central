#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

# Non-destructive upgrade for an existing SIRK Central .NET 10 installation.
# Preserves /opt/sirk-central/data and /opt/sirk-central/secrets.

INSTALL_ROOT="${INSTALL_ROOT:-/opt/sirk-central}"
SOURCE_DIR="${SOURCE_DIR:-${INSTALL_ROOT}/source}"
DATA_DIR="${DATA_DIR:-${INSTALL_ROOT}/data}"
SECRETS_DIR="${SECRETS_DIR:-${INSTALL_ROOT}/secrets}"
COMPOSE_FILE="${COMPOSE_FILE:-${INSTALL_ROOT}/compose.yml}"
CADDY_FILE="${CADDY_FILE:-${INSTALL_ROOT}/Caddyfile}"
CADDY_DATA_DIR="${CADDY_DATA_DIR:-${INSTALL_ROOT}/caddy-data}"
CADDY_CONFIG_DIR="${CADDY_CONFIG_DIR:-${INSTALL_ROOT}/caddy-config}"
BUSINESS_DIR="${BUSINESS_DIR:-/opt/sir-k.pl}"

CENTRAL_REPO_URL="${CENTRAL_REPO_URL:-https://github.com/Eris92/SIRK-Central.git}"
CENTRAL_REF="${CENTRAL_REF:-main}"
BUSINESS_REPO_URL="${BUSINESS_REPO_URL:-https://github.com/Eris92/sir-k.pl.git}"
BUSINESS_REF="${BUSINESS_REF:-main}"

IMAGE_NAME="${IMAGE_NAME:-sirk-central:dotnet10}"
CENTRAL_CONTAINER="${CENTRAL_CONTAINER:-sirk-central-test}"
CADDY_CONTAINER="${CADDY_CONTAINER:-sirk-central-caddy}"

CENTRAL_HOST="${CENTRAL_HOST:-central.sirkportal.com}"
WEBSITE_HOST="${WEBSITE_HOST:-sirkportal.com}"
BUSINESS_HOST="${BUSINESS_HOST:-sir-k.pl}"
AUTH_HOST="${AUTH_HOST:-auth.sirkportal.com}"
ACME_EMAIL="${ACME_EMAIL:-admin@sirkportal.com}"

LOG_FILE="/var/log/sirk-central-upgrade-$(date +%Y%m%d-%H%M%S).log"
exec > >(tee -a "$LOG_FILE") 2>&1

fail() {
    echo "ERROR: $*" >&2
    exit 1
}

on_error() {
    local code=$?
    echo
    echo "Upgrade zakonczony bledem: ${code}"
    echo "Log: ${LOG_FILE}"
    docker logs "$CENTRAL_CONTAINER" --tail 100 2>/dev/null || true
    docker logs "$CADDY_CONTAINER" --tail 100 2>/dev/null || true
    exit "$code"
}
trap on_error ERR

[[ $EUID -eq 0 ]] || fail "Uruchom jako root."
cd /

for command_name in docker git curl jq grep awk sed find stat openssl; do
    command -v "$command_name" >/dev/null 2>&1 || fail "Brak polecenia: ${command_name}"
done
docker compose version >/dev/null 2>&1 || fail "Brak Docker Compose v2."
systemctl is-active --quiet docker || fail "Docker nie dziala."

for domain in "$CENTRAL_HOST" "$WEBSITE_HOST" "$BUSINESS_HOST" "$AUTH_HOST"; do
    [[ "$domain" =~ ^[A-Za-z0-9.-]+$ ]] || fail "Nieprawidlowa domena: ${domain}"
done

[[ -d "$DATA_DIR" ]] || fail "Brak katalogu danych: ${DATA_DIR}. Najpierw wykonaj pelna instalacje."
[[ -d "$SECRETS_DIR" ]] || fail "Brak katalogu sekretow: ${SECRETS_DIR}. Najpierw wykonaj pelna instalacje."
[[ -s "$SECRETS_DIR/sirk-central-dataprotection.pfx" ]] || fail "Brak certyfikatu Data Protection."
[[ -s "$SECRETS_DIR/sirk-central-dataprotection-password" ]] || fail "Brak hasla certyfikatu Data Protection."
[[ -s "$SECRETS_DIR/sirk-release-signing-public-key" ]] || fail "Brak klucza publicznego podpisu release."

mkdir -p "$INSTALL_ROOT" "$CADDY_DATA_DIR" "$CADDY_CONFIG_DIR"
chmod 0700 "$INSTALL_ROOT" "$CADDY_DATA_DIR" "$CADDY_CONFIG_DIR"

update_repository() {
    local directory="$1"
    local repository="$2"
    local ref="$3"

    if [[ -d "$directory/.git" ]]; then
        git -C "$directory" remote set-url origin "$repository"
        git -C "$directory" fetch --prune origin
    else
        rm -rf --one-file-system "$directory"
        git clone "$repository" "$directory"
        git -C "$directory" fetch --prune origin
    fi

    if git -C "$directory" show-ref --verify --quiet "refs/remotes/origin/${ref}"; then
        git -C "$directory" checkout --force --detach "origin/${ref}"
    else
        git -C "$directory" checkout --force --detach "$ref"
    fi
    git -C "$directory" clean -ffdqx
}

echo "=== Aktualizacja SIRK Central ==="
update_repository "$SOURCE_DIR" "$CENTRAL_REPO_URL" "$CENTRAL_REF"
CENTRAL_COMMIT="$(git -C "$SOURCE_DIR" rev-parse HEAD)"
echo "Central commit: ${CENTRAL_COMMIT}"

echo "=== Aktualizacja strony sir-k.pl ==="
update_repository "$BUSINESS_DIR" "$BUSINESS_REPO_URL" "$BUSINESS_REF"
BUSINESS_COMMIT="$(git -C "$BUSINESS_DIR" rev-parse HEAD)"
echo "sir-k.pl commit: ${BUSINESS_COMMIT}"

[[ -s "$SOURCE_DIR/website/index.html" ]] || fail "Brak strony produktu website/index.html."
[[ -s "$BUSINESS_DIR/index.html" ]] || fail "Brak strony firmowej sir-k.pl/index.html."
[[ -s "$SOURCE_DIR/deploy/dotnet10/Caddyfile" ]] || fail "Brak wspolnej konfiguracji Caddy."

install -m 0644 "$SOURCE_DIR/deploy/dotnet10/Caddyfile" "$CADDY_FILE"

if [[ -f "$COMPOSE_FILE" ]]; then
    cp -a "$COMPOSE_FILE" "${COMPOSE_FILE}.before-upgrade-$(date +%Y%m%d-%H%M%S)"
fi

# Stop only the application containers. Persistent data and certificate directories remain untouched.
docker rm -f "$CENTRAL_CONTAINER" "$CADDY_CONTAINER" 2>/dev/null || true

echo "=== Budowanie obrazu ${IMAGE_NAME} ==="
docker build \
    --pull \
    --no-cache \
    --file "$SOURCE_DIR/Dockerfile.dotnet10" \
    --tag "$IMAGE_NAME" \
    "$SOURCE_DIR"

APP_UID="$(docker run --rm --entrypoint /bin/sh "$IMAGE_NAME" -c 'id -u')"
APP_GID="$(docker run --rm --entrypoint /bin/sh "$IMAGE_NAME" -c 'id -g')"
[[ "$APP_UID" =~ ^[0-9]+$ && "$APP_GID" =~ ^[0-9]+$ ]] || fail "Nieprawidlowy UID/GID obrazu."
chown -R "${APP_UID}:${APP_GID}" "$DATA_DIR" "$SECRETS_DIR"
chmod 0700 "$DATA_DIR" "$DATA_DIR/security" "$SECRETS_DIR"

cat >"$COMPOSE_FILE" <<EOF
services:
  central:
    image: ${IMAGE_NAME}
    container_name: ${CENTRAL_CONTAINER}
    restart: unless-stopped
    ports:
      - "127.0.0.1:8080:8080"
    expose:
      - "8080"
    environment:
      ASPNETCORE_ENVIRONMENT: Production
      ASPNETCORE_URLS: http://+:8080
      AllowedHosts: "${CENTRAL_HOST};localhost;127.0.0.1"
      Sirk__ReverseProxy__TrustAll: "true"
      Sirk__PortalProtocol__DataRoot: /var/lib/sirk-central
      Sirk__Security__Enabled: "true"
      Sirk__Security__DataRoot: /var/lib/sirk-central/security
      Sirk__Security__BootstrapSecretFile: /var/lib/sirk-central/security/break-glass-bootstrap.json
      Sirk__Security__DataProtectionCertificatePath: /run/secrets/sirk-central-dataprotection.pfx
      Sirk__Security__DataProtectionCertificatePasswordFile: /run/secrets/sirk-central-dataprotection-password
      Sirk__Security__ReleaseSigningPublicKeyFile: /run/secrets/sirk-release-signing-public-key
      Sirk__Security__RequireProtectedDataProtectionKeys: "true"
      Sirk__Security__RequireSignedReleases: "true"
      Sirk__Security__RequireSingleWriterLease: "true"
      Sirk__Security__SessionMinutes: "30"
      Sirk__Security__LoginAttemptsPerFiveMinutes: "5"
      Sirk__Security__PasswordHashIterations: "600000"
      Sirk__WebAuthn__ServerDomain: "${CENTRAL_HOST}"
      Sirk__WebAuthn__ServerName: "SIRK Central"
      Sirk__WebAuthn__Origins__0: "https://${CENTRAL_HOST}"
    volumes:
      - ${DATA_DIR}:/var/lib/sirk-central
      - ${SECRETS_DIR}:/run/secrets:ro
    read_only: true
    tmpfs:
      - /tmp:rw,noexec,nosuid,nodev,size=256m
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    pids_limit: 256
    mem_limit: 2g
    cpus: 2.0
    stop_grace_period: 30s
    networks:
      - sirk-edge

  caddy:
    image: caddy:2.10.0-alpine
    container_name: ${CADDY_CONTAINER}
    restart: unless-stopped
    depends_on:
      central:
        condition: service_healthy
    ports:
      - "80:80"
      - "443:443"
      - "443:443/udp"
    environment:
      SIRK_ACME_EMAIL: "${ACME_EMAIL}"
      SIRK_WEBSITE_DOMAIN: "${WEBSITE_HOST}"
      SIRK_BUSINESS_DOMAIN: "${BUSINESS_HOST}"
      SIRK_CENTRAL_DOMAIN: "${CENTRAL_HOST}"
      SIRK_AUTH_DOMAIN: "${AUTH_HOST}"
    volumes:
      - ${CADDY_FILE}:/etc/caddy/Caddyfile:ro
      - ${SOURCE_DIR}/website:/srv/website:ro
      - ${BUSINESS_DIR}:/srv/sir-k:ro
      - ${CADDY_DATA_DIR}:/data
      - ${CADDY_CONFIG_DIR}:/config
    read_only: true
    tmpfs:
      - /tmp:rw,noexec,nosuid,nodev,size=64m
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    cap_add:
      - NET_BIND_SERVICE
    networks:
      - sirk-edge

networks:
  sirk-edge:
    driver: bridge
EOF
chmod 0600 "$COMPOSE_FILE"

docker compose -f "$COMPOSE_FILE" config >/dev/null

echo "=== Walidacja Caddy ==="
docker run --rm \
    -e "SIRK_ACME_EMAIL=${ACME_EMAIL}" \
    -e "SIRK_WEBSITE_DOMAIN=${WEBSITE_HOST}" \
    -e "SIRK_BUSINESS_DOMAIN=${BUSINESS_HOST}" \
    -e "SIRK_CENTRAL_DOMAIN=${CENTRAL_HOST}" \
    -e "SIRK_AUTH_DOMAIN=${AUTH_HOST}" \
    -v "$CADDY_FILE:/etc/caddy/Caddyfile:ro" \
    caddy:2.10.0-alpine \
    caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile

echo "=== Uruchamianie wspolnego runtime ==="
docker compose -f "$COMPOSE_FILE" up -d --force-recreate --remove-orphans

for _ in $(seq 1 90); do
    status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}no-health{{end}}' "$CENTRAL_CONTAINER" 2>/dev/null || true)"
    [[ "$status" == "healthy" ]] && break
    [[ "$status" == "unhealthy" ]] && fail "SIRK Central ma status unhealthy."
    sleep 2
done
[[ "$(docker inspect --format '{{.State.Health.Status}}' "$CENTRAL_CONTAINER")" == "healthy" ]] || fail "Timeout health SIRK Central."

for _ in $(seq 1 60); do
    [[ "$(docker inspect --format '{{.State.Running}}' "$CADDY_CONTAINER" 2>/dev/null || true)" == "true" ]] && break
    sleep 1
done
[[ "$(docker inspect --format '{{.State.Running}}' "$CADDY_CONTAINER")" == "true" ]] || fail "Caddy nie dziala."

curl -fsS -H "Host: ${CENTRAL_HOST}" http://127.0.0.1:8080/healthz | jq .

ACCESS_CODE_FILE="/root/sirk-central-breakglass-access-code.txt"
if [[ -s "$ACCESS_CODE_FILE" ]]; then
    ACCESS_CODE="$(cat "$ACCESS_CODE_FILE")"
    access_status="$(curl -sS -o /tmp/sirk-access-check.json -w '%{http_code}' \
        -H "Host: ${CENTRAL_HOST}" \
        -H "Authorization: Bearer ${ACCESS_CODE}" \
        http://127.0.0.1:8080/api/access)"
    [[ "$access_status" == "200" ]] || {
        cat /tmp/sirk-access-check.json >&2 || true
        fail "Endpoint /api/access zwrocil HTTP ${access_status}."
    }
    rm -f /tmp/sirk-access-check.json
    unset ACCESS_CODE
fi

# TLS may need a few seconds after Caddy restart.
for _ in $(seq 1 30); do
    if curl -fsS --max-time 10 "https://${CENTRAL_HOST}/healthz" >/dev/null &&
       curl -fsS --max-time 10 "https://${WEBSITE_HOST}/" | grep -q 'SIRK' &&
       curl -fsS --max-time 10 "https://${BUSINESS_HOST}/" | grep -q 'Sir-K'; then
        EDGE_READY=1
        break
    fi
    sleep 2
done
[[ "${EDGE_READY:-0}" == "1" ]] || fail "Nie udalo sie potwierdzic wszystkich domen przez HTTPS. Sprawdz DNS i log Caddy."

echo
echo "============================================================"
echo "SIRK VPS upgrade: PASS"
echo "Central commit:   ${CENTRAL_COMMIT}"
echo "sir-k.pl commit:  ${BUSINESS_COMMIT}"
echo "Central:          https://${CENTRAL_HOST}"
echo "Product website:  https://${WEBSITE_HOST}"
echo "Business website: https://${BUSINESS_HOST}"
echo "Auth alias:       https://${AUTH_HOST}"
echo "Compose:          ${COMPOSE_FILE}"
echo "Log:              ${LOG_FILE}"
echo "============================================================"
