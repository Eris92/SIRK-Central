#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

COMPOSE_FILES=(-f docker-compose.yml -f docker-compose.portal-runtime.yml)
BASE_PROFILE_ARGS=(--profile auth)
MAINTENANCE_PROFILE_ARGS=(--profile auth --profile maintenance)
BASE_SERVICES=(central auth backup-manager caddy)
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
trap close_maintenance_window EXIT

require node
require npm
require python3
require docker
require curl
require git

test -f .env || fail ".env is missing. Run this only from the configured installation directory."

log "Repository state"
git status --short
git rev-parse --short HEAD

log "Shell and language syntax"
find deploy -maxdepth 1 -type f -name '*.sh' -print0 | xargs -0 -n1 bash -n
npm run check:syntax

log "Unit HTTP and concurrency regression tests"
npm test

log "Production dependency audit"
npm audit --omit=dev --audit-level=high

log "Runtime contract"
node - <<'NODE'
const fs = require('node:fs');
const pkg = require('./package.json');
const lock = require('./package-lock.json');
if (pkg.version !== lock.version || pkg.version !== lock.packages[''].version) throw new Error('Package versions differ.');
if (pkg.main !== 'src/server-v15.js') throw new Error('package.json main is not server-v15.js');
if (!String(pkg.scripts.start).includes('server-v15.js')) throw new Error('npm start is not server-v15.js');
for (const dockerfileName of ['Dockerfile', 'Dockerfile.portal-runtime']) {
  const dockerfile = fs.readFileSync(dockerfileName, 'utf8');
  if (!dockerfile.includes('CMD ["node", "src/server-v15.js"]')) throw new Error(dockerfileName + ' is not server-v15.js');
}
for (const required of [
  'src/server-v15.js','src/runtime-lock.js','src/ticket-projection-store.js','src/ticket-projection-store-v2.js',
  'src/portal-command-store.js','src/portal-command-store-v2.js','src/request-rate-limiter.js','src/approval-store.js','src/central-operation-guard.js',
  'src/sso-replay-store.js','src/sso-callback-handler.js','auth/hardened-server.js',
  'updater/backup-archive.js','updater/restore-transaction.js','scripts/validate-backup-archive.py',
  'public/approval-center-ui.js','public/portal-operations-ui.js','public/portal-monitoring-ui.js','public/portal-monitoring-ui.css',
  'public/tickets-ui.js','public/tickets-ui.css','scripts/portal-simulator.js',
  'test/api-authorization.test.js','test/central-http-matrix.test.js','test/central-operation-guard-http.test.js',
  'test/request-rate-limiter.test.js','test/runtime-lock.test.js','test/ticket-projection-store.test.js',
  'test/ticket-event-http-semantics.test.js','test/portal-command-cancellation.test.js','test/protocol-concurrency.test.js',
  'test/sso-frontchannel-logout.test.js','test/backup-archive.test.js','test/restore-transaction.test.js',
  'test/updater-client-security.test.js','test/e2e/ui-buttons.spec.js','deploy/maintenance-up.sh','deploy/maintenance-down.sh',
  'docs/SECURITY-AUDIT-2026-07-31.md'
]) if (!fs.existsSync(required)) throw new Error('Missing ' + required);
const runtime = fs.readFileSync('src/server-v15.js', 'utf8');
for (const expected of ['runtimeLockFactory.acquire','eventErrorResult','SIRK_RUNTIME_LOCK_DISABLED','/api/portal/v1/tickets/events']) {
  if (!runtime.includes(expected)) throw new Error('Runtime contract missing: ' + expected);
}
const commands = fs.readFileSync('src/portal-command-store-v2.js', 'utf8');
for (const expected of ['cancel_requested','control = "cancel"','COMMAND_CANCEL_NOT_REQUESTED']) {
  if (!commands.includes(expected)) throw new Error('Cooperative cancellation contract missing: ' + expected);
}
const compose = fs.readFileSync('docker-compose.yml', 'utf8');
if (!compose.includes('profiles: ["maintenance"]')) throw new Error('Updater is not restricted to the maintenance profile.');
if (!compose.includes('restart: "no"')) throw new Error('Updater must not restart outside an explicit maintenance action.');
if (!compose.includes('SIRK_UPDATER_ALLOWED_HOSTS: updater')) throw new Error('Updater SSRF host allowlist is missing.');
if (!compose.includes('SIRK_CENTRAL_INTERNAL_ORIGIN: http://central:8080')) throw new Error('Internal front-channel logout relay is not configured.');
const caddy = fs.readFileSync('deploy/Caddyfile', 'utf8');
if (!caddy.includes('@internalSsoLogout') || !caddy.includes('respond @internalSsoLogout 404')) throw new Error('Public Central does not hide the internal SSO logout endpoint.');
NODE

