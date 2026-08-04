#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

INSTALL_DIR="${SIRK_INSTALL_DIR:-/opt/sirk-central}"
BASE_COMPOSE="${INSTALL_DIR}/docker-compose.yml"
APPLIANCE_COMPOSE="${INSTALL_DIR}/docker-compose.appliance.yml"

[[ -f "$BASE_COMPOSE" ]]
[[ -f "$APPLIANCE_COMPOSE" ]]

export SIRK_COMPOSE_FILE="$BASE_COMPOSE"
export SIRK_COMPOSE_PROFILES="auth,maintenance"

bash "${INSTALL_DIR}/deploy/web-update.sh"

# The updater cannot synchronously recreate its own container. Schedule the
# appliance worker and gateway refresh after this request process exits.
nohup /usr/bin/env bash -c '
  set -Eeuo pipefail
  sleep 3
  cd "$1"
  docker compose \
    -f docker-compose.yml \
    -f docker-compose.appliance.yml \
    --profile auth \
    up -d --no-deps --force-recreate updater updater-gateway
' _ "$INSTALL_DIR" >>"${SIRK_UPDATER_STATE_DIR:-/var/lib/sirk-updater}/worker-refresh.log" 2>&1 </dev/null &

disown || true
