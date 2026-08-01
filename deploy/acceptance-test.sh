#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

COMPOSE_FILES=(-f docker-compose.yml)
BASE_PROFILE_ARGS=(--profile auth)
MAINTENANCE_PROFILE_ARGS=(--profile auth --profile maintenance)
BASE_SERVICES=(central auth updater-gateway backup-manager caddy)
PUBLIC_URL="${SIRK_ACCEPTANCE_PUBLIC_URL:-}"
SKIP_BUILD="${SIRK_ACCEPTANCE_SKIP_BUILD:-false}"
SKIP_LIVE="${SIRK_ACCEPTANCE_SKIP_LIVE:-false}"
RUN_SIMULATOR="${SIRK_ACCEPTANCE_RUN_SIMULATOR:-false}"

log() { printf '\n==> %s\n' "$*"; }
fail() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }
require() { command -v "$1" >/dev/null 2>&1 || fail "Missing required command: $1"; }
compose_base() { docker compose "${COMPOSE_FILES[@]}" "${BASE_PROFILE_ARGS[@]}" "$@"; }
compose_maintenance() { docker compose "${COMPOSE_FILES[@]}" "${MAINTENANCE_PROFILE_ARGS[@]}" "$@"; }
container_id() { compose_maintenance ps -q "$1"; }

wait_healthy() {
  local service="$1" id state
  id="$(container_id "$service")"
  [[ -n "$id" ]] || fail "$service container was not created."
  for _ in $(seq 1 60); do
    state="$(docker inspect "$id" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}')"
    [[ "$state" == "healthy" || "$state" == "running" ]] && { printf '%s' "$state"; return 0; }
    if [[ "$state" == "unhealthy" || "$state" == "exited" || "$state" == "dead" ]]; then
      compose_maintenance logs --tail=200 "$service" || true
      fail "$service state is $state"
    fi
    sleep 2
  done
  compose_maintenance logs --tail=200 "$service" || true
  fail "$service did not become healthy; state=$state"
}
assert_no_published_ports() {
  local service="$1" id bindings
  id="$(container_id "$service")"
  bindings="$(docker inspect "$id" --format '{{json .HostConfig.PortBindings}}')"
  [[ "$bindings" == "null" || "$bindings" == "{}" ]] || fail "$service unexpectedly publishes host ports: $bindings"
}
assert_security_options() {
  local service="$1" id security capdrop
  id="$(container_id "$service")"
  security="$(docker inspect "$id" --format '{{json .HostConfig.SecurityOpt}}')"
  capdrop="$(docker inspect "$id" --format '{{json .HostConfig.CapDrop}}')"
  [[ "$security" == *no-new-privileges* ]] || fail "$service is missing no-new-privileges."
  [[ "$capdrop" == *ALL* ]] || fail "$service does not drop all Linux capabilities."
}
close_maintenance_window() {
  compose_maintenance stop -t 15 updater >/dev/null 2>&1 || true
  compose_maintenance rm -f updater >/dev/null 2>&1 || true
}
gateway_expect() {
  local expected_status="$1" expected_code="$2" gateway_id
  gateway_id="$(container_id updater-gateway)"
  docker exec -i "$gateway_id" node - "$expected_status" "$expected_code" <<'NODE'
const expectedStatus = Number(process.argv[2]);
const expectedCode = process.argv[3];
const token = process.env.SIRK_UPDATER_TOKEN;
if (!token || token.length < 43) throw new Error('Updater token is missing.');
fetch('http://127.0.0.1:8092/backup/status', { headers: { Authorization: 'Bearer ' + token } })
  .then(async response => {
    const body = await response.json();
    if (response.status !== expectedStatus) throw new Error('Expected HTTP ' + expectedStatus + ', got ' + response.status + ': ' + JSON.stringify(body));
    if (expectedCode && body.code !== expectedCode) throw new Error('Expected code ' + expectedCode + ', got ' + String(body.code));
    if (expectedStatus === 200 && (!body.ok || !Array.isArray(body.backups))) throw new Error('Gateway did not proxy backup status.');
  })
  .catch(error => { console.error(error); process.exit(1); });
NODE
}
trap close_maintenance_window EXIT

