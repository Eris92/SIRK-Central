# SIRK Central .NET 10 — final security and code audit

## Scope

Audit covers the ASP.NET Core / .NET 10 runtime on `rewrite/dotnet10`, including authentication, authorization, Portal protocol, tunnel, backup/restore, persistence, update catalog, container boundary and CI.

## Closed findings

### Critical

- Operations and Portal tunnel middleware previously ran through an `IStartupFilter` before `UseAuthentication`; they now run after ASP.NET Core authentication and authorization.
- Tunnel response completion is now bound to the Portal that owns the request. A different Portal cannot inject or complete a response.
- Central session and CSRF cookies are removed from requests forwarded to Portals.
- Portal responses cannot set cookies using Central session or CSRF cookie names.

### High

- Tunnel global pending requests are limited to 4096.
- Per-Portal queued requests are limited to 128.
- Request and response bodies remain limited to 8 MiB.
- Tunnel methods and paths are allowlisted and normalized.
- Portal connect requires Central antiforgery validation.
- Tunnel timeout and capacity failures return controlled 504/503 responses without internal exception details.
- Default `AllowedHosts` is restricted to `localhost;127.0.0.1`; production must explicitly set the public hostname.
- `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Resource-Policy: same-origin` are emitted with the existing security headers.

### Medium

- Business middleware is managed by dependency injection instead of being constructed manually inside the UI startup filter.
- The WebAuthn UI startup filter is isolated to static JavaScript injection only.
- Tunnel polling discards expired or missing pending requests.
- Header values containing CR/LF are rejected.
- Absolute untrusted Portal redirects are not forwarded to the browser.
- Hot-path single-character prefix validation avoids allocation for ordinal comparisons.

## Existing validated controls

- .NET 10 only; no net8/net9 compatibility.
- Non-root container runtime and diagnostics disabled.
- Strict cookies, no sliding sessions, immediate principal revalidation.
- PBKDF2-SHA256 credential hashing and constant-time comparison.
- Entra Authorization Code + PKCE and privileged-role approval.
- WebAuthn UV required, one-time ceremonies and counter rollback protection.
- HMAC Portal heartbeat with timestamp and replay-resistant nonce.
- Tamper-evident audit log.
- Encrypted backup key with password rewrap and explicit rotation.
- `age` encrypted backup archive, checksum, path confinement, staging and rollback.
- Atomic persistence and Unix mode 0600 for security stores.
- Trusted-host allowlist and redirect limit for Portal release metadata.
- TreatWarningsAsErrors, latest analysis level, CodeQL, dependency audit, SBOM and secret-pattern checks.

## Mandatory production configuration

Set at minimum:

```text
ASPNETCORE_ENVIRONMENT=Production
AllowedHosts=central.sirkportal.com
Sirk__ReverseProxy__TrustAll=false
Sirk__Security__Enabled=true
Sirk__Security__DataRoot=/var/lib/sirk-central/security
Sirk__PortalProtocol__DataRoot=/var/lib/sirk-central
```

Use an explicitly configured known reverse proxy/network. Do not enable `Sirk__ReverseProxy__TrustAll=true` on an Internet-facing instance unless the service is isolated so only the reverse proxy can reach Kestrel.

Mount `/var/lib/sirk-central` as a dedicated persistent volume owned only by the container UID. Run the container with a read-only root filesystem where supported and permit writes only to the persistent volume and required temporary filesystem.

## Acceptance requirements

- All PR workflows must pass on the exact test commit.
- Execute `docs/DOTNET10-ACCEPTANCE.md` against a clean VPS.
- Confirm the public host rejects unexpected Host headers.
- Confirm a second Portal cannot complete another Portal's tunnel request.
- Confirm Central cookies never appear in Portal request logs.
- Confirm queue exhaustion returns 503 and recovers after requests expire.
- Perform 24-hour endurance and full backup → reinstall → password-only restore.

## Residual operational risks

- Data Protection key-ring confidentiality depends on protection of the persistent volume and host. Production deployment should use encrypted storage and strict host-level access control; HSM/KMS-backed key protection is recommended before general availability.
- Release metadata authenticity currently relies on trusted GitHub transport plus SHA-256 metadata. Package signing and signature verification remain required before a production/general-availability release.
- Full HA/failover behavior must be verified in a multi-node environment because current file-backed stores are single-writer state.
