#!/usr/bin/env bash
set -euo pipefail

cd /opt/sirk-central
test -f .env

sudo docker build --tag sirk-central:setup .
sudo docker run --rm -it \
  --user 0:0 \
  --volume /opt/sirk-central:/config \
  --env SIRK_CONFIG_TARGET=/config \
  sirk-central:setup \
  node scripts/configure-production.js --reset-admin-password

sudo chmod 0600 .env
sudo docker compose up -d --build --force-recreate central
sudo docker compose ps