require node
require npm
require python3
require docker
require curl
require git
[[ -f .env ]] || fail ".env is missing."

log "Repository state"
git status --short
git rev-parse --short HEAD

log "Syntax unit HTTP and concurrency tests"
npm run check:syntax
SIRK_CONCURRENCY_TEST_REQUESTS="${SIRK_CONCURRENCY_TEST_REQUESTS:-24}" npm test

log "Production dependency audit"
npm audit --omit=dev --audit-level=high

log "Runtime and source contracts"
node - <<'NODE'
const fs = require('node:fs');
const pkg = require('./package.json');
const lock = require('./package-lock.json');
if (pkg.version !== lock.version || pkg.version !== lock.packages[''].version) throw new Error('Package versions differ.');
if (pkg.main !== 'src/server.js' || pkg.scripts.start !== 'node src/server.js') throw new Error('Canonical runtime entry is invalid.');
if (!fs.readFileSync('Dockerfile', 'utf8').includes('CMD ["node", "src/server.js"]')) throw new Error('Dockerfile runtime is invalid.');
for (const required of [
  'src/server.js','src/runtime-lock.js','src/ticket-projection-store.js','src/portal-command-store.js',
  'src/sso-callback-handler.js','src/central-operation-guard.js','auth/server.js',
  'updater/gateway-server.js','updater/server.js','updater/management-server.js','updater/backup-archive.js','updater/restore-transaction.js',
  'test/runtime-lock.test.js','test/portal-command-cancellation.test.js','test/ticket-event-http-semantics.test.js',
  'test/protocol-concurrency.test.js','test/updater-gateway.test.js','test/e2e/ui-buttons.spec.js',
  'deploy/maintenance-up.sh','deploy/maintenance-down.sh','scripts/sync-main.sh'
]) if (!fs.existsSync(required)) throw new Error('Missing ' + required);
const runtime = fs.readFileSync('src/modules/tickets.js', 'utf8');
for (const expected of ['runtimeLockFactory.acquire','eventErrorResult','SIRK_RUNTIME_LOCK_DISABLED']) if (!runtime.includes(expected)) throw new Error('Runtime contract missing: ' + expected);
const commands = fs.readFileSync('src/portal-command-store.js', 'utf8');
for (const expected of ['cancel_requested','control = "cancel"','COMMAND_CANCEL_NOT_REQUESTED']) if (!commands.includes(expected)) throw new Error('Cancellation contract missing: ' + expected);
const gateway = fs.readFileSync('updater/gateway-server.js', 'utf8');
for (const expected of ['UPDATER_MAINTENANCE_REQUIRED','pathAllowed','workerOrigin']) if (!gateway.includes(expected)) throw new Error('Gateway contract missing: ' + expected);
const compose = fs.readFileSync('docker-compose.yml', 'utf8');
for (const expected of [
  'SIRK_UPDATER_ORIGIN: http://updater-gateway:8092',
  'SIRK_UPDATER_ALLOWED_HOSTS: updater-gateway',
  'command: ["node", "/app/gateway-server.js"]',
  'profiles: ["maintenance"]','restart: "no"'
]) if (!compose.includes(expected)) throw new Error('Compose contract missing: ' + expected);
NODE

log "Base Compose excludes privileged worker and includes gateway"
mapfile -t active_base < <(compose_base config --services)
printf '%s\n' "${active_base[@]}" >/tmp/sirk-base-services.txt
for service in "${BASE_SERVICES[@]}"; do grep -qx "$service" /tmp/sirk-base-services.txt || fail "Missing base service: $service"; done
if grep -qx updater /tmp/sirk-base-services.txt; then fail "Privileged updater is active outside maintenance profile."; fi
compose_base config >/tmp/sirk-central-compose-base.yml

