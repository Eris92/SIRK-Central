#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "NODE_FREE_CONTRACT_FAILED: $*" >&2
  exit 1
}

for forbidden in \
  package.json package-lock.json npm-shrinkwrap.json yarn.lock pnpm-lock.yaml \
  .nvmrc auth updater test scripts tools/finalize-dotnet10.py; do
  [[ ! -e "$forbidden" ]] || fail "legacy Node or migration artifact remains: $forbidden"
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
grep -q 'CENTRAL_REF=.*main' deploy/install-dotnet10.sh || fail "installer does not default to main"
grep -q 'CENTRAL_REF=.*main' deploy/reinstall-dotnet10.sh || fail "reinstaller does not default to main"

bash -n deploy/upgrade-dotnet10-vps.sh || fail "VPS upgrade script contains Bash syntax errors"
grep -Fq -- '--network host' deploy/upgrade-dotnet10-vps.sh || \
  fail "VPS upgrade build does not use host networking"
grep -Fq 'SIRK_DOCKER_NO_CACHE' deploy/upgrade-dotnet10-vps.sh || \
  fail "VPS upgrade does not expose optional no-cache diagnostics"
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
[[ "$services" == $'central\ncaddy' || "$services" == $'caddy\ncentral' ]] || \
  fail "Compose must contain only central and caddy services; got: ${services//$'\n'/, }"

echo NODE_FREE_DOTNET10_CONTRACT_OK
