#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

ROOT="$(mktemp -d /tmp/sirk-central-self-update-e2e.XXXXXX)"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TEST_INSTALL="$ROOT/install"
FAKE_BIN="$ROOT/bin"
BROKER_RESPONSE="$ROOT/broker-response.json"
OLD_COMMIT="1111111111111111111111111111111111111111"
SUCCESS_COMMIT="2222222222222222222222222222222222222222"
FAIL_COMMIT="3333333333333333333333333333333333333333"

cleanup() {
  sudo rm -rf "$ROOT" 2>/dev/null || true
}
trap cleanup EXIT

mkdir -p "$FAKE_BIN" "$TEST_INSTALL/source/deploy" "$TEST_INSTALL/secrets" "$TEST_INSTALL/updates"
printf '%064d\n' 0 > "$TEST_INSTALL/secrets/sirk-update-host-token"
printf '%s\n' "$OLD_COMMIT" > "$TEST_INSTALL/source/.sirk-release-commit"
cat > "$TEST_INSTALL/source/deploy/upgrade-dotnet10-vps.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf 'old-source-redeploy %s\n' "${SIRK_RELEASE_COMMIT:-}" >> "${INSTALL_ROOT}/deployment-events.log"
SH
chmod 0700 "$TEST_INSTALL/source/deploy/upgrade-dotnet10-vps.sh"
printf 'old-source\n' > "$TEST_INSTALL/source/source-marker.txt"
cat > "$TEST_INSTALL/current-release.json" <<JSON
{"schemaVersion":1,"applicationId":"sirk-central","version":"0.1.1.1","commit":"$OLD_COMMIT","sha256":"$(printf 'a%.0s' {1..64})"}
JSON

cat > "$FAKE_BIN/docker" <<'SH'
#!/usr/bin/env bash
exit 0
SH
cat > "$FAKE_BIN/curl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
[[ "$1" == "--config" && -f "$2" ]] || { echo 'unexpected curl invocation' >&2; exit 64; }
out="$(awk -F'"' '/^output = / {print $2; exit}' "$2")"
[[ -n "$out" && -n "${SIRK_TEST_BROKER_RESPONSE:-}" ]] || exit 65
cp "$SIRK_TEST_BROKER_RESPONSE" "$out"
SH
chmod 0700 "$FAKE_BIN/docker" "$FAKE_BIN/curl"

create_package() {
  local version="$1" commit="$2" fail_deploy="$3"
  local payload="$ROOT/payload-$version"
  local relative="sirk-central/linux-x64/stable/$version/package.zip"
  local package="$TEST_INSTALL/updates/$relative"
  rm -rf "$payload"
  mkdir -p "$payload/src/Sirk.Central" "$payload/deploy/dotnet10" "$payload/website" "$(dirname "$package")"
  printf 'FROM scratch\n' > "$payload/Dockerfile.dotnet10"
  printf '<Project />\n' > "$payload/Directory.Build.props"
  printf '{"sdk":{"version":"10.0.100"}}\n' > "$payload/global.json"
  printf '<Project Sdk="Microsoft.NET.Sdk.Web" />\n' > "$payload/src/Sirk.Central/Sirk.Central.csproj"
  printf ':80 { respond "test" 200 }\n' > "$payload/deploy/dotnet10/Caddyfile"
  printf '<!doctype html><title>SIRK</title>\n' > "$payload/website/index.html"
  cat > "$payload/deploy/upgrade-dotnet10-vps.sh" <<SH
#!/usr/bin/env bash
set -euo pipefail
printf 'new-source-deploy $version %s\n' "\${SIRK_RELEASE_COMMIT:-}" >> "\${INSTALL_ROOT}/deployment-events.log"
[[ "$fail_deploy" == "0" ]] || exit 73
[[ "\${SIRK_SOURCE_READY:-}" == "1" ]] || exit 74
[[ "\${SIRK_UPDATE_BUSINESS:-}" == "0" ]] || exit 75
[[ "\${SIRK_RELEASE_COMMIT:-}" == "$commit" ]] || exit 76
SH
  chmod 0700 "$payload/deploy/upgrade-dotnet10-vps.sh"
  printf 'new-source-%s\n' "$version" > "$payload/source-marker.txt"
  python3 - "$payload" "$version" <<'PY'
import hashlib,json,os,sys
root,version=sys.argv[1:]
files=[]
for base,dirs,names in os.walk(root):
    dirs.sort(); names.sort()
    for name in names:
        path=os.path.join(base,name)
        rel=os.path.relpath(path,root).replace(os.sep,'/')
        if rel=='update-manifest.json':
            continue
        data=open(path,'rb').read()
        files.append({'path':rel,'size':len(data),'sha256':hashlib.sha256(data).hexdigest()})
manifest={
    'schemaVersion':1,
    'applicationId':'sirk-central',
    'product':'SIRK Central',
    'version':version,
    'runtime':'linux-x64',
    'files':files,
    'signature':{'algorithm':'ES256','keyId':'fixture','value':'fixture'}
}
with open(os.path.join(root,'update-manifest.json'),'w',encoding='utf-8') as f:
    json.dump(manifest,f,separators=(',',':'))
PY
  python3 - "$payload" "$package" <<'PY'
import os,sys,zipfile
root,out=sys.argv[1:]
with zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED) as z:
    for base,dirs,files in os.walk(root):
        dirs.sort(); files.sort()
        for name in files:
            path=os.path.join(base,name)
            z.write(path,os.path.relpath(path,root).replace(os.sep,'/'))
