# SIRK Auth Broker

## Entra App Registration

```text
Application type:       multitenant
Platform:               Web
Redirect URI:           https://auth.sirkportal.com/auth/entra/callback
Front-channel logout:   https://auth.sirkportal.com/auth/entra/frontchannel-logout
Implicit flow:          disabled
Public client flow:     disabled
Delegated permission:   Microsoft Graph / User.Read
```

Auth Broker uses Authorization Code Flow with PKCE, `state` and `nonce`. Central receives a signed ticket with TTL 60 seconds. Ticket `jti` can be consumed only once.

## Required administrator identity

Access is denied unless the authenticated `tid:oid` pair exists in `SIRK_ENTRA_ADMIN_IDENTITIES`.

Retrieve identifiers with Azure CLI:

```bash
az account show --query tenantId -o tsv
az ad signed-in-user show --query id -o tsv
```

Store them as:

```text
<TENANT_ID>:<OBJECT_ID>
```

Multiple administrators are separated with commas.

## Configure on the VPS

Ensure DNS points to the SIRK Central VPS:

```text
auth.sirkportal.com  A/AAAA -> VPS
```

Update the repository and run the interactive helper:

```bash
cd /opt/sirk-central
git pull --ff-only origin main
bash ./deploy/configure-auth.sh
```

The helper requests:

- Application client ID,
- allowed administrator `tenant-id:object-id` values,
- client secret.

It generates `SIRK_SSO_SHARED_SECRET`, updates root-owned `.env` and starts the Compose `auth` profile.

## Verification

```bash
cd /opt/sirk-central

docker compose --profile auth ps
docker compose --profile auth logs --tail=100 auth central caddy

curl -fsS https://auth.sirkportal.com/healthz
curl -I https://auth.sirkportal.com/login
curl -fsS https://central.sirkportal.com/healthz
```

Expected results:

- Auth health endpoint returns `ok`,
- `/login` redirects to `login.microsoftonline.com`,
- successful Entra login redirects to SIRK Central,
- Central displays the authenticated identity and `Microsoft Entra`,
- local username/password login is visible only when the URL contains the break-glass access key.

## Secret rotation

Create a new client secret in Entra and rerun:

```bash
bash /opt/sirk-central/deploy/configure-auth.sh
```

The helper also rotates the internal SSO shared secret and recreates Auth Broker and Central together.
