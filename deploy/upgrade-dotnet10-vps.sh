#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

# Non-destructive deployment for SIRK Central .NET 10.
# Normal bootstrap may fetch repositories. Runtime self-update sets
# SIRK_SOURCE_READY=1 and deploys only an already verified Central cache payload.

INSTALL_ROOT="${INSTALL_ROOT:-/opt/sirk-central}"
SOURCE_DIR="${SOURCE_DIR:-${INSTALL_ROOT}/source}"
DATA_DIR="${DATA_DIR:-${INSTALL_ROOT}/data}"
SECRETS_DIR="${SECRETS_DIR:-${INSTALL_ROOT}/secrets}"
UPDATE_CACHE_DIR="${UPDATE_CACHE_DIR:-${INSTALL_ROOT}/updates}"
PUBLIC_CONFIG_DIR="${PUBLIC_CONFIG_DIR:-${INSTALL_ROOT}/public-config}"
COMPOSE_FILE="${COMPOSE_FILE:-${INSTALL_ROOT}/compose.yml}"
CADDY_FILE="${CADDY_FILE:-${INSTALL_ROOT}/Caddyfile}"
CADDY_DATA_DIR="${CADDY_DATA_DIR:-${INSTALL_ROOT}/caddy-data}"
CADDY_CONFIG_DIR="${CADDY_CONFIG_DIR:-${INSTALL_ROOT}/caddy-config}"
BUSINESS_DIR="${BUSINESS_DIR:-/opt/sir-k.pl}"

CENTRAL_REPO_URL="${CENTRAL_REPO_URL:-https://github.com/Eris92/SIRK-Central.git}"
CENTRAL_REF="${CENTRAL_REF:-main}"
BUSINESS_REPO_URL="${BUSINESS_REPO_URL:-https://github.com/Eris92/sir-k.pl.git}"
BUSINESS_REF="${BUSINESS_REF:-main}"
SOURCE_READY="${SIRK_SOURCE_READY:-0}"
UPDATE_BUSINESS="${SIRK_UPDATE_BUSINESS:-1}"
RELEASE_COMMIT="${SIRK_RELEASE_COMMIT:-}"

IMAGE_NAME="${IMAGE_NAME:-sirk-central:dotnet10}"
CENTRAL_CONTAINER="${CENTRAL_CONTAINER:-sirk-central-test}"
CADDY_CONTAINER="${CADDY_CONTAINER:-sirk-central-caddy}"
DEMO_CONTAINER="${DEMO_CONTAINER:-sirk-demo-orchestrator}"

CENTRAL_HOST="${CENTRAL_HOST:-central.sirkportal.com}"
WEBSITE_HOST="${WEBSITE_HOST:-sirkportal.com}"
BUSINESS_HOST="${BUSINESS_HOST:-sir-k.pl}"
AUTH_HOST="${AUTH_HOST:-auth.sirkportal.com}"
DEMO_HOST="${DEMO_HOST:-demo.sirkportal.com}"
PORTAL_DEMO_IMAGE="${PORTAL_DEMO_IMAGE:-ghcr.io/eris92/sirk-portal:0.1.1.7}"
GITHUB_CONTAINER_USER="${GITHUB_CONTAINER_USER:-Eris92}"
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

for command_name in docker curl jq grep awk sed find stat openssl; do
    command -v "$command_name" >/dev/null 2>&1 || fail "Brak polecenia: ${command_name}"
done
if [[ "$SOURCE_READY" != "1" || "$UPDATE_BUSINESS" == "1" ]]; then
    command -v git >/dev/null 2>&1 || fail "Brak polecenia: git"
fi
docker compose version >/dev/null 2>&1 || fail "Brak Docker Compose v2."
systemctl is-active --quiet docker || fail "Docker nie dziala."

for domain in "$CENTRAL_HOST" "$WEBSITE_HOST" "$BUSINESS_HOST" "$AUTH_HOST" "$DEMO_HOST"; do
    [[ "$domain" =~ ^[A-Za-z0-9.-]+$ ]] || fail "Nieprawidlowa domena: ${domain}"
done

