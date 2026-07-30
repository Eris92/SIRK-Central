#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

INSTALL_DIR="${SIRK_INSTALL_DIR:-/opt/sirk-central}"
PUBLIC_ORIGIN="${SIRK_PUBLIC_ORIGIN:-https://central.sirkportal.com}"
COMPOSE_FILE="${SIRK_COMPOSE_FILE:-docker-compose.yml}"
RESTART_TEST="${SIRK_SMOKE_RESTART:-1}"
BACKUP_TEST="${SIRK_SMOKE_BACKUP:-0}"
TIMEOUT_SECONDS="${SIRK_SMOKE_TIMEOUT_SECONDS:-180}"

log() { printf '[smoke] %s\n' "$*"; }
fail() { printf '[smoke] ERROR: %s\n' "$*" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || fail "docker is required"
command -v curl >/dev/null 2>&1 || fail "curl is required"
[[ -d "${INSTALL_DIR}" ]] || fail "missing install directory: ${INSTALL_DIR}"
[[ -f "${INSTALL_DIR}/${COMPOSE_FILE}" ]] || fail "missing Compose file: ${COMPOSE_FILE}"
[[ -f "${INSTALL_DIR}/.env" ]] || fail "missing production .env"

cd "${INSTALL_DIR}"
COMPOSE=(docker compose -f "${COMPOSE_FILE}" --profile auth)

log "validating Compose configuration"
"${COMPOSE[@]}" config >/dev/null

log "checking required services"
SERVICES="$("${COMPOSE[@]}" config --services)"
for service in central caddy auth; do
  grep -qx "${service}" <<<"${SERVICES}" || fail "missing service: ${service}"
done

log "starting application stack"
"${COMPOSE[@]}" up -d --build central auth caddy

wait_ready() {
  local deadline=$((SECONDS + TIMEOUT_SECONDS))
  while (( SECONDS < deadline )); do
    if "${COMPOSE[@]}" exec -T central node - <<'NODE' >/dev/null 2>&1
fetch('http://127.0.0.1:8080/readyz')
  .then(async response => {
    const body = await response.json();
    if (!response.ok || body.ok !== true || !body.version || !body.checks) process.exit(1);
  })
  .catch(() => process.exit(1));
NODE
    then
      return 0
    fi
    sleep 3
  done
  return 1
}

wait_ready || {
  "${COMPOSE[@]}" ps >&2 || true
  "${COMPOSE[@]}" logs --tail=150 central caddy auth >&2 || true
  fail "central did not become ready"
}

log "validating readiness payload"
"${COMPOSE[@]}" exec -T central node - <<'NODE'
fetch('http://127.0.0.1:8080/readyz')
  .then(async response => {
    const body = await response.json();
    if (!response.ok || body.ok !== true) throw new Error('readyz failed');
    const required = ['passkeyStore', 'webauthnChallenges', 'loginTransactions'];
    for (const name of required) {
      if (body.checks[name] !== true) throw new Error('missing readiness check: ' + name);
    }
    process.stdout.write(JSON.stringify(body) + '\n');
  })
  .catch(error => { console.error(error.message); process.exit(1); });
NODE

log "validating Caddy configuration"
"${COMPOSE[@]}" exec -T caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null

log "checking persistent MFA stores"
SNAPSHOT_BEFORE="$("${COMPOSE[@]}" exec -T central node - <<'NODE'
const fs = require('node:fs');
const path = '/var/lib/sirk-central';
const names = ['passkeys.json', 'recovery-codes.json', 'webauthn-challenges.json', 'login-transactions.json', 'sessions.json'];
const out = {};
for (const name of names) {
  const file = path + '/' + name;
  if (!fs.existsSync(file)) { out[name] = null; continue; }
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  out[name] = { version: parsed.version || null, keys: Object.keys(parsed).sort() };
}
process.stdout.write(JSON.stringify(out));
NODE
)"
[[ -n "${SNAPSHOT_BEFORE}" ]] || fail "could not inspect persistent stores"

if [[ "${RESTART_TEST}" == "1" ]]; then
  log "restarting central service"
  "${COMPOSE[@]}" restart central
  wait_ready || fail "central did not recover after restart"
  SNAPSHOT_AFTER="$("${COMPOSE[@]}" exec -T central node - <<'NODE'
const fs = require('node:fs');
const path = '/var/lib/sirk-central';
const names = ['passkeys.json', 'recovery-codes.json', 'webauthn-challenges.json', 'login-transactions.json', 'sessions.json'];
const out = {};
for (const name of names) {
  const file = path + '/' + name;
  if (!fs.existsSync(file)) { out[name] = null; continue; }
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  out[name] = { version: parsed.version || null, keys: Object.keys(parsed).sort() };
}
process.stdout.write(JSON.stringify(out));
NODE
)"
  [[ "${SNAPSHOT_BEFORE}" == "${SNAPSHOT_AFTER}" ]] || fail "persistent store structure changed after restart"
fi

log "checking HTTPS reverse proxy"
HEADERS_FILE="$(mktemp)"
BODY_FILE="$(mktemp)"
trap 'rm -f "${HEADERS_FILE}" "${BODY_FILE}"' EXIT
curl -fsS --max-time 20 -D "${HEADERS_FILE}" -o "${BODY_FILE}" "${PUBLIC_ORIGIN}/readyz"
node - "${BODY_FILE}" <<'NODE'
const fs = require('node:fs');
const body = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (body.ok !== true || !body.version) process.exit(1);
NODE
grep -qi '^strict-transport-security:' "${HEADERS_FILE}" || fail "HSTS header missing"
grep -qi '^x-frame-options: DENY' "${HEADERS_FILE}" || fail "X-Frame-Options header missing"
grep -qi '^x-content-type-options: nosniff' "${HEADERS_FILE}" || fail "X-Content-Type-Options header missing"

if [[ "${BACKUP_TEST}" == "1" ]]; then
  [[ "$(id -u)" -eq 0 ]] || fail "backup smoke test requires root"
  log "creating and validating backup archive"
  OUTPUT="$(SIRK_INSTALL_DIR="${INSTALL_DIR}" SIRK_COMPOSE_FILE="${COMPOSE_FILE}" deploy/backup.sh)"
  ARCHIVE="${OUTPUT##*: }"
  [[ -f "${ARCHIVE}" ]] || fail "backup archive was not created"
  if [[ -f "${ARCHIVE}.sha256" ]]; then
    (cd "$(dirname "${ARCHIVE}")" && sha256sum -c "$(basename "${ARCHIVE}.sha256")") >/dev/null
  fi
  if [[ "${ARCHIVE}" == *.tar.gz ]]; then
    tar -tzf "${ARCHIVE}" | grep -q '/data/' || fail "backup does not contain data"
    tar -tzf "${ARCHIVE}" | grep -q '/commit.txt$' || fail "backup does not contain commit metadata"
  fi
fi

log "PASS: runtime, Caddy, HTTPS, readiness and persistence checks completed"