log "Maintenance Compose includes privileged worker"
mapfile -t active_maintenance < <(compose_maintenance config --services)
printf '%s\n' "${active_maintenance[@]}" >/tmp/sirk-maintenance-services.txt
grep -qx updater /tmp/sirk-maintenance-services.txt || fail "Maintenance profile does not include updater."
compose_maintenance config --format json >/tmp/sirk-central-compose-maintenance.json
node - <<'NODE'
const fs = require('node:fs');
const compose = JSON.parse(fs.readFileSync('/tmp/sirk-central-compose-maintenance.json', 'utf8'));
for (const service of ['central','auth','updater-gateway','updater','backup-manager','caddy']) if (!compose.services?.[service]) throw new Error('Missing service: ' + service);
if (String(compose.services['updater-gateway'].user) !== 'node') throw new Error('Gateway must run as node.');
if (String(compose.services.updater.user) !== '0:0') throw new Error('Worker root boundary is not explicit.');
if (compose.services.updater.restart !== 'no') throw new Error('Worker restart policy must be no.');
for (const service of ['updater-gateway','updater','backup-manager']) if (compose.services[service].ports?.length) throw new Error(service + ' publishes host ports.');
if (compose.services.central.environment.SIRK_UPDATER_ORIGIN !== 'http://updater-gateway:8092') throw new Error('Central bypasses updater gateway.');
NODE

if [[ "$SKIP_BUILD" != "true" ]]; then
  log "Building application images"
  compose_maintenance build central auth updater-gateway updater backup-manager
fi

log "Starting base stack with maintenance worker closed"
compose_base up -d --remove-orphans "${BASE_SERVICES[@]}"
[[ -z "$(compose_maintenance ps -q updater)" ]] || fail "Updater worker is running before maintenance window."

central_state="$(wait_healthy central)"
auth_state="$(wait_healthy auth)"
gateway_state="$(wait_healthy updater-gateway)"
backup_manager_state="$(wait_healthy backup-manager)"
caddy_state="$(wait_healthy caddy)"

central_id="$(container_id central)"
auth_id="$(container_id auth)"
gateway_id="$(container_id updater-gateway)"
backup_manager_id="$(container_id backup-manager)"
caddy_id="$(container_id caddy)"

log "Readiness and runtime storage lease"
ready="$(docker exec "$central_id" node -e "fetch('http://127.0.0.1:8080/readyz').then(async r=>{console.log(await r.text());if(!r.ok)process.exit(1)}).catch(e=>{console.error(e);process.exit(1)})")"
node -e 'const body=JSON.parse(process.argv[1]);if(!body.ok)process.exit(1);for(const [key,value] of Object.entries(body.checks||{}))if(!value)throw new Error("Failed readiness check: "+key);' "$ready"
docker exec "$auth_id" node -e "fetch('http://127.0.0.1:8081/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
docker exec "$gateway_id" node -e "fetch('http://127.0.0.1:8092/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
docker exec "$backup_manager_id" node -e "fetch('http://127.0.0.1:8091/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
docker exec "$caddy_id" caddy validate --config /etc/caddy/Caddyfile >/dev/null
docker exec "$central_id" node -e "const fs=require('node:fs');const v=JSON.parse(fs.readFileSync('/var/lib/sirk-central/.sirk-central-runtime.lock/owner.json','utf8'));if(!v.instanceId||!v.heartbeatAtUtc)process.exit(1)"

log "Gateway reports closed maintenance window without HTTP 500"
gateway_expect 409 UPDATER_MAINTENANCE_REQUIRED

log "Container users ports and security options"
[[ "$(docker inspect "$central_id" --format '{{.Config.User}}')" == "node" ]] || fail "Central container user is not node."
[[ "$(docker inspect "$auth_id" --format '{{.Config.User}}')" == "node" ]] || fail "Auth container user is not node."
[[ "$(docker inspect "$gateway_id" --format '{{.Config.User}}')" == "node" ]] || fail "Updater gateway user is not node."
for service in central auth updater-gateway backup-manager; do assert_security_options "$service"; done
for service in updater-gateway backup-manager; do assert_no_published_ports "$service"; done

