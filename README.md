# SIRK Central

SIRK Central is the public multi-tenant control plane for SIRK Portals.

## Runtime

- ASP.NET Core on .NET 10 LTS
- one Central process behind Caddy
- no Node.js runtime, npm dependencies, separate auth service or Node updater services
- browser JavaScript is stored only under `public/` and `website/`
- encrypted backups use `age`
- updates are delegated to the shared SIRK Updater product

## Main integrations

- Microsoft Entra ID / OIDC
- local Break-Glass with Access URL, recovery codes and WebAuthn/YubiKey
- central RBAC, organizations, teams and Portal assignments
- Portal enrollment, signed heartbeat, command channel and reverse tunnel
- Approval Center and ticket lifecycle
- encrypted backup, restore and key rotation
- signed release metadata and maintenance operations

## Installation

```bash
curl -fsSL https://raw.githubusercontent.com/Eris92/SIRK-Central/main/install.sh | sudo bash
```

## Portal connection

Create a Portal in Central and use **Pobierz plik połączenia**. Downloading the file rotates the Portal token and returns the only plaintext copy. Import that JSON file in Portal settings. The document configures HTTPS heartbeat and the WSS reverse tunnel.
