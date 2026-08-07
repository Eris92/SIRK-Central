#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "NODE_FREE_CONTRACT_FAILED: $*" >&2
  exit 1
}

for forbidden in \
  package.json package-lock.json npm-shrinkwrap.json yarn.lock pnpm-lock.yaml \
  .nvmrc auth updater test scripts tools/finalize-dotnet10.py \
  docker-compose.appliance.yml \
  deploy/acceptance-test.sh deploy/appliance-bootstrap.sh deploy/appliance-install.sh \
  deploy/appliance-migrate.sh deploy/appliance-web-update.sh deploy/backup.sh \
  deploy/caddy deploy/clean-reinstall.sh deploy/configure-and-start.sh deploy/configure-auth.sh \
  deploy/dotnet10/docker-compose.yml deploy/install.sh deploy/maintenance-down.sh \
  deploy/maintenance-up.sh deploy/repair-breakglass-ui.sh deploy/reset-breakglass-password.sh \
  deploy/restore.sh deploy/rotate-access-key.sh deploy/smoke-test.sh deploy/web-update.sh; do
  [[ ! -e "$forbidden" ]] || fail "legacy Node/appliance/update artifact remains: $forbidden"
done

[[ -f src/Sirk.Central/Sirk.Central.csproj ]] || fail "Central .NET project is missing"
[[ "$(find src -mindepth 1 -maxdepth 1 ! -name Sirk.Central -print -quit)" == "" ]] || \
  fail "legacy source remains outside src/Sirk.Central"

if grep -RIE --include='*.csproj' --include='*.props' 'net(8|9)\.0' src tests Directory.Build.props; then
  fail "legacy .NET target remains"
fi
grep -q '<TargetFramework>net10.0</TargetFramework>' Directory.Build.props || \
  fail "Central does not target net10.0"

grep -q 'ENTRYPOINT \["dotnet", "Sirk.Central.dll"\]' Dockerfile || \
  fail "Dockerfile does not start ASP.NET Core"
! grep -qE '(^|[[:space:]])node([[:space:]]|$)|npm|src/server\.js' Dockerfile docker-compose.yml || \
  fail "Node runtime remains in deployment"
grep -q 'central:8080' Caddyfile || fail "Caddy does not proxy to the .NET Central service"
grep -q 'demo-orchestrator:8090' Caddyfile || fail "Caddy does not proxy Demo to the isolated orchestrator"
grep -q 'CENTRAL_REF=.*main' deploy/install-dotnet10.sh || fail "installer does not default to main"
grep -q 'CENTRAL_REF=.*main' deploy/reinstall-dotnet10.sh || fail "reinstaller does not default to main"

for script in deploy/upgrade-dotnet10-vps.sh deploy/reinstall-dotnet10.sh deploy/install-dotnet10.sh deploy/update.sh update.sh; do
  bash -n "$script" || fail "$script contains Bash syntax errors"
done

grep -Fq -- '--network host' deploy/upgrade-dotnet10-vps.sh || \
  fail "VPS upgrade build does not use host networking"
grep -Fq 'SIRK_DOCKER_NO_CACHE' deploy/upgrade-dotnet10-vps.sh || \
  fail "VPS upgrade does not expose optional no-cache diagnostics"
grep -Fq 'SIRK_SOURCE_READY' deploy/upgrade-dotnet10-vps.sh || \
  fail "VPS upgrade does not support verified cache source deployment"

# Runtime self-update must never rediscover source through Git or GitHub.
if grep -Eiq 'git[[:space:]]+(fetch|pull|clone|checkout)|raw\.githubusercontent\.com|api\.github\.com|github\.com/.*/releases' deploy/update.sh; then
  fail "runtime Central self-update still contains direct Git/GitHub source access"
fi
grep -Fq '/api/internal/v1/update/central/prepare' deploy/update.sh || \
  fail "runtime Central self-update does not use the local Central broker"
grep -Fq '/var/lib/sirk/updates/' deploy/update.sh || \
  fail "runtime Central self-update does not enforce the verified cache boundary"

# The Central runtime host may only import public release trust. Private signing
# material belongs exclusively to CI/signing environments.
! grep -Eq 'ecparam[^\n]*-genkey|genpkey[^\n]*EC|BEGIN (EC )?PRIVATE KEY' deploy/reinstall-dotnet10.sh || \
  fail "Central installer still generates/contains release private signing material"
