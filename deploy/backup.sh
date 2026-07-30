#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

INSTALL_DIR="${SIRK_INSTALL_DIR:-/opt/sirk-central}"
BACKUP_ROOT="${SIRK_BACKUP_ROOT:-/var/backups/sirk-central}"
RETENTION_DAYS="${SIRK_BACKUP_RETENTION_DAYS:-30}"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
TARGET="${BACKUP_ROOT}/${TIMESTAMP}"
ARCHIVE="${BACKUP_ROOT}/sirk-central-${TIMESTAMP}.tar.gz"

[[ "$(id -u)" -eq 0 ]] || { echo "Run as root." >&2; exit 1; }
[[ -d "${INSTALL_DIR}" ]] || { echo "Missing ${INSTALL_DIR}." >&2; exit 1; }
[[ -f "${INSTALL_DIR}/.env" ]] || { echo "Missing production .env." >&2; exit 1; }

mkdir -p "${TARGET}" "${BACKUP_ROOT}"
chmod 0700 "${BACKUP_ROOT}" "${TARGET}"

cd "${INSTALL_DIR}"
cp -a .env "${TARGET}/.env"
git rev-parse HEAD > "${TARGET}/commit.txt"
git status --porcelain=v1 > "${TARGET}/git-status.txt"
docker compose --profile auth config > "${TARGET}/compose.yml"
docker compose --profile auth ps --format json > "${TARGET}/compose-ps.json" 2>/dev/null || docker compose --profile auth ps > "${TARGET}/compose-ps.txt"

if docker compose --profile auth ps --services | grep -qx central; then
  docker compose --profile auth cp central:/var/lib/sirk-central "${TARGET}/data"
elif [[ -d "${INSTALL_DIR}/data" ]]; then
  cp -a "${INSTALL_DIR}/data" "${TARGET}/data"
else
  echo "Central data directory not found." >&2
  exit 1
fi

find "${TARGET}" -type d -exec chmod 0700 {} +
find "${TARGET}" -type f -exec chmod 0600 {} +

tar -C "${BACKUP_ROOT}" -czf "${ARCHIVE}" "${TIMESTAMP}"
sha256sum "${ARCHIVE}" > "${ARCHIVE}.sha256"
chmod 0600 "${ARCHIVE}" "${ARCHIVE}.sha256"
rm -rf "${TARGET}"

if [[ -n "${SIRK_BACKUP_AGE_RECIPIENT:-}" ]]; then
  command -v age >/dev/null 2>&1 || { echo "age is required for encrypted backups." >&2; exit 1; }
  age -r "${SIRK_BACKUP_AGE_RECIPIENT}" -o "${ARCHIVE}.age" "${ARCHIVE}"
  sha256sum "${ARCHIVE}.age" > "${ARCHIVE}.age.sha256"
  chmod 0600 "${ARCHIVE}.age" "${ARCHIVE}.age.sha256"
  rm -f "${ARCHIVE}" "${ARCHIVE}.sha256"
fi

find "${BACKUP_ROOT}" -maxdepth 1 -type f -name 'sirk-central-*' -mtime "+${RETENTION_DAYS}" -delete
printf 'Backup completed: %s\n' "${ARCHIVE}${SIRK_BACKUP_AGE_RECIPIENT:+.age}"
