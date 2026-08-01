# SIRK Central — bieżący stan

Data aktualizacji: 2026-08-01

## Repozytorium

```text
Repo: Eris92/SIRK-Central
Canonical branch: main
Runtime: src/server.js
Version: 1.0.0-rc.26
Legacy refactor PR: #46 — merged
Legacy integration commit: 69d17b1719faa723619df2ac8d7a74959f754bab
VPS acceptance commit: 8d35cab995734606b0fe8811735022ffd90c20eb
```

`main` jest jedyną kanoniczną linią kodu i wdrożeń. Historyczna gałąź `refactor/remove-legacy-runtime` nie jest źródłem wdrożenia. Repozytorium SIRK Portal nie zostało zmodyfikowane.

Automatyczne bramki dla finalnego HEAD PR #46 przed merge:

```text
CI: success
SIRK Central Security Audit: success
SIRK Central UI E2E: success
```

Dla commitów powstałych po merge nie wolno zakładać wyniku GitHub Actions bez sprawdzenia workflow dla dokładnego HEAD.

## Płaski runtime

Jedynym entrypointem jest `src/server.js`. Runtime ma:

- jedno `http.createServer()`;
- jeden handler WebSocket upgrade;
- jeden dispatcher HTTP;
- osobną kolejkę middleware transportowego;
- wspólny transport JSON/body/cookies/CSRF/security headers;
- nazwane moduły domenowe w `src/modules/`;
- jedno źródło wersji w `src/version.js`.

Usunięto historyczne wersjonowane warstwy serwera, alternatywny entrypoint, preloady modyfikujące runtime, równoległe serwery hardened/production, store'y i API `*-v2`, alternatywne Dockerfile/Compose, `start:legacy` oraz etapowe uruchamianie części runtime.

`scripts/validate-runtime-architecture.js` blokuje powrót wersjonowanych serwerów, alternatywnych entrypointów, staged runtime, retired contracts i nieosiągalnych plików produkcyjnych.

## Transport i uwierzytelnianie

- CSRF obowiązuje mutacje wykonywane przez sesję przeglądarkową;
- `/api/login/mfa/recovery` wymaga CSRF także przed wydaniem pełnej sesji;
- podpisany namespace `/api/portal/v1/*` zachowuje granicę HMAC/timestamp/nonce;
- anonimowe żądania zachowują właściwe `401/403`, zamiast być maskowane przez CSRF;
- Auth hardening działa jako middleware przed trasami domenowymi;
- login ma jedną aktywną implementację;
- recovery codes mają stały format 20 znaków hex i 80 bitów entropii;
- passkey registration weryfikuje WebAuthn attestation i COSE ES256;
- MFA continuity jest egzekwowane wewnątrz operacji revoke;
- wewnętrzny `POST /auth/sso/frontchannel-logout` wymaga podpisanego ticketu i zwraca `401` bez ticketu;
- ta sama trasa jest ukryta na publicznym edge i zwraca `404`.

## Audit integrity

Audit działa w schemacie:

```text
version: 2
algorithm: hmac-sha256
```

Na VPS zweryfikowany legacy chain `v1/sha256` został jednorazowo zmigrowany do `v2/HMAC`. Migracja zachowała cztery zdarzenia oraz `legacyLastHash`. Uszkodzony legacy chain pozostaje fail-closed i nie jest automatycznie przepisywany.

Readiness i mutacje są blokowane, gdy weryfikacja integralności audytu nie przechodzi. Logout lokalnej sesji pozostaje dostępny jako operacja bezpieczeństwa.

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
- bezpieczne przepisywanie `Location`, `Set-Cookie Path` i ścieżek w treści;
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

Caddy montuje teraz dedykowany katalog:

```text
./deploy/caddy -> /etc/caddy:ro
```

Nie jest już montowany pojedynczy `Caddyfile`. Zapobiega to pozostaniu kontenera na starym inode po `git reset --hard` lub innej atomowej wymianie pliku przez Git. Acceptance waliduje i przeładowuje konfigurację przed testami publicznego edge.

## Zaliczone VPS acceptance

Acceptance został zaliczony 2026-08-01 na:

```text
HEAD: 8d35cab995734606b0fe8811735022ffd90c20eb
Log: /root/sirk-central-acceptance-final-20260801-112059.log
Node test files: 62/62 passed
npm audit production dependencies: 0 vulnerabilities
Acceptance status: 0
```

Potwierdzono:

- syntax i runtime architecture validation;
- pełną suite Node z concurrency;
- base i maintenance Compose contracts;
- zdrowe `central`, `auth`, `updater-gateway` i `backup-manager`;
- działający Caddy edge;
- runtime storage lease;
- gateway `maintenance-required` przy zamkniętym workerze;
- uruchomienie workera wyłącznie w profilu maintenance;
- proxy gateway podczas jawnie otwartego maintenance;
- zatrzymanie i usunięcie workera po zamknięciu maintenance;
- wewnętrzny logout `401` bez podpisanego ticketu;
- publiczny logout `404`;
- HTTPS, HSTS, CSP i wymagane security headers;
- audit integrity `ok: true`, `version: 2`, `hmac-sha256`.

## Backup

Wykonano i zweryfikowano checksumami safety backupy przed migracją i podczas diagnostyki. Finalny szyfrowany backup produkcyjny pozostaje otwarty, ponieważ `.env` nie ma jeszcze `SIRK_BACKUP_AGE_RECIPIENT`.

Przy `NODE_ENV=production` kanoniczny `deploy/backup.sh` wymaga szyfrowania `age`, chyba że operator jawnie ustawi wyjątek. Finalnego backupu nie należy już wykonywać z `SIRK_BACKUP_REQUIRE_ENCRYPTION=false`.

## Aktualny etap

Refaktor, usunięcie legacy oraz podstawowy VPS acceptance są zakończone. Następne kroki:

1. wygenerować i bezpiecznie zdeponować prywatną tożsamość `age`;
2. dodać tylko publicznego recipienta do `.env` i wykonać szyfrowany backup;
3. wykonać destructive restore z safety backupem i forced rollback;
4. wykonać update/rollback failure drill i potwierdzić usunięcie workera;
5. uruchomić Portal simulator z prawdziwym tokenem;
6. przetestować realny YubiKey w Edge i Chrome;
7. przejść pełny workflow Entra;
8. wykonać PL/EN i responsive visual review.

## Residual risks

- file-backed stores są single-writer, nie active-active HA;
- worker maintenance pozostaje root-equivalent podczas jawnie otwartego okna;
- finalny zaszyfrowany offline backup i restore drill nie są jeszcze ukończone;
- realne Entra, YubiKey i Portal simulator wymagają testów środowiskowych;
- konektory Jira/ServiceDesk/GLPI należą do repo SIRK Portal;
- wydanie `1.0.0` pozostaje zablokowane do zakończenia backup/restore, rollback drills oraz pozostałych testów manualnych.
