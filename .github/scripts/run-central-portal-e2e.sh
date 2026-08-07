#!/usr/bin/env bash
set -euo pipefail

sudo apt-get update
sudo apt-get install --yes unzip openssl ca-certificates

rm -rf artifacts/e2e-central artifacts/e2e-portal artifacts/e2e-tls /tmp/sirk-portal-e2e
mkdir -p artifacts/e2e-central artifacts/e2e-portal artifacts/e2e-tls /tmp/sirk-portal-e2e

update_cache_root="$(mktemp -d /tmp/sirk-central-updates.XXXXXX)"
cleanup() {
  rm -rf "$update_cache_root"
}
trap cleanup EXIT
export Sirk__Updates__CacheRoot="$update_cache_root"

dotnet publish src/Sirk.Central/Sirk.Central.csproj \
  --configuration Release \
  --runtime linux-x64 \
  --self-contained false \
  --output artifacts/e2e-central \
  /p:DebugType=None \
  /p:DebugSymbols=false

curl --fail --location --silent --show-error \
  https://codeload.github.com/Eris92/SIRK-Portal/zip/refs/heads/main \
  --output /tmp/sirk-portal-e2e/portal.zip
unzip -q /tmp/sirk-portal-e2e/portal.zip -d /tmp/sirk-portal-e2e/source
portal_root="$(find /tmp/sirk-portal-e2e/source -mindepth 1 -maxdepth 1 -type d | head -n 1)"
test -f "$portal_root/src/Sirk.Portal/Sirk.Portal.csproj"
dotnet publish "$portal_root/src/Sirk.Portal/Sirk.Portal.csproj" \
  --configuration Release \
  --runtime linux-x64 \
  --self-contained false \
  --output artifacts/e2e-portal \
  /p:DebugType=None \
  /p:DebugSymbols=false

pushd artifacts/e2e-tls >/dev/null
openssl req -x509 -newkey rsa:3072 -nodes \
  -keyout ca.key -out ca.crt -days 2 \
  -subj '/CN=SIRK Product E2E Root CA'
openssl req -newkey rsa:3072 -nodes \
  -keyout central.key -out central.csr \
  -subj '/CN=central-e2e.local'
printf '%s\n' \
  'subjectAltName=DNS:central-e2e.local,DNS:localhost,IP:127.0.0.1' \
  'extendedKeyUsage=serverAuth' \
  'keyUsage=digitalSignature,keyEncipherment' > central.ext
openssl x509 -req -in central.csr \
  -CA ca.crt -CAkey ca.key -CAcreateserial \
  -out central.crt -days 2 -sha256 -extfile central.ext
openssl pkcs12 -export \
  -out central.pfx \
  -inkey central.key \
  -in central.crt \
  -certfile ca.crt \
  -passout pass:SIRK-E2E-PFX-2026!
popd >/dev/null

sudo cp artifacts/e2e-tls/ca.crt \
  /usr/local/share/ca-certificates/sirk-product-e2e.crt
sudo update-ca-certificates
if ! grep -q 'central-e2e.local' /etc/hosts; then
  echo '127.0.0.1 central-e2e.local' | sudo tee -a /etc/hosts
fi

export SIRK_E2E_CENTRAL_DLL="$PWD/artifacts/e2e-central/Sirk.Central.dll"
export SIRK_E2E_PORTAL_DLL="$PWD/artifacts/e2e-portal/Sirk.Portal.dll"
export SIRK_E2E_CENTRAL_PFX="$PWD/artifacts/e2e-tls/central.pfx"
export SIRK_E2E_CENTRAL_PFX_PASSWORD='SIRK-E2E-PFX-2026!'
export SIRK_E2E_CA_FILE="$PWD/artifacts/e2e-tls/ca.crt"
export NO_PROXY='central-e2e.local,localhost,127.0.0.1'
export no_proxy="$NO_PROXY"

python3 .github/scripts/test-central-portal-live.py