log "Opening maintenance worker"
compose_maintenance up -d --no-deps updater
updater_state="$(wait_healthy updater)"
updater_id="$(container_id updater)"
[[ "$(docker inspect "$updater_id" --format '{{.Config.User}}')" == "0:0" ]] || fail "Updater worker must run as explicit root."
assert_security_options updater
assert_no_published_ports updater
docker exec "$updater_id" docker version --format '{{.Server.Version}}' >/dev/null

log "Gateway proxies worker only during maintenance"
gateway_expect 200 ""

log "Closing maintenance worker"
close_maintenance_window
[[ -z "$(compose_maintenance ps -q updater)" ]] || fail "Updater worker remains after maintenance."
gateway_expect 409 UPDATER_MAINTENANCE_REQUIRED

log "Internal SSO logout endpoint requires signed ticket"
docker exec "$auth_id" node -e "fetch('http://central:8080/auth/sso/frontchannel-logout',{method:'POST'}).then(r=>{if(r.status!==401)throw new Error('Expected 401, got '+r.status)}).catch(e=>{console.error(e);process.exit(1)})"

if [[ "$SKIP_LIVE" != "true" && -n "$PUBLIC_URL" ]]; then
  log "External HTTPS CSP and security headers"
  ready_headers="$(mktemp)"; ready_body="$(mktemp)"; root_headers="$(mktemp)"; internal_body="$(mktemp)"
  trap 'close_maintenance_window; rm -f "$ready_headers" "$ready_body" "$root_headers" "$internal_body"' EXIT
  curl --fail --silent --show-error --location --max-time 20 --dump-header "$ready_headers" --output "$ready_body" "$PUBLIC_URL/readyz"
  grep -qi '^strict-transport-security:' "$ready_headers" || fail "HSTS header missing."
  grep -qi '^x-content-type-options:[[:space:]]*nosniff' "$ready_headers" || fail "X-Content-Type-Options missing."
  grep -qi '^x-frame-options:[[:space:]]*DENY' "$ready_headers" || fail "X-Frame-Options missing."
  grep -qi '^referrer-policy:' "$ready_headers" || fail "Referrer-Policy missing."
  node -e 'const fs=require("node:fs");const body=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(!body.ok)process.exit(1)' "$ready_body"
  curl --fail --silent --show-error --max-time 20 --dump-header "$root_headers" --output /dev/null "$PUBLIC_URL/"
  grep -qi '^content-security-policy:' "$root_headers" || fail "CSP missing on HTML."
  status="$(curl --silent --show-error --max-time 20 --output "$internal_body" --write-out '%{http_code}' -X POST "$PUBLIC_URL/auth/sso/frontchannel-logout")"
  [[ "$status" == "404" ]] || fail "Internal SSO logout route is externally reachable; HTTP $status"
fi

if [[ "$RUN_SIMULATOR" == "true" ]]; then
  : "${SIRK_SIMULATOR_ORIGIN:?Set SIRK_SIMULATOR_ORIGIN}"
  : "${SIRK_SIMULATOR_PORTAL_ID:?Set SIRK_SIMULATOR_PORTAL_ID}"
  : "${SIRK_SIMULATOR_PORTAL_TOKEN:?Set SIRK_SIMULATOR_PORTAL_TOKEN}"
  log "Portal protocol simulator"
  node scripts/portal-simulator.js
fi

log "Acceptance checks completed"
printf 'HEAD=%s\n' "$(git rev-parse HEAD)"
printf 'Central=%s Auth=%s Gateway=%s UpdaterMaintenance=%s BackupManager=%s Caddy=%s\n' "$central_state" "$auth_state" "$gateway_state" "$updater_state" "$backup_manager_state" "$caddy_state"
printf 'Updater worker is removed; gateway reports maintenance-required.\n'
printf 'Manual blockers: restore/update rollback drills, YubiKey, Entra workflow, PL/EN and responsive review.\n'