grep -Fq 'sirk-release-trusted-keys.json' deploy/reinstall-dotnet10.sh || \
  fail "Central installer does not import the public release trust keyring"
grep -Fq 'sirk-updates-github-token' deploy/reinstall-dotnet10.sh || \
  fail "Central installer does not provision the single GitHub update token"
grep -Fq 'sirk-release-trusted-keys.json' docker-compose.yml || \
  fail "Compose does not mount the public release trust keyring"
grep -Fq 'sirk-updates-github-token' docker-compose.yml || \
  fail "Compose does not use the single Central GitHub update token"
! grep -Fq 'sirk-agent-updates-github-token' docker-compose.yml || \
  fail "legacy Agent-specific GitHub token remains in Compose"

python3 - <<'PY'
from pathlib import Path

path = Path('deploy/upgrade-dotnet10-vps.sh')
text = path.read_text(encoding='utf-8')
build = 'docker build "${BUILD_ARGS[@]}" "$SOURCE_DIR"'
stop = 'docker rm -f "$CENTRAL_CONTAINER" "$CADDY_CONTAINER"'
if build not in text:
    raise SystemExit('VPS upgrade is missing the resilient Docker build invocation.')
if stop not in text:
    raise SystemExit('VPS upgrade is missing the live-container replacement point.')
if text.index(build) >= text.index(stop):
    raise SystemExit('VPS upgrade must finish the new Docker build before stopping live containers.')
if 'if [[ "${SIRK_DOCKER_NO_CACHE:-0}" == "1" ]]; then' not in text:
    raise SystemExit('VPS upgrade must keep --no-cache opt-in rather than unconditional.')
print('VPS_UPGRADE_RESILIENCE_CONTRACT_OK')
PY

if grep -RIE --include='*.yml' --include='*.yaml' \
  'actions/setup-node|(^|[[:space:]])npm[[:space:]]+(ci|test|run)|(^|[[:space:]])node[[:space:]]+(--test|src/)|auth/server\.js|updater-gateway|Dockerfile\.gateway|Dockerfile\.manager' \
  .github/workflows; then
  fail "Node workflow remains"
fi

while IFS= read -r file; do
  [[ "$file" == public/* || "$file" == website/* ]] || \
    fail "JavaScript outside browser assets: $file"
done < <(
  find . -path './.git' -prune -o -type f \
    \( -name '*.js' -o -name '*.mjs' -o -name '*.cjs' \) -print |
    sed 's#^./##'
)

services="$(docker compose config --services 2>/dev/null || true)"
expected_services="$(printf '%s\n' central caddy demo-orchestrator | sort)"
actual_services="$(printf '%s\n' "$services" | sort)"
[[ "$actual_services" == "$expected_services" ]] || \
  fail "Compose must contain central, caddy and demo-orchestrator services; got: ${services//$'\n'/, }"

docker compose config --format json > /tmp/sirk-central-compose-contract.json
python3 - <<'PY'
import json
from pathlib import Path

compose = json.loads(Path('/tmp/sirk-central-compose-contract.json').read_text(encoding='utf-8'))
services = compose['services']

def targets(service):
    return [str(item.get('target', '')) for item in services[service].get('volumes', []) if isinstance(item, dict)]

central_targets = targets('central')
demo_targets = targets('demo-orchestrator')
caddy_volumes = services['caddy'].get('volumes', [])
if '/var/run/docker.sock' in central_targets:
    raise SystemExit('Central must never receive the Docker socket.')
if '/var/run/docker.sock' not in demo_targets:
    raise SystemExit('Only Demo orchestrator must receive the Docker socket.')
if '/var/lib/sirk/updates' not in central_targets:
    raise SystemExit('Central must mount the shared update cache read-write.')
if not any(isinstance(item, dict) and item.get('target') == '/srv/public-config' and item.get('read_only') is True for item in caddy_volumes):
    raise SystemExit('Caddy must mount the public config snapshot volume read-only.')
network = compose.get('networks', {}).get('sirk-demo', {})
if network.get('internal') is not True:
    raise SystemExit('Demo network must remain internal/effectively egress-blocked.')
print('DEMO_DEPLOYMENT_ISOLATION_CONTRACT_OK')
PY

echo NODE_FREE_DOTNET10_CONTRACT_OK
