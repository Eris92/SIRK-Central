#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

INSTALL_ROOT="${INSTALL_ROOT:-/opt/sirk-central}"
SOURCE_DIR="${SOURCE_DIR:-${INSTALL_ROOT}/source}"
SECRETS_DIR="${SECRETS_DIR:-${INSTALL_ROOT}/secrets}"
UPDATE_CACHE_DIR="${UPDATE_CACHE_DIR:-${INSTALL_ROOT}/updates}"
STATE_FILE="${UPDATE_STATE_FILE:-${INSTALL_ROOT}/current-release.json}"
PREVIOUS_SOURCE_DIR="${INSTALL_ROOT}/source.previous"
CENTRAL_LOCAL_URL="${SIRK_CENTRAL_LOCAL_URL:-http://127.0.0.1:8080}"
HOST_TOKEN_FILE="${SIRK_UPDATE_HOST_TOKEN_FILE:-${SECRETS_DIR}/sirk-update-host-token}"
LOCK_FILE="${INSTALL_ROOT}/update.lock"

log() { printf '[SIRK UPDATE] %s\n' "$*"; }
die() { printf '[SIRK UPDATE] ERROR: %s\n' "$*" >&2; exit 1; }

[[ "$(id -u)" -eq 0 ]] || die "run this script through sudo or as root"
for command in curl jq python3 sha256sum stat docker flock; do
    command -v "$command" >/dev/null 2>&1 || die "missing command: $command"
done
[[ -d "$SOURCE_DIR" ]] || die "Central source directory is missing: $SOURCE_DIR"
[[ -s "$HOST_TOKEN_FILE" ]] || die "host update control token is missing"
[[ -d "$UPDATE_CACHE_DIR" ]] || die "Central update cache is missing: $UPDATE_CACHE_DIR"
[[ -x "$SOURCE_DIR/deploy/upgrade-dotnet10-vps.sh" ]] || chmod 0700 "$SOURCE_DIR/deploy/upgrade-dotnet10-vps.sh"
[[ -s "$SOURCE_DIR/deploy/upgrade-dotnet10-vps.sh" ]] || die "current deployment helper is missing"

exec 9>"$LOCK_FILE"
flock -n 9 || die "another Central update is already running"
chmod 0600 "$LOCK_FILE"

current_commit() {
    if [[ -s "$SOURCE_DIR/.sirk-release-commit" ]]; then
        tr -d '\r\n' < "$SOURCE_DIR/.sirk-release-commit"
        return
    fi
    if [[ -d "$SOURCE_DIR/.git" ]] && command -v git >/dev/null 2>&1; then
        git -C "$SOURCE_DIR" rev-parse HEAD 2>/dev/null || true
    fi
}

CURRENT_COMMIT="$(current_commit)"
[[ -z "$CURRENT_COMMIT" || "$CURRENT_COMMIT" =~ ^[0-9a-f]{40}$ ]] ||
    die "current Central source commit marker is invalid"
CURRENT_VERSION=""
if [[ -s "$STATE_FILE" ]]; then
    CURRENT_VERSION="$(jq -r '.version // empty' "$STATE_FILE")"
fi