[[ -d "$DATA_DIR" ]] || fail "Brak katalogu danych: ${DATA_DIR}. Najpierw wykonaj pelna instalacje."
[[ -d "$SECRETS_DIR" ]] || fail "Brak katalogu sekretow: ${SECRETS_DIR}. Najpierw wykonaj pelna instalacje."
[[ -s "$SECRETS_DIR/sirk-central-dataprotection.pfx" ]] || fail "Brak certyfikatu Data Protection."
[[ -s "$SECRETS_DIR/sirk-central-dataprotection-password" ]] || fail "Brak hasla certyfikatu Data Protection."
[[ -s "$SECRETS_DIR/sirk-release-trusted-keys.json" ]] || fail "Brak publicznego release trust keyring."
[[ -s "$SECRETS_DIR/sirk-updates-github-token" ]] || fail "Brak Central GitHub update token."
[[ -s "$SECRETS_DIR/sirk-update-host-token" ]] || fail "Brak lokalnego host update control token."
if [[ ! -s "$SECRETS_DIR/sirk-demo-control-token" ]]; then
    openssl rand -hex 32 > "$SECRETS_DIR/sirk-demo-control-token"
fi

mkdir -p "$INSTALL_ROOT" "$UPDATE_CACHE_DIR" "$PUBLIC_CONFIG_DIR" "$CADDY_DATA_DIR" "$CADDY_CONFIG_DIR"
chmod 0700 "$INSTALL_ROOT" "$UPDATE_CACHE_DIR" "$CADDY_DATA_DIR" "$CADDY_CONFIG_DIR"
chmod 0755 "$PUBLIC_CONFIG_DIR"

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

if [[ "$SOURCE_READY" == "1" ]]; then
    [[ "$RELEASE_COMMIT" =~ ^[0-9a-f]{40}$ ]] || fail "SIRK_RELEASE_COMMIT jest wymagany dla cache update."
    [[ -s "$SOURCE_DIR/Dockerfile.dotnet10" ]] || fail "Zweryfikowany cache payload nie zawiera Dockerfile.dotnet10."
    [[ -s "$SOURCE_DIR/src/Sirk.Central/Sirk.Central.csproj" ]] || fail "Zweryfikowany cache payload nie zawiera SIRK Central."
    CENTRAL_COMMIT="$RELEASE_COMMIT"
    echo "=== SIRK Central: verified cache source ${CENTRAL_COMMIT} ==="
else
    echo "=== Bootstrap/maintenance source fetch SIRK Central ==="
    update_repository "$SOURCE_DIR" "$CENTRAL_REPO_URL" "$CENTRAL_REF"
    CENTRAL_COMMIT="$(git -C "$SOURCE_DIR" rev-parse HEAD)"
fi
echo "Central commit: ${CENTRAL_COMMIT}"

if [[ "$UPDATE_BUSINESS" == "1" ]]; then
    echo "=== Aktualizacja strony sir-k.pl ==="
    update_repository "$BUSINESS_DIR" "$BUSINESS_REPO_URL" "$BUSINESS_REF"
    BUSINESS_COMMIT="$(git -C "$BUSINESS_DIR" rev-parse HEAD)"
else
    [[ -s "$BUSINESS_DIR/index.html" ]] || fail "Brak zachowanej strony firmowej sir-k.pl/index.html."
    BUSINESS_COMMIT="preserved"
fi
echo "sir-k.pl commit: ${BUSINESS_COMMIT}"

[[ -s "$SOURCE_DIR/website/index.html" ]] || fail "Brak strony produktu website/index.html."
[[ -s "$BUSINESS_DIR/index.html" ]] || fail "Brak strony firmowej sir-k.pl/index.html."
[[ -s "$SOURCE_DIR/deploy/dotnet10/Caddyfile" ]] || fail "Brak wspolnej konfiguracji Caddy."

install -m 0644 "$SOURCE_DIR/deploy/dotnet10/Caddyfile" "$CADDY_FILE"

if [[ -f "$COMPOSE_FILE" ]]; then
    cp -a "$COMPOSE_FILE" "${COMPOSE_FILE}.before-upgrade-$(date +%Y%m%d-%H%M%S)"
fi

echo "=== Budowanie obrazu ${IMAGE_NAME} ==="
BUILD_ARGS=(
    --pull
    --network host
    --file "$SOURCE_DIR/Dockerfile.dotnet10"
    --tag "$IMAGE_NAME"
)
if [[ "${SIRK_DOCKER_NO_CACHE:-0}" == "1" ]]; then
    BUILD_ARGS+=(--no-cache)
