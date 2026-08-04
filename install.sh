#!/usr/bin/env bash
set -euo pipefail
exec bash "$(dirname "$0")/deploy/install-dotnet10.sh" "$@"