PY
  local size sha
  size="$(stat -c %s "$package")"
  sha="$(sha256sum "$package" | awk '{print tolower($1)}')"
  cat > "$BROKER_RESPONSE" <<JSON
{"applicationId":"sirk-central","version":"$version","runtime":"linux-x64","channel":"stable","size":$size,"sha256":"$sha","commit":"$commit","packagePath":"/var/lib/sirk/updates/$relative"}
JSON
}

run_update() {
  sudo env \
    PATH="$FAKE_BIN:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    INSTALL_ROOT="$TEST_INSTALL" \
    SOURCE_DIR="$TEST_INSTALL/source" \
    SECRETS_DIR="$TEST_INSTALL/secrets" \
    UPDATE_CACHE_DIR="$TEST_INSTALL/updates" \
    UPDATE_STATE_FILE="$TEST_INSTALL/current-release.json" \
    SIRK_UPDATE_HOST_TOKEN_FILE="$TEST_INSTALL/secrets/sirk-update-host-token" \
    SIRK_CENTRAL_LOCAL_URL="http://127.0.0.1:18080" \
    SIRK_TEST_BROKER_RESPONSE="$BROKER_RESPONSE" \
    bash "$REPO_ROOT/deploy/update.sh"
}

printf '=== success transaction ===\n'
create_package '0.1.1.100' "$SUCCESS_COMMIT" 0
run_update
grep -qx 'new-source-0.1.1.100' "$TEST_INSTALL/source/source-marker.txt"
grep -qx 'old-source' "$TEST_INSTALL/source.previous/source-marker.txt"
grep -qx "$SUCCESS_COMMIT" "$TEST_INSTALL/source/.sirk-release-commit"
jq -e --arg version '0.1.1.100' --arg commit "$SUCCESS_COMMIT" \
  '.applicationId == "sirk-central" and .version == $version and .commit == $commit and (.sha256 | test("^[0-9a-f]{64}$"))' \
  "$TEST_INSTALL/current-release.json" >/dev/null
[[ ! -d "$TEST_INSTALL/source/.git" ]]
grep -q "new-source-deploy 0.1.1.100 $SUCCESS_COMMIT" "$TEST_INSTALL/deployment-events.log"
printf 'SIRK_CENTRAL_SELF_UPDATE_COMMIT_OK\n'