log "Docker Compose rendering without privileged maintenance profile"
compose_base config >/tmp/sirk-central-compose-base.yml
compose_base config --format json >/tmp/sirk-central-compose-base.json
node - <<'NODE'
const fs = require('node:fs');
const compose = JSON.parse(fs.readFileSync('/tmp/sirk-central-compose-base.json', 'utf8'));
for (const service of ['central','auth','backup-manager','caddy']) {
  if (!compose.services || !compose.services[service]) throw new Error('Missing base service: ' + service);
}
if (compose.services.updater) throw new Error('Updater must be absent when the maintenance profile is closed.');
NODE

log "Docker Compose rendering with maintenance profile"
compose_maintenance config >/tmp/sirk-central-compose-maintenance.yml
compose_maintenance config --format json >/tmp/sirk-central-compose-maintenance.json
node - <<'NODE'
const fs = require('node:fs');
const compose = JSON.parse(fs.readFileSync('/tmp/sirk-central-compose-maintenance.json', 'utf8'));
for (const service of ['central','auth','updater','backup-manager','caddy']) {
  if (!compose.services || !compose.services[service]) throw new Error('Missing maintenance service: ' + service);
}
if (String(compose.services.updater.user) !== '0:0') throw new Error('Updater root trust boundary is not explicit.');
if (compose.services.updater.restart !== 'no') throw new Error('Updater restart policy must be no.');
if (compose.services.updater.ports && compose.services.updater.ports.length) throw new Error('Updater publishes a host port.');
if (compose.services['backup-manager'].ports && compose.services['backup-manager'].ports.length) throw new Error('Backup manager publishes a host port.');
if (compose.services.auth.environment.SIRK_CENTRAL_INTERNAL_ORIGIN !== 'http://central:8080') throw new Error('Auth internal Central origin is invalid.');
NODE

if [[ "$SKIP_BUILD" != "true" ]]; then
  log "Building application images"
  compose_maintenance build central auth updater backup-manager
fi

log "Starting canonical base stack with maintenance window closed"
compose_base up -d --remove-orphans "${BASE_SERVICES[@]}"
[[ -z "$(compose_maintenance ps -q updater)" ]] || fail "Updater is running before the maintenance window was opened."

log "Waiting for base service readiness"
central_state="$(wait_healthy central)"
auth_state="$(wait_healthy auth)"
backup_manager_state="$(wait_healthy backup-manager)"

central_id="$(container_id central)"
auth_id="$(container_id auth)"
backup_manager_id="$(container_id backup-manager)"
caddy_id="$(container_id caddy)"

log "Container-local readiness contracts"
ready="$(docker exec "$central_id" node -e "fetch('http://127.0.0.1:8080/readyz').then(async r=>{console.log(await r.text());if(!r.ok)process.exit(1)}).catch(e=>{console.error(e);process.exit(1)})")"
printf '%s\n' "$ready"
node -e 'const body=JSON.parse(process.argv[1]);if(!body.ok)process.exit(1);for(const [key,value] of Object.entries(body.checks||{}))if(!value)throw new Error("Failed readiness check: "+key);' "$ready"
docker exec "$auth_id" node -e "fetch('http://127.0.0.1:8081/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
docker exec "$backup_manager_id" node -e "fetch('http://127.0.0.1:8091/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
docker exec "$caddy_id" caddy validate --config /etc/caddy/Caddyfile >/dev/null

log "Runtime single-writer lock is active"
docker exec "$central_id" node -e "const fs=require('node:fs');const p='/var/lib/sirk-central/.sirk-central-runtime.lock/owner.json';const v=JSON.parse(fs.readFileSync(p,'utf8'));if(!v.instanceId||!v.heartbeatAtUtc)process.exit(1)"

log "Internal SSO logout endpoint requires a signed ticket"
docker exec "$auth_id" node -e "fetch('http://central:8080/auth/sso/frontchannel-logout',{method:'POST'}).then(r=>{if(r.status!==401)throw new Error('Expected 401, got '+r.status)}).catch(e=>{console.error(e);process.exit(1)})"