fi
docker build "${BUILD_ARGS[@]}" "$SOURCE_DIR"

# Keep the current release online until the replacement image has built.
docker rm -f "$CENTRAL_CONTAINER" "$CADDY_CONTAINER" "$DEMO_CONTAINER" 2>/dev/null || true
cat "$SECRETS_DIR/sirk-updates-github-token" | docker login ghcr.io --username "$GITHUB_CONTAINER_USER" --password-stdin >/dev/null
docker pull "$PORTAL_DEMO_IMAGE"

APP_UID="$(docker run --rm --entrypoint /bin/sh "$IMAGE_NAME" -c 'id -u')"
APP_GID="$(docker run --rm --entrypoint /bin/sh "$IMAGE_NAME" -c 'id -g')"
[[ "$APP_UID" =~ ^[0-9]+$ && "$APP_GID" =~ ^[0-9]+$ ]] || fail "Nieprawidlowy UID/GID obrazu."
chown -R "${APP_UID}:${APP_GID}" "$DATA_DIR" "$UPDATE_CACHE_DIR"
chown -R "${APP_UID}:${APP_GID}" "$PUBLIC_CONFIG_DIR"
chown -R "${APP_UID}:${APP_GID}" "$SECRETS_DIR"
chmod 0700 "$DATA_DIR" "$DATA_DIR/security" "$UPDATE_CACHE_DIR" "$SECRETS_DIR"
if [[ ! -s "$PUBLIC_CONFIG_DIR/sirk-config.json" ]]; then
    jq -n --arg url "https://${DEMO_HOST}/start" \
      '{schemaVersion:1,revision:0,generatedAtUtc:(now|todateiso8601),demo:{enabled:true,available:true,ctaUrl:$url},features:{agent:true,portal:true,central:true,contact:true,registration:false},maintenance:{enabled:false,status:"operational",message:null}}' \
      > "$PUBLIC_CONFIG_DIR/sirk-config.json"
fi
chmod 0644 "$PUBLIC_CONFIG_DIR/sirk-config.json"

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
      Sirk__PublicSite__SnapshotPath: /var/lib/sirk-public/sirk-config.json
      Sirk__PublicSite__PublicDomain: "${WEBSITE_HOST}"
      Sirk__Demo__OrchestratorUrl: http://demo-orchestrator:8090
      Sirk__Demo__ControlTokenFile: /run/secrets/sirk-demo-control-token
      Sirk__Demo__PublicBaseUrl: "https://${DEMO_HOST}"
      Sirk__Security__Enabled: "true"
      Sirk__Security__DataRoot: /var/lib/sirk-central/security
      Sirk__Security__BootstrapSecretFile: /var/lib/sirk-central/security/break-glass-bootstrap.json
      Sirk__Security__DataProtectionCertificatePath: /run/secrets/sirk-central-dataprotection.pfx
      Sirk__Security__DataProtectionCertificatePasswordFile: /run/secrets/sirk-central-dataprotection-password
      Sirk__Security__ReleaseSigningPublicKeyFile: /run/secrets/sirk-release-trusted-keys.json
      Sirk__Security__RequireProtectedDataProtectionKeys: "true"
      Sirk__Security__RequireSignedReleases: "true"
      Sirk__Security__RequireSingleWriterLease: "true"
      Sirk__Security__SessionMinutes: "30"
      Sirk__Security__LoginAttemptsPerFiveMinutes: "5"
      Sirk__Security__PasswordHashIterations: "600000"
      Sirk__Updates__GitHubTokenFile: /run/secrets/sirk-updates-github-token
      Sirk__Updates__HostControlTokenFile: /run/secrets/sirk-update-host-token
      Sirk__Updates__CacheRoot: /var/lib/sirk/updates
      Sirk__WebAuthn__ServerDomain: "${CENTRAL_HOST}"
      Sirk__WebAuthn__ServerName: "SIRK Central"
      Sirk__WebAuthn__Origins__0: "https://${CENTRAL_HOST}"
    volumes:
      - ${DATA_DIR}:/var/lib/sirk-central
      - ${UPDATE_CACHE_DIR}:/var/lib/sirk/updates
      - ${PUBLIC_CONFIG_DIR}:/var/lib/sirk-public
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

  demo-orchestrator:
    image: ${IMAGE_NAME}
    container_name: ${DEMO_CONTAINER}
    command: ["--demo-orchestrator"]
    restart: unless-stopped
    user: "0:0"
    expose:
      - "8090"
    environment:
      ASPNETCORE_ENVIRONMENT: Production
      AllowedHosts: "${DEMO_HOST};localhost;127.0.0.1"
      Sirk__Demo__ControlTokenFile: /run/secrets/sirk-demo-control-token
      Sirk__Demo__PortalImage: "ghcr.io/eris92/sirk-portal"
      Sirk__Demo__Network: sirk-demo
      Sirk__Demo__PublicBaseUrl: "https://${DEMO_HOST}"
      Sirk__Demo__DockerSocket: /var/run/docker.sock
      Sirk__Demo__Enabled: "true"
      Sirk__Demo__Version: "0.1.1.7"
      Sirk__Demo__MaxSessions: "4"
      Sirk__Demo__IdleTtlMinutes: "20"
      Sirk__Demo__AbsoluteTtlMinutes: "60"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - ${SECRETS_DIR}:/run/secrets:ro
    read_only: true
    tmpfs:
      - /tmp:rw,noexec,nosuid,nodev,size=64m
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    pids_limit: 256
    healthcheck:
      test: ["CMD", "dotnet", "Sirk.Central.dll", "--health-check", "http://127.0.0.1:8090/healthz"]
      interval: 20s
      timeout: 7s
      start_period: 10s
      retries: 3
    networks:
      - sirk-edge
      - sirk-demo

  caddy:
    image: caddy:2.10.0-alpine
    container_name: ${CADDY_CONTAINER}
    restart: unless-stopped
    depends_on:
      central:
        condition: service_healthy
      demo-orchestrator:
        condition: service_started
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
      SIRK_DEMO_DOMAIN: "${DEMO_HOST}"
    volumes:
      - ${CADDY_FILE}:/etc/caddy/Caddyfile:ro
      - ${SOURCE_DIR}/website:/srv/website:ro
      - ${PUBLIC_CONFIG_DIR}:/srv/public-config:ro
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
  sirk-demo:
    name: sirk-demo
    driver: bridge
    internal: true
