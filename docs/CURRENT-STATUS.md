# SIRK Central — bieżący stan

Data aktualizacji: 2026-08-01

## Repozytorium

```text
Repo: Eris92/SIRK-Central
Canonical branch: main
Working branch: refactor/remove-legacy-runtime
Draft PR: #46
Runtime: src/server.js
Version: 1.0.0-rc.26
```

PR #46 pozostaje niescalony. Repozytorium SIRK Portal nie zostało zmodyfikowane.

## Płaski runtime

Jedynym entrypointem jest `src/server.js`. Runtime ma:

- jedno `http.createServer()`;
- jeden handler WebSocket upgrade;
- jeden dispatcher HTTP;
- osobną kolejkę middleware transportowego;
- wspólny transport JSON/body/cookies/CSRF/security headers;
- nazwane moduły domenowe w `src/modules/`;
- jedno źródło wersji w `src/version.js`.

Usunięto:

```text
server-v1.js ... server-v15.js
src/entry.js
src/preload-api.js
src/preload-hardening.js
src/server-hardened.js
src/server-production.js
store'y i API *-v2
alternatywne Dockerfile/Compose
start:legacy
etapowe uruchamianie części runtime
```

`scripts/validate-runtime-architecture.js` blokuje powrót wersjonowanych serwerów, alternatywnych entrypointów, staged runtime, retired contracts i nieosiągalnych plików produkcyjnych.

## Transport i uwierzytelnianie

- CSRF obowiązuje mutacje wykonywane przez sesję przeglądarkową;
- `/api/login/mfa/recovery` wymaga CSRF także przed wydaniem pełnej sesji;
- podpisany namespace `/api/portal/v1/*` zachowuje własną granicę HMAC/timestamp/nonce;
- anonimowe żądania zachowują właściwe `401/403`, zamiast być maskowane przez CSRF;
- Auth hardening działa jako middleware przed trasami domenowymi;
- login ma jedną aktywną implementację;
- recovery codes mają stały format 20 znaków hex i 80 bitów entropii;
- passkey registration weryfikuje prawdziwy WebAuthn attestation i COSE ES256;
- MFA continuity jest egzekwowane wewnątrz operacji revoke.

## Portal tunnel

Moduł `src/modules/portal-tunnel.js` obsługuje:

```text
POST /api/portals/:id/connect
/connect/:id/*
```

Granice:

- RBAC `portals.connect`;
- capability `portal.connect`;
- emergency policy lock;
- limit body 8 MiB;
- brak przekazywania cookie sesji Central;
- bezpieczne przepisywanie Location, Set-Cookie Path i ścieżek w treści;
- kontrolowane mapowanie timeout/offline/broker errors.

## Storage i concurrency

- fail-fast single-writer lease w `/var/lib/sirk-central/.sirk-central-runtime.lock`;
- druga instancja na tym samym storage kończy start `RUNTIME_STORAGE_LOCKED`;
- fresh malformed lock jest fail-closed;
- stale lock jest odzyskiwany po quarantine;
- graceful shutdown zamyka HTTP, WebSockety, broker i zwalnia lease;
- concurrency suite obejmuje heartbeat, tickets, command polling i ACK.

## Portal commands i tickets

Portal commands:

- trwała kolejka z delivery lease;
- ACK ordering oraz idempotent terminal ACK;
- `queued` może zostać anulowany natychmiast;
- `delivered/running` przechodzi w `cancel_requested`;
- Portal otrzymuje `control: cancel`;
- `completed` lub `failed` może bezpiecznie wygrać race.

Tickets:

- provider-independent projection schema;
- canonical Tenant/Customer/Site assignment;
- fail-closed publication policy;
- snapshot i event ingestion;
- digest-bound replay protection;
- version/order conflict oraz capacity protection;
- właściwe `400/409/429/5xx` dla pojedynczego eventu;
- `207` tylko dla jawnego partial batch.

## Stack i granice uprawnień

Base stack:

```text
central
auth
updater-gateway
backup-manager
caddy
```

`updater-gateway` działa stale jako `USER node`, bez Docker socketu, wolumenów i host ports.

`backup-manager`:

- używa osobnego minimalnego obrazu `updater/Dockerfile.manager`;
- nie ma Docker CLI ani Docker socketu;
- nie publikuje portów;
- ma read-only root filesystem i tmpfs `/tmp`;
- montuje dane Central tylko `ro`;
- zapisuje wyłącznie do `updater-state`.

`updater` działa wyłącznie w profilu `maintenance`, jako jawny root/Docker-socket trust boundary, z `restart: "no"`.

## Automatyczna walidacja

Workflow CI sprawdza:

- składnię shell/JavaScript/Python;
- pełną suite Node uruchamianą plik po pliku;
- płaską architekturę i forward-only contracts;
- base oraz maintenance Compose;
- granice gateway/manager/worker;
- budowę obrazów central, auth, gateway, updater i manager;
- użytkowników oraz składnię runtime wewnątrz obrazów.

Security Audit sprawdza:

- regresje bezpieczeństwa i współbieżności;
- Portal tunnel integration;
- `npm audit --omit=dev --audit-level=high`;
- SBOM;
- committed secrets i dangerous execution patterns;
- CodeQL;
- izolację backup managera i maintenance worker boundary.

Dokument nie zastępuje wyniku workflow dla konkretnego HEAD — przed merge należy sprawdzić aktualne CI, Security Audit i UI E2E.

## Walidacja środowiskowa do wykonania

```bash
cd /opt/sirk-central
git fetch origin
git checkout main
git reset --hard origin/main
npm ci
npm run check:syntax
SIRK_CONCURRENCY_TEST_REQUESTS=24 npm test
npm audit --omit=dev --audit-level=high
```

Następnie na nieprodukcyjnym VPS:

1. `deploy/acceptance-test.sh`;
2. destructive backup/restore z forced rollback;
3. update/rollback failure drill i potwierdzenie usunięcia workera;
4. realny YubiKey w Edge i Chrome;
5. pełny workflow Entra;
6. Portal simulator z prawdziwym tokenem;
7. external TLS/Caddy/CSP/security headers;
8. PL/EN i responsive visual review.

## Residual risks

- file-backed stores są single-writer, nie active-active HA;
- worker maintenance pozostaje root-equivalent podczas jawnie otwartego okna;
- realne Entra, YubiKey, TLS i rollback wymagają testów środowiskowych;
- konektory Jira/ServiceDesk/GLPI należą do repo SIRK Portal;
- PR #46 nie powinien być scalany bez zielonych workflow dla finalnego HEAD.
