# SIRK Central

SIRK Central is the public multi-tenant control plane for SIRK Portals.

## Runtime

- ASP.NET Core on .NET 10 LTS
- one Central process behind Caddy
- no Node.js runtime, npm dependencies, separate auth service or privileged updater worker
- browser JavaScript is stored only under `public/` and `website/`
- encrypted backups use `age`
- Central is the only runtime component that reads SIRK product releases from GitHub
- Agent, Portal and SIRK Updater consume verified packages from the Central update cache and do not require GitHub credentials
- release private signing keys exist only in CI/signing environments; Central stores only the public release trust keyring

## Main integrations

- Microsoft Entra ID / OIDC
- local Break-Glass with Access URL, recovery codes and WebAuthn/YubiKey
- central RBAC, organizations, teams and Portal assignments
- Portal enrollment, signed heartbeat, command channel and reverse tunnel
- Approval Center and ticket lifecycle
- encrypted backup, restore and key rotation
- signed immutable product releases and Central-owned update distribution/cache

## Installation

Initial bootstrap is allowed to use the public installer route:

```bash
curl -fsSL https://raw.githubusercontent.com/Eris92/SIRK-Central/main/install.sh | sudo bash
```

Before a production install place these two externally provisioned files on the host (or override their paths with the corresponding environment variables):

- `/root/sirk-release-trusted-keys.json` — public ES256 release trust keyring only; never a private key
- `/root/sirk-updates-github-token` — the single GitHub read token owned by Central

The installer copies them into the protected Central secret directory and creates a separate random loopback-only host update control token. Installed self-update uses `update.sh`, which asks the running Central broker to populate/verify the local release cache and deploys that cache payload transactionally; it does not use repository checkout as the release source.

## Portal connection

Create a Portal in Central and use **Pobierz plik połączenia**. Downloading the file rotates the Portal token and returns the only plaintext copy. Import that JSON file in Portal settings. The document configures HTTPS heartbeat and the WSS reverse tunnel.
