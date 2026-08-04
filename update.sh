#!/usr/bin/env bash
set -euo pipefail
exec bash "$(dirname "$0")/deploy/upgrade-dotnet10-vps.sh" "$@"