printf '=== rollback transaction ===\n'
rm -rf "$TEST_INSTALL/source.previous"
mv "$TEST_INSTALL/source" "$TEST_INSTALL/source.previous-success"
mkdir -p "$TEST_INSTALL/source/deploy"
printf '%s\n' "$OLD_COMMIT" > "$TEST_INSTALL/source/.sirk-release-commit"
printf 'old-source\n' > "$TEST_INSTALL/source/source-marker.txt"
cat > "$TEST_INSTALL/source/deploy/upgrade-dotnet10-vps.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf 'old-source-redeploy %s\n' "${SIRK_RELEASE_COMMIT:-}" >> "${INSTALL_ROOT}/deployment-events.log"
SH
chmod 0700 "$TEST_INSTALL/source/deploy/upgrade-dotnet10-vps.sh"
cat > "$TEST_INSTALL/current-release.json" <<JSON
{"schemaVersion":1,"applicationId":"sirk-central","version":"0.1.1.1","commit":"$OLD_COMMIT","sha256":"$(printf 'a%.0s' {1..64})"}
JSON
create_package '0.1.1.101' "$FAIL_COMMIT" 1
set +e
run_update
code=$?
set -e
[[ "$code" -ne 0 ]] || { echo 'failing deployment unexpectedly succeeded' >&2; exit 1; }
grep -qx 'old-source' "$TEST_INSTALL/source/source-marker.txt"
grep -qx "$OLD_COMMIT" "$TEST_INSTALL/source/.sirk-release-commit"
jq -e --arg version '0.1.1.1' --arg commit "$OLD_COMMIT" '.version == $version and .commit == $commit' "$TEST_INSTALL/current-release.json" >/dev/null
[[ ! -d "$TEST_INSTALL/.source-failed-"* ]] || { echo 'failed source residue remains' >&2; exit 1; }
grep -q "new-source-deploy 0.1.1.101 $FAIL_COMMIT" "$TEST_INSTALL/deployment-events.log"
grep -q "old-source-redeploy $OLD_COMMIT" "$TEST_INSTALL/deployment-events.log"
printf 'SIRK_CENTRAL_SELF_UPDATE_ROLLBACK_OK\n'
printf 'SIRK_CENTRAL_SELF_UPDATE_TRANSACTION_E2E_OK\n'

