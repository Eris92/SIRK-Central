#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

CENTRAL_HOST="${CENTRAL_HOST:-central.sirkportal.com}"
INSTALL_ROOT="${INSTALL_ROOT:-/opt/sirk-central}"
SOURCE_DIR="${INSTALL_ROOT}/source"
DATA_DIR="${INSTALL_ROOT}/data"
SECRETS_DIR="${INSTALL_ROOT}/secrets"
COMPOSE_FILE="${INSTALL_ROOT}/compose.yml"
IMAGE_NAME="${IMAGE_NAME:-sirk-central:2.0.0-test.3}"
CONTAINER_NAME="${CONTAINER_NAME:-sirk-central-test}"
REPO_URL="${REPO_URL:-https://github.com/Eris92/SIRK-Central.git}"
APP_COMMIT="${APP_COMMIT:-54cf7432092f630595fe1db0909354e64cbc247c}"
FORCE="${FORCE:-0}"
LOG_FILE="/var/log/sirk-central-reinstall-$(date +%Y%m%d-%H%M%S).log"

exec > >(tee -a "$LOG_FILE") 2>&1

fail() { echo "ERROR: $*" >&2; exit 1; }
cleanup_error() {
  code=$?
  echo "Instalacja zakonczona bledem: $code"
  docker logs "$CONTAINER_NAME" 2>/dev/null || true
  echo "Log: $LOG_FILE"
  exit "$code"
}
trap cleanup_error ERR

[[ $EUID -eq 0 ]] || fail "Uruchom jako root."
[[ "$CENTRAL_HOST" =~ ^[A-Za-z0-9.-]+$ ]] || fail "Nieprawidlowy CENTRAL_HOST."

missing=()
for cmd in docker git jq openssl curl awk grep find stat; do
  command -v "$cmd" >/dev/null 2>&1 || missing+=("$cmd")
