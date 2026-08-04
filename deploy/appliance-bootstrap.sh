#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

INSTALL_DIR="${SIRK_INSTALL_DIR:-/opt/sirk-central}"
REPO_URL="${SIRK_REPO_URL:-https://github.com/Eris92/SIRK-Central.git}"
REPO_REF="${SIRK_REPO_REF:-main}"
RAW_BASE="${SIRK_RAW_BASE:-https://raw.githubusercontent.com/Eris92/SIRK-Central/${REPO_REF}/deploy}"
EXPECTED_REMOTE="${SIRK_EXPECTED_REMOTE:-https://github.com/Eris92/SIRK-Central}"

log() { printf '[SIRK] %s\n' "$*"; }
die() { printf '[SIRK] ERROR: %s\n' "$*" >&2; exit 1; }

[[ "$(id -u)" -eq 0 ]] || die "run through sudo or as root"
command -v curl >/dev/null 2>&1 || die "curl is required"
[[ "$REPO_URL" == https://* ]] || die "SIRK_REPO_URL must use HTTPS"
[[ "$RAW_BASE" == https://* ]] || die "SIRK_RAW_BASE must use HTTPS"
[[ "$REPO_REF" =~ ^[A-Za-z0-9._/-]{1,128}$ ]] || die "SIRK_REPO_REF is invalid"
[[ "$REPO_REF" != *..* ]] || die "SIRK_REPO_REF is invalid"

fetch_and_exec() {
    local script_name="$1"
    local source="${RAW_BASE}/${script_name}"
    local temporary status=0
    [[ "$script_name" =~ ^[a-z0-9-]+\.sh$ ]] || die "bootstrap child script name is invalid"
    temporary="$(mktemp /tmp/sirk-central-bootstrap.XXXXXX)"
    if ! curl -fsSL --proto '=https' --tlsv1.2 "$source" -o "$temporary"; then
        rm -f -- "$temporary"
        die "unable to download ${script_name}"
    fi
    chmod 0700 "$temporary"
    bash "$temporary" || status=$?
    rm -f -- "$temporary"
    return "$status"
}

if [[ ! -e "$INSTALL_DIR" ]]; then
    log "No existing installation detected; starting clean appliance installation"
    export SIRK_REPO_URL="$REPO_URL"
    export SIRK_REPO_REF="$REPO_REF"
    export SIRK_INSTALL_DIR="$INSTALL_DIR"
    fetch_and_exec appliance-install.sh
    exit 0
fi

[[ -d "$INSTALL_DIR" ]] || die "$INSTALL_DIR exists but is not a directory"
[[ -d "$INSTALL_DIR/.git" ]] || die "$INSTALL_DIR exists but is not a SIRK Central Git installation"
[[ -f "$INSTALL_DIR/.env" ]] || die "$INSTALL_DIR exists but production .env is missing"
command -v git >/dev/null 2>&1 || die "git is required for an existing installation"

cd "$INSTALL_DIR"
REMOTE_URL="$(git remote get-url origin)"
case "$REMOTE_URL" in
    "$EXPECTED_REMOTE"|"${EXPECTED_REMOTE}.git") ;;
    *) die "unexpected Git origin: $REMOTE_URL" ;;
esac

LOCAL_COMMIT="$(git rev-parse HEAD)"
TARGET_COMMIT="$(git ls-remote --exit-code "$REPO_URL" "refs/heads/${REPO_REF}" | awk 'NR == 1 { print $1 }')"
[[ "$LOCAL_COMMIT" =~ ^[0-9a-f]{40}$ ]] || die "local commit is invalid"
[[ "$TARGET_COMMIT" =~ ^[0-9a-f]{40}$ ]] || die "remote commit is invalid"

APPLIANCE_READY=0
if [[ -f docker-compose.appliance.yml && -f updater/appliance-restore-server.js && -f deploy/appliance-web-update.sh ]]; then
    APPLIANCE_READY=1
fi

if [[ "$APPLIANCE_READY" == "1" && "$LOCAL_COMMIT" == "$TARGET_COMMIT" ]]; then
    log "SIRK Central appliance is already current"
    printf 'Commit: %s\n' "$LOCAL_COMMIT"
    if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
        docker compose -f docker-compose.yml -f docker-compose.appliance.yml --profile auth ps || true
    fi
    exit 0
fi

if [[ "$APPLIANCE_READY" == "1" ]]; then
    log "Existing appliance requires an update; starting transactional appliance reconciliation"
else
    log "Legacy SIRK Central detected; starting appliance migration"
fi

export SIRK_INSTALL_DIR="$INSTALL_DIR"
export SIRK_REPO_REF="$REPO_REF"
export SIRK_EXPECTED_REMOTE="$EXPECTED_REMOTE"
fetch_and_exec appliance-migrate.sh
