#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

cd /opt/sirk-central
test -f .env

read -r -p "Microsoft Entra Application (client) ID: " CLIENT_ID
read -r -s -p "Microsoft Entra client secret: " CLIENT_SECRET
printf '\n'
read -r -s -p "Repeat client secret: " CLIENT_SECRET_CONFIRM
printf '\n'

[[ "$CLIENT_ID" =~ ^[0-9a-fA-F-]{36}$ ]] || { echo "Invalid client ID." >&2; exit 1; }
[[ -n "$CLIENT_SECRET" ]] || { echo "Client secret is empty." >&2; exit 1; }
[[ "$CLIENT_SECRET" == "$CLIENT_SECRET_CONFIRM" ]] || { echo "Client secrets do not match." >&2; exit 1; }
unset CLIENT_SECRET_CONFIRM

AUTH_DOMAIN="${SIRK_AUTH_DOMAIN:-auth.sirkportal.com}"
ENTRA_TENANT="${SIRK_ENTRA_TENANT:-organizations}"
SHARED_SECRET="$(openssl rand -base64 48 | tr -d '\n' | tr '+/' '-_')"
TMP="$(mktemp /opt/sirk-central/.env.auth.XXXXXX)"

awk '!/^SIRK_AUTH_DOMAIN=|^SIRK_AUTH_ORIGIN=|^SIRK_ENTRA_TENANT=|^SIRK_ENTRA_CLIENT_ID=|^SIRK_ENTRA_CLIENT_SECRET=|^SIRK_SSO_SHARED_SECRET=/' .env > "$TMP"
cat >> "$TMP" <<EOF
SIRK_AUTH_DOMAIN=${AUTH_DOMAIN}
SIRK_AUTH_ORIGIN=https://${AUTH_DOMAIN}
SIRK_ENTRA_TENANT=${ENTRA_TENANT}
SIRK_ENTRA_CLIENT_ID=${CLIENT_ID}
SIRK_ENTRA_CLIENT_SECRET='${CLIENT_SECRET}'
SIRK_SSO_SHARED_SECRET='${SHARED_SECRET}'
EOF

chmod 0600 "$TMP"
mv "$TMP" .env
unset CLIENT_SECRET SHARED_SECRET

docker compose config >/dev/null
docker compose up -d --build --force-recreate auth central caddy
docker compose ps

printf '\nAuth Broker configured.\n'
printf 'Login URL: https://%s/login\n' "$AUTH_DOMAIN"
