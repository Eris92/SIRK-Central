#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

COMPOSE_FILES=(-f docker-compose.yml -f docker-compose.portal-runtime.yml)
PROFILE_ARGS=(--profile auth)
SERVICES=(central auth updater backup-manager caddy)
PUBLIC_URL="${SIRK_ACCEPTANCE_PUBLIC_URL:-}"
SKIP_BUILD="${SIRK_ACCEPTANCE_SKIP_BUILD:-false}"
SKIP_LIVE="${SIRK_ACCEPTANCE_SKIP_LIVE:-false}"
RUN_SIMULATOR="${SIRK_ACCEPTANCE_RUN_SIMULATOR:-false}"

log() { printf '\n==> %s\n' "$*"; }
fail() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }
require() { command -v "$1" >/dev/null 2>&1 || fail "Missing required command: $1"; }
container_id() { docker compose "${COMPOSE_FILES[@]}" "${PROFILE_ARGS[@]}" ps -q "$1"; }
wait_healthy() {
  local service="$1" id state
  id="$(container_id "$service")"
  [[ -n "$id" ]] || fail "$service container was not created."
  for _ in $(seq 1 60); do
    state="$(docker inspect "$id" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}')"
    [[ "$state" == "healthy" || "$state" == "running" ]] && { printf '%s' "$state"; return 0; }
    if [[ "$state" == "unhealthy" || "$state" == "exited" || "$state" == "dead" ]]; then
      docker compose "${COMPOSE_FILES[@]}" "${PROFILE_ARGS[@]}" logs --tail=200 "$service" || true
      fail "$service state is $state"
    fi
    sleep 2
  done
  docker compose "${COMPOSE_FILES[@]}" "${PROFILE_ARGS[@]}" logs --tail=200 "$service" || true
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

require node
require npm
require docker
require curl
require git

test -f .env || fail ".env is missing. Run this only from the configured installation directory."

log "Repository state"
git status --short
git rev-parse --short HEAD

log "Shell syntax"
find deploy -maxdepth 1 -type f -name '*.sh' -print0 | xargs -0 -n1 bash -n

log "JavaScript syntax"
npm run check:syntax

log "Unit and HTTP regression tests"
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
const dockerfile = fs.readFileSync('Dockerfile.portal-runtime', 'utf8');
if (!dockerfile.includes('CMD ["node", "src/server-v15.js"]')) throw new Error('Docker runtime is not server-v15.js');
for (const required of [
  'src/server-v15.js','src/ticket-projection-store.js','src/ticket-projection-store-v2.js',
  'src/portal-command-store.js','src/request-rate-limiter.js','src/approval-store.js',
  'updater/backup-archive.js','updater/restore-transaction.js',
  'public/approval-center-ui.js','public/portal-operations-ui.js','public/portal-monitoring-ui.js','public/portal-monitoring-ui.css',
  'public/tickets-ui.js','public/tickets-ui.css','scripts/portal-simulator.js',
  'test/api-authorization.test.js','test/protocol-http.test.js','test/request-rate-limiter.test.js','test/ticket-projection-store.test.js',
  'test/updater-client-security.test.js','test/e2e/ui-buttons.spec.js','docs/SECURITY-AUDIT-2026-07-31.md'
]) if (!fs.existsSync(required)) throw new Error('Missing ' + required);
const compose = fs.readFileSync('docker-compose.yml', 'utf8');
if (!compose.includes('user: "0:0"')) throw new Error('Updater privileged runtime boundary is not explicit.');
if (!compose.includes('SIRK_UPDATER_ALLOWED_HOSTS: updater')) throw new Error('Updater SSRF host allowlist is missing.');
NODE

log "Docker Compose rendering"
docker compose "${COMPOSE_FILES[@]}" "${PROFILE_ARGS[@]}" config >/tmp/sirk-central-compose-acceptance.yml

if [[ "$SKIP_BUILD" != "true" ]]; then
  log "Building application images"
  docker compose "${COMPOSE_FILES[@]}" "${PROFILE_ARGS[@]}" build central auth updater backup-manager
fi

log "Starting complete canonical stack"
docker compose "${COMPOSE_FILES[@]}" "${PROFILE_ARGS[@]}" up -d --remove-orphans "${SERVICES[@]}"

log "Waiting for service readiness"
central_state="$(wait_healthy central)"
auth_state="$(wait_healthy auth)"
updater_state="$(wait_healthy updater)"
backup_manager_state="$(wait_healthy backup-manager)"

central_id="$(container_id central)"
auth_id="$(container_id auth)"
updater_id="$(container_id updater)"
backup_manager_id="$(container_id backup-manager)"

log "Container-local readiness contracts"
ready="$(docker exec "$central_id" node -e "fetch('http://127.0.0.1:8080/readyz').then(async r=>{console.log(await r.text());if(!r.ok)process.exit(1)}).catch(e=>{console.error(e);process.exit(1)})")"
printf '%s\n' "$ready"
node -e 'const body=JSON.parse(process.argv[1]);if(!body.ok)process.exit(1);for(const [key,value] of Object.entries(body.checks||{}))if(!value)throw new Error("Failed readiness check: "+key);' "$ready"
docker exec "$auth_id" node -e "fetch('http://127.0.0.1:8081/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
docker exec "$updater_id" node -e "fetch('http://127.0.0.1:8090/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
docker exec "$backup_manager_id" node -e "fetch('http://127.0.0.1:8091/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

log "Container users and security boundaries"
central_image="$(docker inspect "$central_id" --format '{{.Image}}')"
auth_image="$(docker inspect "$auth_id" --format '{{.Image}}')"
backup_manager_image="$(docker inspect "$backup_manager_id" --format '{{.Image}}')"
[[ "$(docker image inspect "$central_image" --format '{{.Config.User}}')" == "node" ]] || fail "Central image is not configured with USER node."
[[ "$(docker image inspect "$auth_image" --format '{{.Config.User}}')" == "node" ]] || fail "Auth image is not configured with USER node."
[[ "$(docker image inspect "$backup_manager_image" --format '{{.Config.User}}')" == "node" ]] || fail "Backup manager image is not configured with USER node."
[[ "$(docker inspect "$updater_id" --format '{{.Config.User}}')" == "0:0" ]] || fail "Updater must run as explicit root because Docker socket and repository update access are its documented trust boundary."
for service in central auth updater backup-manager; do assert_security_options "$service"; done
assert_no_published_ports updater
assert_no_published_ports backup-manager

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

if [[ "$SKIP_LIVE" != "true" && -n "$PUBLIC_URL" ]]; then
  log "External HTTPS and security headers"
  headers="$(mktemp)"; body="$(mktemp)"
  trap 'rm -f "$headers" "$body"' EXIT
  curl --fail --silent --show-error --location --max-time 20 --dump-header "$headers" --output "$body" "$PUBLIC_URL/readyz"
  grep -qi '^strict-transport-security:' "$headers" || fail "HSTS header missing."
  grep -qi '^content-security-policy:' "$headers" || fail "Content-Security-Policy missing."
  grep -qi '^x-content-type-options:[[:space:]]*nosniff' "$headers" || fail "X-Content-Type-Options missing."
  grep -qi '^x-frame-options:[[:space:]]*DENY' "$headers" || fail "X-Frame-Options missing."
  grep -qi '^referrer-policy:' "$headers" || fail "Referrer-Policy missing."
  node -e 'const fs=require("node:fs");const body=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(!body.ok)process.exit(1)' "$body"
fi

if [[ "$RUN_SIMULATOR" == "true" ]]; then
  : "${SIRK_SIMULATOR_ORIGIN:?Set SIRK_SIMULATOR_ORIGIN}"
  : "${SIRK_SIMULATOR_PORTAL_ID:?Set SIRK_SIMULATOR_PORTAL_ID}"
  : "${SIRK_SIMULATOR_PORTAL_TOKEN:?Set SIRK_SIMULATOR_PORTAL_TOKEN}"
  log "Portal heartbeat, ticket and command protocol simulator"
  node scripts/portal-simulator.js
fi

log "Acceptance checks completed"
printf 'HEAD=%s\n' "$(git rev-parse HEAD)"
printf 'Central=%s Auth=%s Updater=%s BackupManager=%s\n' "$central_state" "$auth_state" "$updater_state" "$backup_manager_state"
printf 'Manual blockers remain: restore drill, update/rollback drill, YubiKey, Entra role workflow, PL/EN and responsive visual review.\n'
