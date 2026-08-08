#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

INSTALL_ROOT="${INSTALL_ROOT:-/opt/sirk-central}"
QUEUE_DIR="${SIRK_WEB_UPDATE_QUEUE_DIR:-${INSTALL_ROOT}/data/security/host-update}"
REQUEST_FILE="${QUEUE_DIR}/request.json"
WORK_FILE="${QUEUE_DIR}/request.running.json"
STATUS_FILE="${QUEUE_DIR}/status.json"

write_status() {
    local state="$1" running="$2" message="$3" finished="${4:-}"
    local temporary
    temporary="$(mktemp "${QUEUE_DIR}/.status.XXXXXX")"
    jq -n \
        --arg state "$state" --argjson running "$running" \
        --arg jobId "$JOB_ID" --arg channel "$CHANNEL" \
        --arg startedAtUtc "$STARTED_AT" --arg finishedAtUtc "$finished" \
        --arg message "$message" \
        '{state:$state,running:$running,jobId:$jobId,channel:$channel,commit:null,
          startedAtUtc:$startedAtUtc,finishedAtUtc:(if $finishedAtUtc=="" then null else $finishedAtUtc end),message:$message}' \
        > "$temporary"
    chmod 0644 "$temporary"
    mv -f "$temporary" "$STATUS_FILE"
}

[[ "$(id -u)" -eq 0 ]] || { echo "worker must run as root" >&2; exit 1; }
[[ -f "$REQUEST_FILE" ]] || exit 0
mkdir -p "$QUEUE_DIR"
mv "$REQUEST_FILE" "$WORK_FILE"
JOB_ID="$(jq -r '.jobId // empty' "$WORK_FILE")"
CHANNEL="$(jq -r '.channel // empty' "$WORK_FILE")"
[[ "$JOB_ID" =~ ^upd-[0-9a-f]{32}$ ]] || { rm -f "$WORK_FILE"; exit 1; }
[[ "$CHANNEL" == "stable" || "$CHANNEL" == "preview" ]] || { rm -f "$WORK_FILE"; exit 1; }
STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
write_status running true "SIRK Central update is running."

set +e
SIRK_UPDATE_CHANNEL="$CHANNEL" bash "${INSTALL_ROOT}/source/deploy/update.sh"
code=$?
set -e
FINISHED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
if [[ "$code" -eq 0 ]]; then
    write_status completed false "SIRK Central update completed." "$FINISHED_AT"
else
    write_status failed false "SIRK Central update failed. Check the host update journal." "$FINISHED_AT"
fi
rm -f "$WORK_FILE"
exit "$code"
