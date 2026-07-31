#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

INSTALL_DIR="${SIRK_INSTALL_DIR:-/opt/sirk-central}"
BASE_COMPOSE_FILE="${SIRK_COMPOSE_FILE:-docker-compose.yml}"
RUNTIME_COMPOSE_FILE="${SIRK_RUNTIME_COMPOSE_FILE:-docker-compose.portal-runtime.yml}"

fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
[[ "$(id -u)" -eq 0 ]] || fail "Run as root or through sudo."
[[ -t 1 ]] || fail "Interactive terminal required so the new access key can be shown safely."
[[ -d "$INSTALL_DIR" ]] || fail "Missing installation directory: $INSTALL_DIR"
cd "$INSTALL_DIR"
[[ -f .env ]] || fail ".env is missing."
[[ -f "$BASE_COMPOSE_FILE" && -f "$RUNTIME_COMPOSE_FILE" ]] || fail "Canonical Compose files are missing."
[[ -f scripts/apply-emergency-security-reset.js ]] || fail "Emergency reset helper is missing."

COMPOSE=(docker compose -f "$BASE_COMPOSE_FILE" -f "$RUNTIME_COMPOSE_FILE" --profile auth)
MAINTENANCE_COMPOSE=(docker compose -f "$BASE_COMPOSE_FILE" -f "$RUNTIME_COMPOSE_FILE" --profile auth --profile maintenance)

"${COMPOSE[@]}" build central >/dev/null
mapfile -t GENERATED < <(
  "${COMPOSE[@]}" run --rm -T --no-deps --entrypoint node central -e '
const { randomToken, hashAccessKey } = require("./src/security");
const key = randomToken(32);
process.stdout.write(key + "\n" + hashAccessKey(key) + "\n");
'
)
[[ "${#GENERATED[@]}" -eq 2 ]] || fail "Access key generation returned an unexpected result."
ACCESS_KEY="${GENERATED[0]}"
ACCESS_KEY_HASH="${GENERATED[1]}"
unset GENERATED
[[ "$ACCESS_KEY" =~ ^[A-Za-z0-9_-]{43,128}$ ]] || fail "Generated access key is invalid."
[[ "$ACCESS_KEY_HASH" == sha256\$* ]] || fail "Access key hash generation failed."
[[ "$ACCESS_KEY_HASH" != *"'"* && "$ACCESS_KEY_HASH" != *$'\n'* ]] || fail "Generated access key hash is unsafe for dotenv."

ENV_BACKUP=".env.before-access-key-rotation-$(date -u +%Y%m%dT%H%M%SZ)"
cp --preserve=mode,timestamps .env "$ENV_BACKUP"
chmod 0600 "$ENV_BACKUP"
TMP="$(mktemp "$INSTALL_DIR/.env.access-key.XXXXXX")"
cleanup() {
  rm -f "${TMP:-}"
  unset ACCESS_KEY_HASH
}
trap cleanup EXIT
awk '!/^SIRK_ACCESS_KEY_HASH=/' .env > "$TMP"
printf "SIRK_ACCESS_KEY_HASH='%s'\n" "$ACCESS_KEY_HASH" >> "$TMP"
chmod 0600 "$TMP"
mv "$TMP" .env
TMP=""

if ! "${COMPOSE[@]}" config >/dev/null; then
  mv .env ".env.invalid-access-key-rotation"
  mv "$ENV_BACKUP" .env
  fail "Compose rejected the updated .env; previous file restored."
fi

"${COMPOSE[@]}" stop -t 30 central
if ! "${COMPOSE[@]}" run --rm -T --no-deps \
  -e "SIRK_EMERGENCY_ACCESS_KEY_HASH=${ACCESS_KEY_HASH}" \
  central node scripts/apply-emergency-security-reset.js; then
  mv .env ".env.failed-access-key-rotation"
  mv "$ENV_BACKUP" .env
  "${COMPOSE[@]}" up -d --force-recreate central || true
  fail "Offline access-key update failed; previous .env restored."
fi
rm -f "$ENV_BACKUP"

"${COMPOSE[@]}" up -d --force-recreate central
central_id="$("${COMPOSE[@]}" ps -q central)"
[[ -n "$central_id" ]] || fail "Central container was not created."
for _ in $(seq 1 60); do
  state="$(docker inspect "$central_id" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}')"
  [[ "$state" == "healthy" ]] && break
  [[ "$state" == "unhealthy" || "$state" == "exited" || "$state" == "dead" ]] && fail "Central entered state: $state"
  sleep 2
done
[[ "$(docker inspect "$central_id" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}')" == "healthy" ]] || fail "Central did not become healthy."
[[ -z "$("${MAINTENANCE_COMPOSE[@]}" ps -q updater)" ]] || fail "Privileged updater worker is running outside maintenance."

printf '\nAccess key rotation completed. All local/BreakGlass sessions were revoked.\n'
printf 'New access key (shown once): %s\n' "$ACCESS_KEY"
unset ACCESS_KEY
printf 'Use the new key in the configured BreakGlass Access URL.\n'
