#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

INSTALL_DIR="${SIRK_INSTALL_DIR:-/opt/sirk-central}"
ARCHIVE="${1:-}"
CONFIRM="${SIRK_RESTORE_CONFIRM:-}"
WORK_DIR=""

cleanup() { [[ -n "${WORK_DIR}" && -d "${WORK_DIR}" ]] && rm -rf "${WORK_DIR}"; }
trap cleanup EXIT

[[ "$(id -u)" -eq 0 ]] || { echo "Run as root." >&2; exit 1; }
[[ -n "${ARCHIVE}" && -f "${ARCHIVE}" ]] || { echo "Usage: sudo SIRK_RESTORE_CONFIRM='RESTORE SIRK CENTRAL' $0 <archive.tar.gz|archive.tar.gz.age>" >&2; exit 1; }
[[ "${CONFIRM}" == "RESTORE SIRK CENTRAL" ]] || { echo "Set SIRK_RESTORE_CONFIRM='RESTORE SIRK CENTRAL'." >&2; exit 1; }
[[ -d "${INSTALL_DIR}/.git" ]] || { echo "Missing Git installation in ${INSTALL_DIR}." >&2; exit 1; }

WORK_DIR="$(mktemp -d /var/tmp/sirk-restore-XXXXXX)"
chmod 0700 "${WORK_DIR}"
SOURCE="${ARCHIVE}"

if [[ "${ARCHIVE}" == *.age ]]; then
  command -v age >/dev/null 2>&1 || { echo "age is required." >&2; exit 1; }
  : "${SIRK_BACKUP_AGE_IDENTITY:?Set SIRK_BACKUP_AGE_IDENTITY to the age identity file}"
  SOURCE="${WORK_DIR}/backup.tar.gz"
  age -d -i "${SIRK_BACKUP_AGE_IDENTITY}" -o "${SOURCE}" "${ARCHIVE}"
fi

if [[ -f "${ARCHIVE}.sha256" ]]; then
  (cd "$(dirname "${ARCHIVE}")" && sha256sum -c "$(basename "${ARCHIVE}.sha256")")
fi

tar -C "${WORK_DIR}" -xzf "${SOURCE}"
BACKUP_DIR="$(find "${WORK_DIR}" -mindepth 1 -maxdepth 1 -type d | head -n1)"
[[ -n "${BACKUP_DIR}" && -f "${BACKUP_DIR}/commit.txt" && -f "${BACKUP_DIR}/.env" && -d "${BACKUP_DIR}/data" ]] || { echo "Backup structure is invalid." >&2; exit 1; }

cd "${INSTALL_DIR}"
CURRENT_BACKUP="/var/backups/sirk-central/pre-restore-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "${CURRENT_BACKUP}"
chmod 0700 "${CURRENT_BACKUP}"
cp -a .env "${CURRENT_BACKUP}/.env"
git rev-parse HEAD > "${CURRENT_BACKUP}/commit.txt"
docker compose --profile auth cp central:/var/lib/sirk-central "${CURRENT_BACKUP}/data" 2>/dev/null || true

docker compose --profile auth stop central auth updater || true
cp -a "${BACKUP_DIR}/.env" .env
chmod 0600 .env
TARGET_COMMIT="$(tr -d '[:space:]' < "${BACKUP_DIR}/commit.txt")"
git fetch --prune origin
git reset --hard "${TARGET_COMMIT}"

docker compose --profile auth rm -f central auth updater || true
docker compose --profile auth up -d --build central auth caddy
sleep 3
docker compose --profile auth cp "${BACKUP_DIR}/data/." central:/var/lib/sirk-central
docker compose --profile auth restart central auth

for _ in $(seq 1 60); do
  if curl -fsS --max-time 5 http://127.0.0.1:8080/healthz >/dev/null 2>&1 || curl -fsS --max-time 5 "${SIRK_PUBLIC_ORIGIN:-https://central.sirkportal.com}/healthz" >/dev/null 2>&1; then
    echo "Restore completed from commit ${TARGET_COMMIT}."
    exit 0
  fi
  sleep 2
done

echo "Restore completed but health check failed. Pre-restore backup: ${CURRENT_BACKUP}" >&2
exit 1