done
docker compose version >/dev/null 2>&1 || missing+=("docker compose")
((${#missing[@]} == 0)) || fail "Brak zaleznosci: ${missing[*]}"
systemctl is-active --quiet docker || fail "Docker nie dziala."

if [[ "$FORCE" != "1" ]]; then
  echo "UWAGA: usunie dane i sekrety z ${INSTALL_ROOT}."
  read -r -p "Wpisz REINSTALL SIRK CENTRAL: " confirmation
  [[ "$confirmation" == "REINSTALL SIRK CENTRAL" ]] || fail "Anulowano."
fi

if [[ -f "$COMPOSE_FILE" ]]; then
  docker compose -f "$COMPOSE_FILE" down --remove-orphans --volumes || true
fi
docker rm -f "$CONTAINER_NAME" sirk-central-failclosed-test sirk-central-second-writer 2>/dev/null || true
mapfile -t old_images < <(docker images --format '{{.Repository}}:{{.Tag}}' | awk '/^sirk-central:/ {print}')
((${#old_images[@]} == 0)) || docker image rm -f "${old_images[@]}" || true

rm -rf --one-file-system "$DATA_DIR" "$SECRETS_DIR" "$SOURCE_DIR"
rm -f "$COMPOSE_FILE" "$INSTALL_ROOT/APP_UID" "$INSTALL_ROOT/APP_GID"
rm -f /root/sirk-central-breakglass-user.txt /root/sirk-central-breakglass-access-code.txt
rm -f /root/sirk-release-signing-private-key.pem

mkdir -p "$INSTALL_ROOT"
chmod 0700 "$INSTALL_ROOT"
git clone "$REPO_URL" "$SOURCE_DIR"
git -C "$SOURCE_DIR" checkout --force --detach "$APP_COMMIT"
git -C "$SOURCE_DIR" clean -ffdqx
[[ "$(git -C "$SOURCE_DIR" rev-parse HEAD)" == "$APP_COMMIT" ]] || fail "Nieprawidlowy commit."

docker build --pull --no-cache -f "$SOURCE_DIR/Dockerfile.dotnet10" -t "$IMAGE_NAME" "$SOURCE_DIR"
APP_UID="$(docker run --rm --entrypoint /bin/sh "$IMAGE_NAME" -c 'id -u')"
APP_GID="$(docker run --rm --entrypoint /bin/sh "$IMAGE_NAME" -c 'id -g')"
[[ "$APP_UID" =~ ^[0-9]+$ && "$APP_GID" =~ ^[0-9]+$ ]] || fail "Nieprawidlowy UID/GID obrazu."
printf '%s\n' "$APP_UID" >"$INSTALL_ROOT/APP_UID"
printf '%s\n' "$APP_GID" >"$INSTALL_ROOT/APP_GID"
chmod 0600 "$INSTALL_ROOT/APP_UID" "$INSTALL_ROOT/APP_GID"

mkdir -p "$DATA_DIR/security" "$SECRETS_DIR"
chown -R "$APP_UID:$APP_GID" "$DATA_DIR" "$SECRETS_DIR"
chmod 0700 "$DATA_DIR" "$DATA_DIR/security" "$SECRETS_DIR"

PFX_PASSWORD_FILE="$SECRETS_DIR/sirk-central-dataprotection-password"
PFX_FILE="$SECRETS_DIR/sirk-central-dataprotection.pfx"
TMP_KEY="$SECRETS_DIR/.dataprotection.key"
TMP_CRT="$SECRETS_DIR/.dataprotection.crt"
openssl rand -base64 48 | tr -d '\r\n' >"$PFX_PASSWORD_FILE"
PFX_PASSWORD="$(cat "$PFX_PASSWORD_FILE")"
openssl req -x509 -newkey rsa:4096 -sha256 -nodes -days 1825 \
  -subj '/CN=SIRK Central Data Protection/O=SIRK' \
  -keyout "$TMP_KEY" -out "$TMP_CRT"
openssl pkcs12 -export -inkey "$TMP_KEY" -in "$TMP_CRT" \
  -name 'SIRK Central Data Protection' -passout "pass:$PFX_PASSWORD" -out "$PFX_FILE"
rm -f "$TMP_KEY" "$TMP_CRT"
chown "$APP_UID:$APP_GID" "$PFX_PASSWORD_FILE" "$PFX_FILE"
chmod 0600 "$PFX_PASSWORD_FILE" "$PFX_FILE"
unset PFX_PASSWORD

RELEASE_PRIVATE_KEY=/root/sirk-release-signing-private-key.pem
RELEASE_PUBLIC_KEY="$SECRETS_DIR/sirk-release-signing-public-key"
openssl ecparam -name prime256v1 -genkey -noout -out "$RELEASE_PRIVATE_KEY"
openssl pkey -in "$RELEASE_PRIVATE_KEY" -pubout -outform DER | base64 -w0 >"$RELEASE_PUBLIC_KEY"
printf '\n' >>"$RELEASE_PUBLIC_KEY"
chmod 0600 "$RELEASE_PRIVATE_KEY" "$RELEASE_PUBLIC_KEY"
chown "$APP_UID:$APP_GID" "$RELEASE_PUBLIC_KEY"
openssl pkey -in "$RELEASE_PRIVATE_KEY" -check -noout

BG_USER="${BG_USER:-breakglass}"
BG_PASSWORD="${BG_PASSWORD:-}"
if [[ -z "$BG_PASSWORD" ]]; then
  while true; do
    read -r -s -p 'Break Glass password (min. 16 znakow): ' BG_PASSWORD; echo
    read -r -s -p 'Powtorz haslo: ' BG_PASSWORD_2; echo
    [[ "$BG_PASSWORD" == "$BG_PASSWORD_2" ]] || { echo 'Hasla nie sa identyczne.'; continue; }
    ((${#BG_PASSWORD} >= 16 && ${#BG_PASSWORD} <= 256)) || { echo 'Nieprawidlowa dlugosc hasla.'; continue; }
    break
  done
fi
[[ "$BG_USER" =~ ^[a-z0-9._-]{3,64}$ ]] || fail "Nieprawidlowy BG_USER."
BG_ACCESS_CODE="${BG_ACCESS_CODE:-$(openssl rand -base64 48 | tr '+/' '-_' | tr -d '=\r\n')}"
[[ "$BG_ACCESS_CODE" =~ ^[A-Za-z0-9_-]{24,128}$ ]] || fail "Nieprawidlowy access code."
jq -n --arg userName "$BG_USER" --arg password "$BG_PASSWORD" --arg accessCode "$BG_ACCESS_CODE" \
  '{userName:$userName,password:$password,accessCode:$accessCode}' >"$DATA_DIR/security/break-glass-bootstrap.json"
chown "$APP_UID:$APP_GID" "$DATA_DIR/security/break-glass-bootstrap.json"
chmod 0600 "$DATA_DIR/security/break-glass-bootstrap.json"
printf '%s\n' "$BG_USER" >/root/sirk-central-breakglass-user.txt
printf '%s\n' "$BG_ACCESS_CODE" >/root/sirk-central-breakglass-access-code.txt
chmod 0600 /root/sirk-central-breakglass-user.txt /root/sirk-central-breakglass-access-code.txt
unset BG_PASSWORD BG_PASSWORD_2 BG_ACCESS_CODE

cat >"$COMPOSE_FILE" <<EOF
services:
  central:
    image: ${IMAGE_NAME}
    container_name: ${CONTAINER_NAME}
    restart: unless-stopped
    ports:
      - "127.0.0.1:8080:8080"
    environment:
      ASPNETCORE_ENVIRONMENT: Production
      ASPNETCORE_URLS: http://+:8080
      AllowedHosts: "${CENTRAL_HOST};localhost;127.0.0.1"
      Sirk__ReverseProxy__TrustAll: "false"
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
EOF
chmod 0600 "$COMPOSE_FILE"
docker compose -f "$COMPOSE_FILE" config >/dev/null

FAIL_LOG="$(mktemp)"
if docker run --name sirk-central-failclosed-test --rm "$IMAGE_NAME" >"$FAIL_LOG" 2>&1; then
  cat "$FAIL_LOG"; rm -f "$FAIL_LOG"; fail "Kontener wystartowal bez sekretow."
fi
grep -Eqi 'startup refused|certificate|secret|bootstrap|signing' "$FAIL_LOG" || { cat "$FAIL_LOG"; rm -f "$FAIL_LOG"; fail "Nieoczekiwany wynik fail-closed."; }
rm -f "$FAIL_LOG"
echo 'FAIL-CLOSED: PASS'

docker compose -f "$COMPOSE_FILE" up -d
for _ in $(seq 1 90); do
  status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}no-health{{end}}' "$CONTAINER_NAME" 2>/dev/null || true)"
  [[ "$status" == healthy ]] && break
  [[ "$status" == unhealthy ]] && { docker logs "$CONTAINER_NAME"; fail "Kontener unhealthy."; }
  sleep 2
done
[[ "$(docker inspect --format '{{.State.Health.Status}}' "$CONTAINER_NAME")" == healthy ]] || fail "Timeout health."
[[ ! -e "$DATA_DIR/security/break-glass-bootstrap.json" ]] || fail "Bootstrap nie zostal usuniety."

curl -fsS --retry 10 --retry-delay 2 --retry-connrefused -H "Host: $CENTRAL_HOST" http://127.0.0.1:8080/healthz | jq .
VERSION_JSON="$(curl -fsS -H "Host: $CENTRAL_HOST" http://127.0.0.1:8080/api/v1/system/version)"
echo "$VERSION_JSON" | jq .
[[ "$(jq -r '.runtime' <<<"$VERSION_JSON")" == '.NET 10' ]] || fail "Nieprawidlowy runtime."
[[ "$(jq -r '.securityEnabled' <<<"$VERSION_JSON")" == true ]] || fail "Security disabled."

docker restart "$CONTAINER_NAME" >/dev/null
for _ in $(seq 1 60); do
  [[ "$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$CONTAINER_NAME" 2>/dev/null || true)" == healthy ]] && break
  sleep 2
done
[[ "$(docker inspect --format '{{.State.Health.Status}}' "$CONTAINER_NAME")" == healthy ]] || fail "Restart test failed."

echo
printf '%s\n' '============================================================'
printf 'SIRK Central reinstall: PASS\nHost: %s\nImage: %s\nCommit: %s\nLog: %s\n' "$CENTRAL_HOST" "$IMAGE_NAME" "$APP_COMMIT" "$LOG_FILE"
printf '%s\n' 'Break Glass user: /root/sirk-central-breakglass-user.txt'
printf '%s\n' 'Break Glass access code: /root/sirk-central-breakglass-access-code.txt'
printf '%s\n' 'Release private key: /root/sirk-release-signing-private-key.pem'
printf '%s\n' '============================================================'
