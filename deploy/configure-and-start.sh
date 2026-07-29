#!/usr/bin/env bash
set -euo pipefail

cd /opt/sirk-central

if [[ -f .env ]]; then
  echo ".env already exists; refusing to replace production credentials." >&2
  exit 1
fi

: "${SIRK_WEBSITE_DOMAIN:=sirkportal.com}"
: "${SIRK_CENTRAL_DOMAIN:=central.${SIRK_WEBSITE_DOMAIN}}"
: "${SIRK_ACME_EMAIL:=admin@${SIRK_WEBSITE_DOMAIN}}"
: "${SIRK_ADMIN_USERNAME:=admin}"
: "${SIRK_SESSION_HOURS:=8}"
export SIRK_WEBSITE_DOMAIN SIRK_CENTRAL_DOMAIN SIRK_ACME_EMAIL SIRK_ADMIN_USERNAME SIRK_SESSION_HOURS

sudo docker build --tag sirk-central:setup .
sudo docker run --rm -it \
  --volume /opt/sirk-central:/config \
  --env SIRK_CONFIG_TARGET=/config \
  --env SIRK_WEBSITE_DOMAIN \
  --env SIRK_CENTRAL_DOMAIN \
  --env SIRK_ACME_EMAIL \
  --env SIRK_ADMIN_USERNAME \
  --env SIRK_SESSION_HOURS \
  sirk-central:setup \
  node scripts/configure-production.js

sudo docker compose config >/dev/null
sudo docker compose up -d --build --remove-orphans
sudo docker compose ps
