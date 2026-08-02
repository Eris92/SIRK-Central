#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

INSTALLER_URL="${INSTALLER_URL:-https://raw.githubusercontent.com/Eris92/SIRK-Central/rewrite/dotnet10/deploy/reinstall-dotnet10.sh}"
TMP_INSTALLER="$(mktemp /tmp/sirk-central-install.XXXXXX.sh)"

cleanup() {
  rm -f "$TMP_INSTALLER"
}
trap cleanup EXIT

cd /
curl -fsSL "$INSTALLER_URL" -o "$TMP_INSTALLER"
chmod 0700 "$TMP_INSTALLER"

if [[ -r /dev/tty && -w /dev/tty ]]; then
  exec bash "$TMP_INSTALLER" </dev/tty
fi

if [[ -z "${BG_PASSWORD:-}" ]]; then
  echo "ERROR: Brak interaktywnego terminala. Ustaw BG_PASSWORD albo uruchom z TTY." >&2
  exit 1
fi

exec bash "$TMP_INSTALLER"