log "Base container users and security boundaries"
central_image="$(docker inspect "$central_id" --format '{{.Image}}')"
auth_image="$(docker inspect "$auth_id" --format '{{.Image}}')"
backup_manager_image="$(docker inspect "$backup_manager_id" --format '{{.Image}}')"
[[ "$(docker image inspect "$central_image" --format '{{.Config.User}}')" == "node" ]] || fail "Central image is not configured with USER node."
[[ "$(docker image inspect "$auth_image" --format '{{.Config.User}}')" == "node" ]] || fail "Auth image is not configured with USER node."
[[ "$(docker image inspect "$backup_manager_image" --format '{{.Config.User}}')" == "root" ]] || fail "Backup manager image root trust boundary is not explicit."
for service in central auth backup-manager; do assert_security_options "$service"; done
assert_no_published_ports backup-manager

log "Opening explicit updater maintenance window"
compose_maintenance up -d --no-deps updater
updater_state="$(wait_healthy updater)"
updater_id="$(container_id updater)"
[[ "$(docker inspect "$updater_id" --format '{{.Config.User}}')" == "0:0" ]] || fail "Updater container must run as explicit root during maintenance."
assert_security_options updater
assert_no_published_ports updater

log "Updater Docker socket access"
docker exec "$updater_id" docker version --format '{{.Server.Version}}' >/dev/null

log "Non-destructive backup API check"
docker exec -i "$updater_id" node - <<'NODE'
const token = process.env.SIRK_UPDATER_TOKEN;
if (!token || token.length < 43) throw new Error('Updater token is missing.');
fetch('http://127.0.0.1:8090/backup/status', { headers: { Authorization: 'Bearer ' + token } })
  .then(async response => {
    const body = await response.json();
    if (!response.ok || !body.ok || !Array.isArray(body.backups)) throw new Error('Updater backup status contract failed.');
  })
  .catch(error => { console.error(error); process.exit(1); });
NODE

log "Closing updater maintenance window"
close_maintenance_window
[[ -z "$(compose_maintenance ps -q updater)" ]] || fail "Updater container remains after closing maintenance."

if [[ "$SKIP_LIVE" != "true" && -n "$PUBLIC_URL" ]]; then
  log "External HTTPS readiness headers"
  ready_headers="$(mktemp)"; ready_body="$(mktemp)"; root_headers="$(mktemp)"; internal_body="$(mktemp)"
  trap 'close_maintenance_window; rm -f "$ready_headers" "$ready_body" "$root_headers" "$internal_body"' EXIT
  curl --fail --silent --show-error --location --max-time 20 --dump-header "$ready_headers" --output "$ready_body" "$PUBLIC_URL/readyz"
  grep -qi '^strict-transport-security:' "$ready_headers" || fail "HSTS header missing."
  grep -qi '^x-content-type-options:[[:space:]]*nosniff' "$ready_headers" || fail "X-Content-Type-Options missing."
  grep -qi '^x-frame-options:[[:space:]]*DENY' "$ready_headers" || fail "X-Frame-Options missing."
  grep -qi '^referrer-policy:' "$ready_headers" || fail "Referrer-Policy missing."
  node -e 'const fs=require("node:fs");const body=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(!body.ok)process.exit(1)' "$ready_body"

  log "External HTML CSP"
  curl --fail --silent --show-error --max-time 20 --dump-header "$root_headers" --output /dev/null "$PUBLIC_URL/"
  grep -qi '^content-security-policy:' "$root_headers" || fail "Content-Security-Policy missing on HTML."

  log "Public route does not expose internal SSO logout relay"
  status="$(curl --silent --show-error --max-time 20 --output "$internal_body" --write-out '%{http_code}' -X POST "$PUBLIC_URL/auth/sso/frontchannel-logout")"
  [[ "$status" == "404" ]] || fail "Internal SSO logout route is externally reachable; HTTP $status"
fi

if [[ "$RUN_SIMULATOR" == "true" ]]; then
  : "${SIRK_SIMULATOR_ORIGIN:?Set SIRK_SIMULATOR_ORIGIN}"
  : "${SIRK_SIMULATOR_PORTAL_ID:?Set SIRK_SIMULATOR_PORTAL_ID}"
  : "${SIRK_SIMULATOR_PORTAL_TOKEN:?Set SIRK_SIMULATOR_PORTAL_TOKEN}"
  log "Portal heartbeat ticket command and cancellation protocol simulator"
  node scripts/portal-simulator.js
fi

log "Acceptance checks completed"
printf 'HEAD=%s\n' "$(git rev-parse HEAD)"
printf 'Central=%s Auth=%s UpdaterMaintenance=%s BackupManager=%s\n' "$central_state" "$auth_state" "$updater_state" "$backup_manager_state"
printf 'Updater maintenance window is closed.\n'
printf 'Manual blockers remain: destructive restore drill, update/rollback drill including updater self-recreate, real YubiKey, Entra role and front-channel logout workflow, PL/EN and responsive visual review.\n'
