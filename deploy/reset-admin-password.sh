#!/usr/bin/env bash
set -euo pipefail

cd /opt/sirk-central
test -f .env

sudo docker build --tag sirk-portal-central:setup .
sudo docker run --rm -it \
  --volume /opt/sirk-central:/config \
  --env SIRK_CONFIG_TARGET=/config \
  sirk-portal-central:setup \
  node scripts/configure-production.js --reset-admin-password

sudo docker compose up -d --build --force-recreate central
sudo docker compose ps

