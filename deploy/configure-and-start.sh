#!/usr/bin/env bash
set -euo pipefail

cd /opt/sirk-central

if [[ -f .env ]]; then
  echo ".env already exists; refusing to replace production credentials." >&2
  exit 1
fi

sudo docker build --tag sirk-central:setup .
sudo docker run --rm -it \
  --volume /opt/sirk-central:/config \
  --env SIRK_CONFIG_TARGET=/config \
  sirk-central:setup \
  node scripts/configure-production.js

sudo docker compose up -d --build
sudo docker compose ps
