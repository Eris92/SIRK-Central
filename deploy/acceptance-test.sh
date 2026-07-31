#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

COMPOSE_FILES=(-f docker-compose.yml -f docker-compose.portal-runtime.yml)
PROFILE_ARGS=(--profile auth)
PUBLIC_URL="${SIRK_ACCEPTANCE_PUBLIC_URL:-}"
SKIP_BUILD="${SIRK_ACCEPTANCE_SKIP_BUILD:-false}"
SKIP_LIVE="${SIRK_ACCEPTANCE_SKIP_LIVE:-false}"

log() { printf '\n==> %s\n' "$*"; }
fail() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }
require() { command -v "$1" >/dev/null 2>&1 || fail "Missing required command: $1"; }

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
if (pkg.main !== 'src/server-v14.js') throw new Error('package.json main is not server-v14.js');
if (!String(pkg.scripts.start).includes('server-v14.js')) throw new Error('npm start is not server-v14.js');
const dockerfile = fs.readFileSync('Dockerfile.portal-runtime', 'utf8');
if (!dockerfile.includes('CMD ["node", "src/server-v14.js"]')) throw new Error('Docker runtime is not server-v14.js');
for (const required of [
  'src/server-v14.js',
  'src/portal-command-store.js',
  'public/approval-center-ui.js',
  'public/portal-operations-ui.js',
  'public/portal-monitoring-ui.js',
  'public/portal-monitoring-ui.css',
  'docs/SECURITY-AUDIT-2026-07-31.md'
]) if (!fs.existsSync(required)) throw new Error('Missing ' + required);
NODE

log "Docker Compose rendering"
docker compose "${COMPOSE_FILES[@]}" "${PROFILE_ARGS[@]}" config >/tmp/sirk-central-compose-acceptance.yml

if [[ "$SKIP_BUILD" != "true" ]]; then
  log "Building application images"
  docker compose "${COMPOSE_FILES[@]}" "${PROFILE_ARGS[@]}" build central auth updater
fi

log "Starting services"
docker compose "${COMPOSE_FILES[@]}" "${PROFILE_ARGS[@]}" up -d central auth updater

log "Waiting for Central readiness"
central_id="$(docker compose "${COMPOSE_FILES[@]}" ps -q central)"
test -n "$central_id" || fail "Central container was not created."
for _ in $(seq 1 60); do
  state="$(docker inspect "$central_id" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}')"
  [[ "$state" == "healthy" ]] && break
  [[ "$state" == "unhealthy" || "$state" == "exited" || "$state" == "dead" ]] && {
    docker compose "${COMPOSE_FILES[@]}" logs --tail=200 central
    fail "Central state is $state"
  }
  sleep 2
done
state="$(docker inspect "$central_id" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}')"
[[ "$state" == "healthy" ]] || fail "Central did not become healthy; state=$state"

log "Container-local readiness contract"
ready="$(docker exec "$central_id" node -e "fetch('http://127.0.0.1:8080/readyz').then(async r=>{console.log(await r.text());if(!r.ok)process.exit(1)}).catch(e=>{console.error(e);process.exit(1)})")"
printf '%s\n' "$ready"
node -e 'const body=JSON.parse(process.argv[1]); if(!body.ok) process.exit(1); for(const [key,value] of Object.entries(body.checks||{})) if(!value) throw new Error("Failed readiness check: "+key);' "$ready"

log "Container hardening"
image="$(docker inspect "$central_id" --format '{{.Image}}')"
[[ "$(docker image inspect "$image" --format '{{.Config.User}}')" == "node" ]] || fail "Central image is not configured with USER node."
[[ "$(docker inspect "$central_id" --format '{{.HostConfig.SecurityOpt}}')" == *no-new-privileges* ]] || fail "no-new-privileges is missing."

if [[ "$SKIP_LIVE" != "true" && -n "$PUBLIC_URL" ]]; then
  log "External HTTPS and security headers"
  headers="$(mktemp)"
  body="$(mktemp)"
  curl --fail --silent --show-error --location --max-time 20 --dump-header "$headers" --output "$body" "$PUBLIC_URL/readyz"
  grep -qi '^strict-transport-security:' "$headers" || fail "HSTS header missing."
  grep -qi '^x-content-type-options:[[:space:]]*nosniff' "$headers" || fail "X-Content-Type-Options missing."
  grep -qi '^x-frame-options:[[:space:]]*DENY' "$headers" || fail "X-Frame-Options missing."
  node -e 'const fs=require("node:fs");const body=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(!body.ok)process.exit(1)' "$body"
fi

log "Acceptance checks completed"
printf 'HEAD=%s\n' "$(git rev-parse HEAD)"
printf 'Central=%s\n' "$state"
printf 'Next manual checks: Playwright workflow, YubiKey, backup/restore, update/rollback, Portal simulator, PL/EN visual review.\n'