EOF
chmod 0600 "$COMPOSE_FILE"

echo "=== Konfiguracja bezpiecznego web updatera hosta ==="
install -m 0700 "$SOURCE_DIR/deploy/web-update-worker.sh" /usr/local/sbin/sirk-central-web-update
cat >/etc/systemd/system/sirk-central-web-update.service <<EOF
[Unit]
Description=SIRK Central verified web update worker
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
Environment=INSTALL_ROOT=${INSTALL_ROOT}
Environment=DOCKER_CONFIG=/run/sirk-central-web-update/docker
RuntimeDirectory=sirk-central-web-update
RuntimeDirectoryMode=0700
ExecStart=/usr/local/sbin/sirk-central-web-update
PrivateTmp=true
ProtectHome=true
NoNewPrivileges=true
EOF
cat >/etc/systemd/system/sirk-central-web-update.path <<EOF
[Unit]
Description=Watch for authenticated SIRK Central web update requests

[Path]
PathExists=${DATA_DIR}/security/host-update/request.json
Unit=sirk-central-web-update.service

[Install]
WantedBy=multi-user.target
EOF
chmod 0644 /etc/systemd/system/sirk-central-web-update.service /etc/systemd/system/sirk-central-web-update.path
systemctl daemon-reload
systemctl enable --now sirk-central-web-update.path

docker compose -f "$COMPOSE_FILE" config >/dev/null

echo "=== Walidacja Caddy ==="
docker run --rm \
    -e "SIRK_ACME_EMAIL=${ACME_EMAIL}" \
    -e "SIRK_WEBSITE_DOMAIN=${WEBSITE_HOST}" \
    -e "SIRK_BUSINESS_DOMAIN=${BUSINESS_HOST}" \
    -e "SIRK_CENTRAL_DOMAIN=${CENTRAL_HOST}" \
    -e "SIRK_AUTH_DOMAIN=${AUTH_HOST}" \
    -e "SIRK_DEMO_DOMAIN=${DEMO_HOST}" \
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
echo "Update cache:     ${UPDATE_CACHE_DIR}"
echo "Compose:          ${COMPOSE_FILE}"
echo "Log:              ${LOG_FILE}"
echo "============================================================"
