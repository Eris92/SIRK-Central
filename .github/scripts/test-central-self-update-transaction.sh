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
  printf '{"schemaVersion":1,"applicationId":"sirk-central","product":"SIRK Central","version":"%s","runtime":"linux-x64","files":[],"signature":{"algorithm":"ES256","keyId":"fixture","value":"fixture"}}\n' "$version" > "$payload/update-manifest.json"
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
