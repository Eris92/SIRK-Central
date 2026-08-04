#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

INSTALL_DIR="${SIRK_INSTALL_DIR:-/opt/sirk-central}"
PUBLIC_ORIGIN="${SIRK_PUBLIC_ORIGIN:-https://central.sirkportal.com}"
BASE_COMPOSE_FILE="${SIRK_COMPOSE_FILE:-docker-compose.yml}"
RESTART_TEST="${SIRK_SMOKE_RESTART:-1}"
BACKUP_TEST="${SIRK_SMOKE_BACKUP:-0}"
TIMEOUT_SECONDS="${SIRK_SMOKE_TIMEOUT_SECONDS:-180}"

log() { printf '[smoke] %s\n' "$*"; }
fail() { printf '[smoke] ERROR: %s\n' "$*" >&2; exit 1; }
for command in docker curl node; do command -v "$command" >/dev/null 2>&1 || fail "$command is required"; done
[[ -d "$INSTALL_DIR" ]] || fail "missing install directory: $INSTALL_DIR"
[[ -f "$INSTALL_DIR/$BASE_COMPOSE_FILE" ]] || fail "missing Compose file: $BASE_COMPOSE_FILE"
[[ -f "$INSTALL_DIR/$BASE_COMPOSE_FILE" ]] || fail "missing canonical Compose file: $BASE_COMPOSE_FILE"
[[ -f "$INSTALL_DIR/.env" ]] || fail "missing production .env"

cd "$INSTALL_DIR"
COMPOSE=(docker compose -f "$BASE_COMPOSE_FILE" --profile auth)
MAINTENANCE_COMPOSE=(docker compose -f "$BASE_COMPOSE_FILE" --profile auth --profile maintenance)
SERVICES=(central auth updater-gateway backup-manager caddy)

log "validating canonical Compose configuration"
"${COMPOSE[@]}" config >/dev/null
mapfile -t active_services < <("${COMPOSE[@]}" config --services)
printf '%s\n' "${active_services[@]}" >/tmp/sirk-smoke-services.txt
for service in "${SERVICES[@]}"; do grep -qx "$service" /tmp/sirk-smoke-services.txt || fail "missing service: $service"; done
if grep -qx updater /tmp/sirk-smoke-services.txt; then fail "privileged updater is active in base profile"; fi

log "starting base stack"
"${COMPOSE[@]}" up -d --build "${SERVICES[@]}"
[[ -z "$("${MAINTENANCE_COMPOSE[@]}" ps -q updater)" ]] || fail "privileged updater is running outside maintenance"

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
    then return 0; fi
    sleep 3
  done
  return 1
}

wait_ready || {
  "${COMPOSE[@]}" ps >&2 || true
  "${COMPOSE[@]}" logs --tail=150 "${SERVICES[@]}" >&2 || true
  fail "central did not become ready"
}

log "validating readiness and runtime lock"
"${COMPOSE[@]}" exec -T central node - <<'NODE'
const fs = require('node:fs');
Promise.all([
  fetch('http://127.0.0.1:8080/readyz').then(async response => {
    const body = await response.json();
    if (!response.ok || body.ok !== true) throw new Error('readyz failed');
    for (const name of ['passkeyStore','webauthnChallenges','loginTransactions']) {
      if (body.checks[name] !== true) throw new Error('missing readiness check: ' + name);
    }
  }),
  Promise.resolve().then(() => {
    const owner = JSON.parse(fs.readFileSync('/var/lib/sirk-central/.sirk-central-runtime.lock/owner.json','utf8'));
    if (!owner.instanceId || !owner.heartbeatAtUtc) throw new Error('runtime lock owner is invalid');
  })
]).catch(error => { console.error(error.message); process.exit(1); });
NODE

log "validating unprivileged gateway and closed worker"
"${COMPOSE[@]}" exec -T updater-gateway node - <<'NODE'
const token = process.env.SIRK_UPDATER_TOKEN;
Promise.all([
  fetch('http://127.0.0.1:8092/healthz').then(r => { if (!r.ok) throw new Error('gateway health failed'); }),
  fetch('http://127.0.0.1:8092/status', { headers: { Authorization: 'Bearer ' + token } }).then(async r => {
    const body = await r.json();
    if (r.status !== 409 || body.code !== 'UPDATER_MAINTENANCE_REQUIRED') throw new Error('gateway did not report closed maintenance');
  })
]).catch(error => { console.error(error.message); process.exit(1); });
NODE

log "validating Caddy"
"${COMPOSE[@]}" exec -T caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null

snapshot_stores() {
  "${COMPOSE[@]}" exec -T central node - <<'NODE'
const fs = require('node:fs');
const root = '/var/lib/sirk-central';
const names = ['passkeys.json','recovery-codes.json','webauthn-challenges.json','login-transactions.json','sessions.json'];
const out = {};
for (const name of names) {
  const file = root + '/' + name;
  if (!fs.existsSync(file)) { out[name] = null; continue; }
  const parsed = JSON.parse(fs.readFileSync(file,'utf8'));
  out[name] = { version: parsed.version || null, keys: Object.keys(parsed).sort() };
}
process.stdout.write(JSON.stringify(out));
NODE
}
SNAPSHOT_BEFORE="$(snapshot_stores)"
[[ -n "$SNAPSHOT_BEFORE" ]] || fail "could not inspect persistent stores"

if [[ "$RESTART_TEST" == "1" ]]; then
  log "restarting central and validating persistence"
  "${COMPOSE[@]}" restart central
  wait_ready || fail "central did not recover after restart"
  SNAPSHOT_AFTER="$(snapshot_stores)"
  [[ "$SNAPSHOT_BEFORE" == "$SNAPSHOT_AFTER" ]] || fail "persistent store structure changed after restart"
fi

log "checking HTTPS reverse proxy"
HEADERS_FILE="$(mktemp)"; BODY_FILE="$(mktemp)"
trap 'rm -f "$HEADERS_FILE" "$BODY_FILE"' EXIT
curl -fsS --max-time 20 -D "$HEADERS_FILE" -o "$BODY_FILE" "$PUBLIC_ORIGIN/readyz"
node -e 'const fs=require("node:fs");const body=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(body.ok!==true||!body.version)process.exit(1)' "$BODY_FILE"
grep -qi '^strict-transport-security:' "$HEADERS_FILE" || fail "HSTS header missing"
grep -qi '^x-frame-options: DENY' "$HEADERS_FILE" || fail "X-Frame-Options header missing"
grep -qi '^x-content-type-options: nosniff' "$HEADERS_FILE" || fail "X-Content-Type-Options header missing"

if [[ "$BACKUP_TEST" == "1" ]]; then
  [[ "$(id -u)" -eq 0 ]] || fail "backup smoke test requires root"
  log "creating and validating backup archive"
  OUTPUT="$(SIRK_INSTALL_DIR="$INSTALL_DIR" SIRK_COMPOSE_FILE="$BASE_COMPOSE_FILE"  deploy/backup.sh)"
  ARCHIVE="${OUTPUT##*: }"
  [[ -f "$ARCHIVE" ]] || fail "backup archive was not created"
  [[ ! -f "$ARCHIVE.sha256" ]] || (cd "$(dirname "$ARCHIVE")" && sha256sum -c "$(basename "$ARCHIVE.sha256")") >/dev/null
fi

log "PASS: canonical runtime, gateway, closed maintenance, HTTPS and persistence checks completed"
