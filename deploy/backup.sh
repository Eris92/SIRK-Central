#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

INSTALL_DIR="${SIRK_INSTALL_DIR:-/opt/sirk-central}"
BACKUP_ROOT="${SIRK_BACKUP_ROOT:-/var/backups/sirk-central}"
RETENTION_DAYS="${SIRK_BACKUP_RETENTION_DAYS:-30}"
REQUIRE_ENCRYPTION="${SIRK_BACKUP_REQUIRE_ENCRYPTION:-auto}"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
TARGET="${BACKUP_ROOT}/${TIMESTAMP}"
ARCHIVE="${BACKUP_ROOT}/sirk-central-${TIMESTAMP}.tar.gz"
COMPOSE=(docker compose -f docker-compose.yml -f docker-compose.portal-runtime.yml --profile auth)

cleanup() {
  [[ -d "${TARGET}" ]] && rm -rf -- "${TARGET}"
  [[ -f "${ARCHIVE}.partial" ]] && rm -f -- "${ARCHIVE}.partial"
  [[ -f "${ARCHIVE}.age.partial" ]] && rm -f -- "${ARCHIVE}.age.partial"
}
trap cleanup EXIT

[[ "$(id -u)" -eq 0 ]] || { echo "Run as root." >&2; exit 1; }
[[ -d "${INSTALL_DIR}/.git" ]] || { echo "Missing Git installation in ${INSTALL_DIR}." >&2; exit 1; }
[[ -f "${INSTALL_DIR}/.env" ]] || { echo "Missing production .env." >&2; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "python3 is required." >&2; exit 1; }
command -v sha256sum >/dev/null 2>&1 || { echo "sha256sum is required." >&2; exit 1; }
[[ "${RETENTION_DAYS}" =~ ^[0-9]+$ ]] || { echo "SIRK_BACKUP_RETENTION_DAYS must be an integer." >&2; exit 1; }
[[ "${REQUIRE_ENCRYPTION}" =~ ^(auto|true|false)$ ]] || { echo "SIRK_BACKUP_REQUIRE_ENCRYPTION must be auto, true or false." >&2; exit 1; }

if [[ "${REQUIRE_ENCRYPTION}" == "auto" ]]; then
  if grep -Eq '^[[:space:]]*NODE_ENV[[:space:]]*=[[:space:]]*["'"']?production["'"']?[[:space:]]*$' "${INSTALL_DIR}/.env"; then
    REQUIRE_ENCRYPTION=true
  else
    REQUIRE_ENCRYPTION=false
  fi
fi
if [[ "${REQUIRE_ENCRYPTION}" == "true" && -z "${SIRK_BACKUP_AGE_RECIPIENT:-}" ]]; then
  echo "Encrypted offline backup is required. Set SIRK_BACKUP_AGE_RECIPIENT. Use SIRK_BACKUP_REQUIRE_ENCRYPTION=false only for an explicitly accepted non-production exception." >&2
  exit 1
fi

mkdir -p "${TARGET}" "${BACKUP_ROOT}"
chmod 0700 "${BACKUP_ROOT}" "${TARGET}"

cd "${INSTALL_DIR}"
cp --preserve=mode,timestamps .env "${TARGET}/.env"
git rev-parse HEAD > "${TARGET}/commit.txt"
git status --porcelain=v1 > "${TARGET}/git-status.txt"
"${COMPOSE[@]}" config > "${TARGET}/compose.yml"
"${COMPOSE[@]}" ps --format json > "${TARGET}/compose-ps.json" 2>/dev/null || "${COMPOSE[@]}" ps > "${TARGET}/compose-ps.txt"

if "${COMPOSE[@]}" ps --services | grep -qx central; then
  "${COMPOSE[@]}" cp central:/var/lib/sirk-central "${TARGET}/data"
elif [[ -d "${INSTALL_DIR}/data" ]]; then
  cp -a -- "${INSTALL_DIR}/data" "${TARGET}/data"
else
  echo "Central data directory not found." >&2
  exit 1
fi

find "${TARGET}" -type d -exec chmod 0700 {} +
find "${TARGET}" -type f -exec chmod 0600 {} +

tar --format=pax -C "${BACKUP_ROOT}" -czf "${ARCHIVE}.partial" "${TIMESTAMP}"
mv -- "${ARCHIVE}.partial" "${ARCHIVE}"
chmod 0600 "${ARCHIVE}"
python3 "${INSTALL_DIR}/scripts/validate-backup-archive.py" "${ARCHIVE}" >/dev/null
(
  cd "${BACKUP_ROOT}"
  sha256sum "$(basename "${ARCHIVE}")" > "$(basename "${ARCHIVE}").sha256"
)
chmod 0600 "${ARCHIVE}.sha256"
rm -rf -- "${TARGET}"

OUTPUT="${ARCHIVE}"
if [[ -n "${SIRK_BACKUP_AGE_RECIPIENT:-}" ]]; then
  command -v age >/dev/null 2>&1 || { echo "age is required for encrypted backups." >&2; exit 1; }
  ENCRYPTED="${ARCHIVE}.age"
  age -r "${SIRK_BACKUP_AGE_RECIPIENT}" -o "${ENCRYPTED}.partial" "${ARCHIVE}"
  mv -- "${ENCRYPTED}.partial" "${ENCRYPTED}"
  (
    cd "${BACKUP_ROOT}"
    sha256sum "$(basename "${ENCRYPTED}")" > "$(basename "${ENCRYPTED}").sha256"
  )
  chmod 0600 "${ENCRYPTED}" "${ENCRYPTED}.sha256"
  rm -f -- "${ARCHIVE}" "${ARCHIVE}.sha256"
  OUTPUT="${ENCRYPTED}"
fi

find "${BACKUP_ROOT}" -maxdepth 1 -type f -name 'sirk-central-*' -mtime "+${RETENTION_DAYS}" -delete
printf 'Backup completed: %s\n' "${OUTPUT}"
