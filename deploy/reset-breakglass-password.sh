#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

INSTALL_DIR="${SIRK_INSTALL_DIR:-/opt/sirk-central}"
BASE_COMPOSE_FILE="${SIRK_COMPOSE_FILE:-docker-compose.yml}"
RUNTIME_COMPOSE_FILE="${SIRK_RUNTIME_COMPOSE_FILE:-docker-compose.portal-runtime.yml}"

fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
[[ "$(id -u)" -eq 0 ]] || fail "Run as root or through sudo."
[[ -t 0 && -t 1 ]] || fail "Interactive terminal required."
[[ -d "$INSTALL_DIR" ]] || fail "Missing installation directory: $INSTALL_DIR"
cd "$INSTALL_DIR"
[[ -f .env ]] || fail ".env is missing."
[[ -f "$BASE_COMPOSE_FILE" && -f "$RUNTIME_COMPOSE_FILE" ]] || fail "Canonical Compose files are missing."
[[ -f scripts/apply-emergency-security-reset.js ]] || fail "Emergency reset helper is missing."

COMPOSE=(docker compose -f "$BASE_COMPOSE_FILE" -f "$RUNTIME_COMPOSE_FILE" --profile auth)
MAINTENANCE_COMPOSE=(docker compose -f "$BASE_COMPOSE_FILE" -f "$RUNTIME_COMPOSE_FILE" --profile auth --profile maintenance)

read -r -s -p "New BreakGlass password: " PASSWORD
printf '\n'
read -r -s -p "Repeat password: " PASSWORD_CONFIRM
printf '\n'
[[ "$PASSWORD" == "$PASSWORD_CONFIRM" ]] || fail "Passwords do not match."
(( ${#PASSWORD} >= 16 && ${#PASSWORD} <= 256 )) || fail "Password must contain 16-256 characters."
[[ "$PASSWORD" != *$'\n'* && "$PASSWORD" != *$'\r'* ]] || fail "Password contains an unsupported newline."
unset PASSWORD_CONFIRM

"${COMPOSE[@]}" build central >/dev/null
PASSWORD_HASH="$(printf '%s' "$PASSWORD" | "${COMPOSE[@]}" run --rm -T --no-deps --entrypoint node central -e '
const { hashSecret } = require("./src/security");
let value = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => value += chunk);
process.stdin.on("end", () => {
  if (value.length < 16 || value.length > 256) process.exit(2);
  process.stdout.write(hashSecret(value));
});
')"
unset PASSWORD
[[ "$PASSWORD_HASH" == scrypt\$* ]] || fail "Password hash generation failed."
[[ "$PASSWORD_HASH" != *"'"* && "$PASSWORD_HASH" != *$'\n'* ]] || fail "Generated password hash is unsafe for dotenv."

ENV_BACKUP=".env.before-password-reset-$(date -u +%Y%m%dT%H%M%SZ)"
cp --preserve=mode,timestamps .env "$ENV_BACKUP"
chmod 0600 "$ENV_BACKUP"
TMP="$(mktemp "$INSTALL_DIR/.env.password.XXXXXX")"
trap 'rm -f "$TMP"; unset PASSWORD_HASH' EXIT
awk '!/^SIRK_ADMIN_PASSWORD_HASH=/' .env > "$TMP"
printf "SIRK_ADMIN_PASSWORD_HASH='%s'\n" "$PASSWORD_HASH" >> "$TMP"
chmod 0600 "$TMP"
mv "$TMP" .env
TMP=""

if ! "${COMPOSE[@]}" config >/dev/null; then
  mv .env ".env.invalid-password-reset"
  mv "$ENV_BACKUP" .env
  fail "Compose rejected the updated .env; previous file restored."
fi

"${COMPOSE[@]}" stop -t 30 central
if ! "${COMPOSE[@]}" run --rm -T --no-deps \
  -e "SIRK_EMERGENCY_PASSWORD_HASH=${PASSWORD_HASH}" \
  central node scripts/apply-emergency-security-reset.js; then
  mv .env ".env.failed-password-reset"
  mv "$ENV_BACKUP" .env
  "${COMPOSE[@]}" up -d --force-recreate central || true
  fail "Offline security override update failed; previous .env restored."
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

printf 'BreakGlass password reset completed. All local/BreakGlass sessions were revoked.\n'
printf 'Reauthenticate through the Access URL with the new password.\n'
