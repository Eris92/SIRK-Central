#!/usr/bin/env bash
set -euo pipefail
exec bash "$(dirname "$0")/deploy/reinstall-dotnet10.sh" "$@"