HOST_TOKEN="$(tr -d '\r\n' < "$HOST_TOKEN_FILE")"
[[ ${#HOST_TOKEN} -ge 32 && ${#HOST_TOKEN} -le 512 ]] || die "host update control token is invalid"
CURL_CONFIG="$(mktemp /tmp/sirk-central-update-curl.XXXXXX)"
RESPONSE_FILE="$(mktemp /tmp/sirk-central-update-response.XXXXXX.json)"
STAGING_ROOT="$(mktemp -d "${INSTALL_ROOT}/.update-source.XXXXXX")"
BACKUP_SOURCE="${INSTALL_ROOT}/.source-backup-$(date -u +%Y%m%dT%H%M%SZ)-$$"
FAILED_SOURCE="${INSTALL_ROOT}/.source-failed-$$"
cleanup() {
    rm -f "$CURL_CONFIG" "$RESPONSE_FILE"
    [[ ! -d "$STAGING_ROOT" ]] || rm -rf --one-file-system "$STAGING_ROOT"
    unset HOST_TOKEN || true
}
trap cleanup EXIT

cat > "$CURL_CONFIG" <<EOF
silent
show-error
fail
max-time = 900
request = "POST"
url = "${CENTRAL_LOCAL_URL}/api/internal/v1/update/central/prepare"
header = "Authorization: Bearer ${HOST_TOKEN}"
header = "Accept: application/json"
output = "${RESPONSE_FILE}"
EOF
chmod 0600 "$CURL_CONFIG"

log "requesting a verified SIRK Central release from the local Central broker"
curl --config "$CURL_CONFIG"
unset HOST_TOKEN
rm -f "$CURL_CONFIG"

APPLICATION_ID="$(jq -r '.applicationId // empty' "$RESPONSE_FILE")"
VERSION="$(jq -r '.version // empty' "$RESPONSE_FILE")"
RUNTIME="$(jq -r '.runtime // empty' "$RESPONSE_FILE")"
CHANNEL="$(jq -r '.channel // empty' "$RESPONSE_FILE")"
SIZE="$(jq -r '.size // empty' "$RESPONSE_FILE")"
SHA256="$(jq -r '.sha256 // empty' "$RESPONSE_FILE" | tr '[:upper:]' '[:lower:]')"
COMMIT="$(jq -r '.commit // empty' "$RESPONSE_FILE" | tr '[:upper:]' '[:lower:]')"
CONTAINER_PACKAGE="$(jq -r '.packagePath // empty' "$RESPONSE_FILE")"

[[ "$APPLICATION_ID" == "sirk-central" ]] || die "broker returned a different application"
[[ "$VERSION" =~ ^0\.1\.1\.[0-9]+$ ]] || die "broker returned a non-canonical pre-1.0 version"
[[ "$RUNTIME" == "linux-x64" ]] || die "broker returned an unsupported runtime"
[[ "$CHANNEL" == "stable" ]] || die "broker returned an unsupported channel"
[[ "$SIZE" =~ ^[0-9]+$ && "$SIZE" -gt 0 && "$SIZE" -le 536870912 ]] || die "broker returned an invalid package size"
[[ "$SHA256" =~ ^[0-9a-f]{64}$ ]] || die "broker returned an invalid SHA256"
[[ "$COMMIT" =~ ^[0-9a-f]{40}$ ]] || die "broker returned an invalid commit"
case "$CONTAINER_PACKAGE" in
    /var/lib/sirk/updates/*) ;;
    *) die "broker returned a package outside the Central update cache" ;;
esac
RELATIVE_PACKAGE="${CONTAINER_PACKAGE#/var/lib/sirk/updates/}"
[[ "$RELATIVE_PACKAGE" != *".."* && "$RELATIVE_PACKAGE" != /* ]] || die "broker returned an unsafe cache path"
PACKAGE_PATH="${UPDATE_CACHE_DIR}/${RELATIVE_PACKAGE}"
[[ -f "$PACKAGE_PATH" ]] || die "verified cache package is missing on the host"
[[ "$(stat -c %s "$PACKAGE_PATH")" == "$SIZE" ]] || die "cached package size changed after broker verification"
ACTUAL_SHA="$(sha256sum "$PACKAGE_PATH" | awk '{print tolower($1)}')"
[[ "$ACTUAL_SHA" == "$SHA256" ]] || die "cached package SHA256 changed after broker verification"

if [[ "$CURRENT_VERSION" == "$VERSION" && "$CURRENT_COMMIT" == "$COMMIT" ]]; then
    log "Central is already at ${VERSION} (${COMMIT}); no update is required"
    exit 0
fi

log "extracting verified ${VERSION} cache payload without repository access"
python3 - "$PACKAGE_PATH" "$STAGING_ROOT" "$VERSION" "$RUNTIME" <<'PY'
import hashlib,json,pathlib,re,stat,sys,zipfile
archive=pathlib.Path(sys.argv[1])
root=pathlib.Path(sys.argv[2]).resolve()
expected_version=sys.argv[3]
expected_runtime=sys.argv[4]
with zipfile.ZipFile(archive) as z:
    infos=z.infolist()
    if not 1 <= len(infos) <= 8192:
        raise SystemExit('invalid archive entry count')
    entries={}
    for info in infos:
        name=info.filename.replace('\\','/')
        parts=pathlib.PurePosixPath(name).parts
        if not name or name.startswith('/') or '..' in parts or name in entries:
            raise SystemExit('unsafe or duplicate archive entry: '+name)
        mode=(info.external_attr >> 16) & 0xFFFF
        if stat.S_ISLNK(mode):
            raise SystemExit('symlink archive entry is forbidden: '+name)
        target=(root/pathlib.PurePosixPath(name)).resolve()
        if root != target and root not in target.parents:
            raise SystemExit('archive entry escaped staging root')
        entries[name]=info

    manifest_info=entries.get('update-manifest.json')
    if manifest_info is None or not 0 < manifest_info.file_size <= 131072:
        raise SystemExit('signed Central package manifest is missing')
    with z.open(manifest_info) as stream:
        manifest=json.load(stream)
    if manifest.get('schemaVersion') != 1 or manifest.get('applicationId') != 'sirk-central' or manifest.get('product') != 'SIRK Central' or manifest.get('version') != expected_version or manifest.get('runtime') != expected_runtime:
        raise SystemExit('signed Central package manifest scope is invalid')
    signature=manifest.get('signature') or {}
    if signature.get('algorithm') != 'ES256' or not signature.get('keyId') or not signature.get('value'):
        raise SystemExit('signed Central package manifest signature metadata is invalid')
    files=manifest.get('files')
    if not isinstance(files,list) or not 1 <= len(files) <= 8191:
        raise SystemExit('signed Central package manifest file list is invalid')

    declared={}
    for item in files:
        name=str(item.get('path') or '').replace('\\','/')
        parts=pathlib.PurePosixPath(name).parts
        sha=str(item.get('sha256') or '').lower()
        size=item.get('size')
        if not name or name.startswith('/') or '..' in parts or name in declared or not isinstance(size,int) or size < 0 or not re.fullmatch(r'[0-9a-f]{64}',sha):
            raise SystemExit('signed Central package manifest contains an invalid file entry: '+name)
        info=entries.get(name)
        if info is None or info.file_size != size:
            raise SystemExit('signed Central package file size/path mismatch: '+name)
        with z.open(info) as stream:
            actual=hashlib.sha256(stream.read()).hexdigest()
        if actual != sha:
            raise SystemExit('signed Central package file hash mismatch: '+name)
        declared[name]=item

    actual_payload=set(entries)-{'update-manifest.json'}
    if actual_payload != set(declared):
        extra=sorted(actual_payload-set(declared))
        missing=sorted(set(declared)-actual_payload)
        raise SystemExit('signed Central package exact file set mismatch; extra='+','.join(extra)+' missing='+','.join(missing))
    z.extractall(root)
PY

for required in \
    Dockerfile.dotnet10 \
    Directory.Build.props \
    global.json \
    src/Sirk.Central/Sirk.Central.csproj \
    deploy/upgrade-dotnet10-vps.sh \
    deploy/dotnet10/Caddyfile \
    website/index.html \
    update-manifest.json; do
    [[ -f "$STAGING_ROOT/$required" ]] || die "verified release payload is incomplete: $required"
done
[[ ! -d "$STAGING_ROOT/.git" ]] || die "runtime release package must not contain repository metadata"
printf '%s\n' "$COMMIT" > "$STAGING_ROOT/.sirk-release-commit"
chmod 0600 "$STAGING_ROOT/.sirk-release-commit"
chmod 0700 "$STAGING_ROOT/deploy/upgrade-dotnet10-vps.sh"

rollback_source() {
    local original_code="$1"
    trap - ERR
    log "deployment failed; restoring the previous verified/deployed source"
    if [[ -d "$SOURCE_DIR" ]]; then
        rm -rf --one-file-system "$FAILED_SOURCE" 2>/dev/null || true
        mv "$SOURCE_DIR" "$FAILED_SOURCE" || true
    fi
    if [[ -d "$BACKUP_SOURCE" ]]; then
        mv "$BACKUP_SOURCE" "$SOURCE_DIR"
        if [[ "$CURRENT_COMMIT" =~ ^[0-9a-f]{40}$ && -s "$SOURCE_DIR/deploy/upgrade-dotnet10-vps.sh" ]]; then
            SIRK_SOURCE_READY=1 \
            SIRK_RELEASE_COMMIT="$CURRENT_COMMIT" \
            SIRK_UPDATE_BUSINESS=0 \
            INSTALL_ROOT="$INSTALL_ROOT" \
            SOURCE_DIR="$SOURCE_DIR" \
            UPDATE_CACHE_DIR="$UPDATE_CACHE_DIR" \
            bash "$SOURCE_DIR/deploy/upgrade-dotnet10-vps.sh" || true
        fi
    fi
    rm -rf --one-file-system "$FAILED_SOURCE" 2>/dev/null || true
    exit "$original_code"
}
trap 'rollback_source $?' ERR

mv "$SOURCE_DIR" "$BACKUP_SOURCE"
mv "$STAGING_ROOT" "$SOURCE_DIR"
STAGING_ROOT=""

log "deploying ${VERSION} from the verified local cache"
SIRK_SOURCE_READY=1 \
SIRK_RELEASE_COMMIT="$COMMIT" \
SIRK_UPDATE_BUSINESS=0 \
INSTALL_ROOT="$INSTALL_ROOT" \
SOURCE_DIR="$SOURCE_DIR" \
UPDATE_CACHE_DIR="$UPDATE_CACHE_DIR" \
bash "$SOURCE_DIR/deploy/upgrade-dotnet10-vps.sh"

trap - ERR
python3 - "$STATE_FILE" "$VERSION" "$COMMIT" "$SHA256" <<'PY'
import datetime,json,os,sys,tempfile
path,version,commit,sha=sys.argv[1:]
data={
  'schemaVersion':1,
  'applicationId':'sirk-central',
  'version':version,
  'commit':commit,
  'sha256':sha,
  'updatedAtUtc':datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00','Z')
}
os.makedirs(os.path.dirname(path),exist_ok=True)
fd,tmp=tempfile.mkstemp(dir=os.path.dirname(path),prefix='.current-release-',text=True)
with os.fdopen(fd,'w') as f:
    json.dump(data,f,indent=2);f.write('\n');f.flush();os.fsync(f.fileno())
os.chmod(tmp,0o600)
os.replace(tmp,path)
PY

rm -rf --one-file-system "$PREVIOUS_SOURCE_DIR" 2>/dev/null || true
mv "$BACKUP_SOURCE" "$PREVIOUS_SOURCE_DIR"
rm -f "$RESPONSE_FILE"
log "Central update completed: ${VERSION} (${COMMIT})"
