# SIRK Central production hardening

Branch: `feat/central-production-hardening`

## Implemented

- global CSRF protection and secret redaction,
- web updater with isolated updater service, locking, backup and rollback,
- persistent hashed session-store module with idle and absolute expiration tests,
- Tenant -> Customer -> Site persistent organization model,
- organization management API with RBAC,
- Approval Center store and API with separation of duties and two-person approval,
- persistent Portal -> Tenant -> Customer -> Site assignments,
- verified backup and guarded restore scripts,
- GitHub Actions CI for syntax, tests, Compose validation and basic secret scanning.

## Required before merging

- CI must pass on Node.js 22,
- Docker Compose validation must pass,
- persistent session store must replace the in-memory session `Map` in the primary server,
- break-glass password/access rotation must revoke previous break-glass sessions,
- negative authorization tests must cover organization, approval and Portal assignment APIs,
- production deployment must be smoke-tested on a non-production VPS before rollout.

## Deferred until SIRK Portal integration phase

- signed short-lived Central -> Portal authorization tickets,
- delegated local credential profile usage,
- Portal enrollment and certificate rotation,
- remote operation approval execution,
- audited RDP, SSH and PowerShell session lifecycle.
