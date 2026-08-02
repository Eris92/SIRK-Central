# SIRK Central .NET 10 — final security and code audit

## Scope

Audit covers the ASP.NET Core / .NET 10 runtime on `rewrite/dotnet10`, including authentication, authorization, Portal protocol, tunnel, backup/restore, persistence, update catalog, container boundary and CI.

## Closed findings

### Critical

- Operations and Portal tunnel middleware run only after ASP.NET Core authentication and authorization.
- Tunnel response completion is bound to the Portal that owns the request.
- Central session and CSRF cookies are removed from requests forwarded to Portals.
- Portal responses cannot set cookies using Central session or CSRF cookie names.
- Production startup refuses to run without an X.509 certificate protecting the Data Protection key ring.
- Portal release metadata requires a valid ECDSA P-256/SHA-256 signature covering version, channel, package URL, SHA-256, architecture and commit.
- File-backed storage acquires an exclusive single-writer lease before any mutable store is opened.

### High

- Tunnel global pending requests are limited to 4096.
- Per-Portal queued requests are limited to 128.
- Request and response bodies are limited to 8 MiB.
- Tunnel methods and paths are allowlisted and normalized.
- Portal connect requires Central antiforgery validation.
- Tunnel timeout and capacity failures return controlled 504/503 responses.
- Default `AllowedHosts` is restricted to `localhost;127.0.0.1`.
- `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Resource-Policy: same-origin` are emitted.
- Container image enables security by default and expects secrets under `/run/secrets`.
- Missing certificate, certificate password or release signing key causes immediate fail-closed startup.

### Medium

- Business middleware is managed by dependency injection.
- The WebAuthn UI startup filter is isolated to static JavaScript injection only.
- Tunnel polling discards expired or missing pending requests.
- Header values containing CR/LF are rejected.
- Absolute untrusted Portal redirects are not forwarded.
- Hot-path prefix validation avoids unnecessary allocations.
- Storage lease files and security stores are restricted to Unix mode 0600.

## Existing validated controls

- .NET 10 only; no net8/net9 compatibility.
- Non-root container runtime and diagnostics disabled.
- Strict cookies, no sliding sessions and immediate principal revalidation.
- PBKDF2-SHA256 credential hashing and constant-time comparison.
- Entra Authorization Code + PKCE and privileged-role approval.
- WebAuthn UV required, one-time ceremonies and counter rollback protection.
- HMAC Portal heartbeat with timestamp and replay-resistant nonce.
- Tamper-evident audit log.
- Encrypted backup key with password rewrap and explicit rotation.
- `age` encrypted backup archive, checksum, path confinement, staging and rollback.
- Atomic persistence and Unix mode 0600 for security stores.
- Trusted-host allowlist, redirect limit, SHA-256 and ECDSA signature verification for Portal releases.
- TreatWarningsAsErrors, latest analysis level, CodeQL, dependency audit, SBOM and secret-pattern checks.

## Mandatory production configuration

```text
ASPNETCORE_ENVIRONMENT=Production
AllowedHosts=central.sirkportal.com
Sirk__ReverseProxy__TrustAll=false
Sirk__Security__Enabled=true
Sirk__Security__DataRoot=/var/lib/sirk-central/security
Sirk__PortalProtocol__DataRoot=/var/lib/sirk-central
Sirk__Security__DataProtectionCertificatePath=/run/secrets/sirk-central-dataprotection.pfx
Sirk__Security__DataProtectionCertificatePasswordFile=/run/secrets/sirk-central-dataprotection-password
Sirk__Security__ReleaseSigningPublicKeyFile=/run/secrets/sirk-release-signing-public-key
Sirk__Security__RequireProtectedDataProtectionKeys=true
Sirk__Security__RequireSignedReleases=true
Sirk__Security__RequireSingleWriterLease=true
```

Secret files must be readable only by the container UID. On Linux, the PFX and password file must use mode 0600. The release signing public key file contains Base64-encoded DER SubjectPublicKeyInfo for an ECDSA P-256 key.

Use an explicitly configured known reverse proxy/network. Do not enable `Sirk__ReverseProxy__TrustAll=true` on an Internet-facing instance unless only the reverse proxy can reach Kestrel.

Mount `/var/lib/sirk-central` as a dedicated persistent volume. For active/passive HA, both instances may reference the same storage, but exactly one instance can hold the writer lease. A standby must be restarted or health-managed until the active instance releases the lease. Active/active is intentionally rejected for file-backed storage.

## Release signature payload

The release pipeline signs this UTF-8 payload with ECDSA P-256/SHA-256 using DER-encoded ECDSA signatures:

```text
schemaVersion
applicationId
version
channel
packageUrl
sha256-uppercase
architecture
commit
```

Any modification to a signed field invalidates the release metadata.

## Acceptance requirements

- All PR workflows must pass on the exact test commit.
- Confirm production image fails closed when required secrets are absent.
- Confirm encrypted Data Protection key files do not contain plaintext master keys.
- Confirm a second process cannot acquire the writer lease while Central is running.
- Confirm lease takeover succeeds after clean shutdown or active-node failure.
- Confirm unsigned and tampered release metadata is rejected.
- Execute `docs/DOTNET10-ACCEPTANCE.md` against a clean VPS.
- Perform 24-hour endurance and full backup → reinstall → password-only restore.

## Remaining architecture boundary

The audited file-backed runtime supports single-node and active/passive operation. It deliberately does not claim active/active multi-writer support. Active/active requires a transactional shared backend and is outside this test release; attempting to start a second writer is blocked instead of risking split-brain or data corruption.