run_real_signed_case() {
  local mode="$1" release_dir="$2"
  local metadata="$release_dir/release.json"
  [[ -s "$metadata" ]] || { echo 'real Central release metadata is missing' >&2; exit 81; }

  local application_id version runtime channel sha size commit package
  application_id="$(jq -r '.applicationId // empty' "$metadata")"
  version="$(jq -r '.version // empty' "$metadata")"
  runtime="$(jq -r '.runtime // empty' "$metadata")"
  channel="$(jq -r '.channel // empty' "$metadata")"
  sha="$(jq -r '.sha256 // empty' "$metadata" | tr '[:upper:]' '[:lower:]')"
  size="$(jq -r '.size // empty' "$metadata")"
  commit="$(jq -r '.commit // empty' "$metadata" | tr '[:upper:]' '[:lower:]')"
  package="$(jq -r '.packagePath // empty' "$metadata")"

  [[ "$application_id" == 'sirk-central' ]] || { echo 'real release is not sirk-central' >&2; exit 82; }
  [[ "$version" =~ ^0\.1\.1\.[0-9]+$ ]] || { echo 'real release version is invalid' >&2; exit 83; }
  [[ "$runtime" == 'linux-x64' && "$channel" == 'stable' ]] || { echo 'real release scope is invalid' >&2; exit 84; }
  [[ "$sha" =~ ^[0-9a-f]{64}$ && "$commit" =~ ^[0-9a-f]{40}$ ]] || { echo 'real release identity is invalid' >&2; exit 85; }
  [[ "$size" =~ ^[0-9]+$ && "$size" -gt 0 && -f "$package" ]] || { echo 'real release package is missing' >&2; exit 86; }
  [[ "$(stat -c %s "$package")" == "$size" ]] || { echo 'real release package size changed after cache export' >&2; exit 87; }
  [[ "$(sha256sum "$package" | awk '{print tolower($1)}')" == "$sha" ]] || { echo 'real release package hash changed after cache export' >&2; exit 88; }

  local install="$ROOT/real-$mode"
  local fake="$ROOT/real-$mode-bin"
  local response="$ROOT/real-$mode-broker.json"
  local relative="sirk-central/linux-x64/stable/$version/package.zip"
  mkdir -p "$install/source/deploy" "$install/secrets" "$install/updates/$(dirname "$relative")" "$fake"
  printf '%064d\n' 0 > "$install/secrets/sirk-update-host-token"
  printf '%s\n' "$OLD_COMMIT" > "$install/source/.sirk-release-commit"
  printf 'old-source\n' > "$install/source/source-marker.txt"
  cat > "$install/source/deploy/upgrade-dotnet10-vps.sh" <<'SH'
#!/usr/bin/env bash
exit 0
SH
  chmod 0700 "$install/source/deploy/upgrade-dotnet10-vps.sh"
  cat > "$install/current-release.json" <<JSON
{"schemaVersion":1,"applicationId":"sirk-central","version":"0.1.1.1","commit":"$OLD_COMMIT","sha256":"$(printf 'a%.0s' {1..64})"}
JSON
  cp "$package" "$install/updates/$relative"
  cat > "$response" <<JSON
{"applicationId":"sirk-central","version":"$version","runtime":"linux-x64","channel":"stable","size":$size,"sha256":"$sha","commit":"$commit","packagePath":"/var/lib/sirk/updates/$relative"}
JSON

  cat > "$fake/docker" <<'SH'
#!/usr/bin/env bash
exit 0
SH
  cat > "$fake/curl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
[[ "$1" == "--config" && -f "$2" ]] || exit 64
out="$(awk -F'"' '/^output = / {print $2; exit}' "$2")"
cp "$SIRK_TEST_BROKER_RESPONSE" "$out"
SH
  cat > "$fake/bash" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
script="${1:-}"
if [[ "$script" == */deploy/upgrade-dotnet10-vps.sh ]]; then
  printf 'deploy %s\n' "${SIRK_RELEASE_COMMIT:-}" >> "${INSTALL_ROOT}/real-deployment-events.log"
  if [[ -n "${SIRK_TEST_FAIL_COMMIT:-}" && "${SIRK_RELEASE_COMMIT:-}" == "$SIRK_TEST_FAIL_COMMIT" ]]; then
    exit 73
  fi
  exit 0
fi
exec /usr/bin/bash "$@"
SH
  chmod 0700 "$fake/docker" "$fake/curl" "$fake/bash"

  local fail_commit=""
  [[ "$mode" != 'rollback' ]] || fail_commit="$commit"
  set +e
  env \
    PATH="$fake:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    INSTALL_ROOT="$install" \
    SOURCE_DIR="$install/source" \
    SECRETS_DIR="$install/secrets" \
    UPDATE_CACHE_DIR="$install/updates" \
    UPDATE_STATE_FILE="$install/current-release.json" \
    SIRK_UPDATE_HOST_TOKEN_FILE="$install/secrets/sirk-update-host-token" \
    SIRK_CENTRAL_LOCAL_URL="http://127.0.0.1:18080" \
    SIRK_TEST_BROKER_RESPONSE="$response" \
    SIRK_TEST_FAIL_COMMIT="$fail_commit" \
    /usr/bin/bash "$REPO_ROOT/deploy/update.sh"
  local code=$?
  set -e

  if [[ "$mode" == 'success' ]]; then
    [[ "$code" -eq 0 ]] || { echo 'real signed Central update failed' >&2; exit 89; }
    grep -qx "$commit" "$install/source/.sirk-release-commit"
    grep -qx 'old-source' "$install/source.previous/source-marker.txt"
    jq -e --arg version "$version" --arg commit "$commit" --arg sha "$sha" \
      '.applicationId == "sirk-central" and .version == $version and .commit == $commit and .sha256 == $sha' \
      "$install/current-release.json" >/dev/null
    [[ ! -d "$install/source/.git" ]]
    grep -q "deploy $commit" "$install/real-deployment-events.log"
    printf 'SIRK_CENTRAL_REAL_SIGNED_SELF_UPDATE_OK version=%s\n' "$version"
    return
  fi

  [[ "$code" -ne 0 ]] || { echo 'real signed rollback fixture unexpectedly succeeded' >&2; exit 90; }
  grep -qx 'old-source' "$install/source/source-marker.txt"
  grep -qx "$OLD_COMMIT" "$install/source/.sirk-release-commit"
  jq -e --arg commit "$OLD_COMMIT" '.version == "0.1.1.1" and .commit == $commit' "$install/current-release.json" >/dev/null
  grep -q "deploy $commit" "$install/real-deployment-events.log"
  grep -q "deploy $OLD_COMMIT" "$install/real-deployment-events.log"
  printf 'SIRK_CENTRAL_REAL_SIGNED_SELF_UPDATE_ROLLBACK_OK version=%s\n' "$version"
}

if [[ -n "${SIRK_REAL_CENTRAL_RELEASE_DIR:-}" ]]; then
  printf '=== real signed stable Central package transaction ===\n'
  run_real_signed_case success "$SIRK_REAL_CENTRAL_RELEASE_DIR"
  run_real_signed_case rollback "$SIRK_REAL_CENTRAL_RELEASE_DIR"
  printf 'SIRK_CENTRAL_REAL_SIGNED_SELF_UPDATE_TRANSACTION_E2E_OK\n'
fi
