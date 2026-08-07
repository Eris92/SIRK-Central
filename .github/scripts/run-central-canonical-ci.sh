#!/usr/bin/env bash
set -euo pipefail

sudo apt-get update
sudo apt-get install --yes age
age --version

bash .github/scripts/validate-node-free-dotnet10.sh

dotnet restore src/Sirk.Central/Sirk.Central.csproj
dotnet build src/Sirk.Central/Sirk.Central.csproj \
  --configuration Release \
  --no-restore

dotnet list src/Sirk.Central/Sirk.Central.csproj package \
  --vulnerable \
  --include-transitive \
  --format json > /tmp/sirk-central-vulnerabilities.json
python3 - <<'PY'
import json
from pathlib import Path

report = json.loads(Path('/tmp/sirk-central-vulnerabilities.json').read_text(encoding='utf-8'))
findings = []

def inspect(value, location='root'):
    if isinstance(value, dict):
        for key, child in value.items():
            child_location = f'{location}.{key}'
            if key.lower() == 'vulnerabilities' and child:
                findings.append((child_location, child))
            inspect(child, child_location)
    elif isinstance(value, list):
        for index, child in enumerate(value):
            inspect(child, f'{location}[{index}]')

inspect(report)
if findings:
    raise SystemExit('Vulnerable NuGet dependencies detected: ' + repr(findings))
print('NUGET_VULNERABILITY_AUDIT_OK')
PY

for project in tests/*/*.csproj; do
  echo "Running $project"
  dotnet run --project "$project" --configuration Release
done

dotnet publish src/Sirk.Central/Sirk.Central.csproj \
  --configuration Release \
  --runtime linux-x64 \
  --self-contained false \
  --output artifacts/linux-x64 \
  /p:DebugType=None \
  /p:DebugSymbols=false

test -f artifacts/linux-x64/Sirk.Central.dll
test -f artifacts/linux-x64/public/index.html

mkdir -p secrets
touch \
  secrets/sirk-central-dataprotection.pfx \
  secrets/sirk-central-dataprotection-password \
  secrets/sirk-release-signing-public-key \
  secrets/sirk-demo-control-token

docker compose config > /tmp/sirk-central-compose.yml
test "$(docker compose config --services | sort | tr '\n' ' ')" = "caddy central demo-orchestrator "

docker run --rm \
  -e SIRK_ACME_EMAIL=admin@example.test \
  -e SIRK_WEBSITE_DOMAIN=example.test \
  -e SIRK_BUSINESS_DOMAIN=business.example.test \
  -e SIRK_DEMO_DOMAIN=demo.example.test \
  -e SIRK_CENTRAL_DOMAIN=central.example.test \
  -e SIRK_AUTH_DOMAIN=auth.example.test \
  -v "$PWD/Caddyfile:/etc/caddy/Caddyfile:ro" \
  caddy:2.10.0-alpine \
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile

docker build --tag sirk-central:dotnet10 .

docker run --detach --name sirk-central-smoke \
  -e Sirk__Security__Enabled=false \
  -e Sirk__Security__RequireProtectedDataProtectionKeys=false \
  -e Sirk__Security__RequireSignedReleases=false \
  -e Sirk__Security__RequireSingleWriterLease=false \
  -p 18080:8080 \
  sirk-central:dotnet10

cleanup() {
  docker logs sirk-central-smoke || true
  docker rm --force --volumes sirk-central-smoke >/dev/null 2>&1 || true
}
trap cleanup EXIT

for attempt in $(seq 1 60); do
  if curl --fail --silent --show-error \
    http://127.0.0.1:18080/healthz > /tmp/health.json; then
    grep -q 'healthy' /tmp/health.json
    cleanup
    trap - EXIT
    echo SIRK_CENTRAL_DOTNET10_RUNTIME_OK
    exit 0
  fi
  sleep 1
done

exit 1
