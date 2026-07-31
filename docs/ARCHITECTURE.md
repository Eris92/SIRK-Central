# Architektura SIRK Central

## Cel

SIRK Central jest centralnym management plane dla niezależnych instalacji SIRK Portal. Portal inicjuje połączenia wychodzące i zachowuje autonomiczną pracę lokalną.

## Topologia

```text
Internet
   |
Caddy :80/:443
   |
   +--> Central UI/API (server-v15)
   +--> Auth broker (profil auth)

Internal network
   +--> backup-manager
   +--> updater-gateway (stale, nieuprzywilejowany)
   `--> updater worker (wyłącznie profil maintenance)

SIRK Portal ---- outbound HTTPS/WSS ----> Central
```

## Runtime

Kanoniczny entrypoint:

```text
src/server-v15.js
```

Nie istnieje drugi produkcyjny entrypoint. `package.json`, oba Dockerfile, CI i acceptance wskazują ten sam plik.

Aktywna kompozycja modułów:

```text
v15  tickets, SSO callback, runtime storage lease
v14  Portal command queue and ACK
v13  approval execution
v12  session administration
v11  admin/backup controls
v10  heartbeat and telemetry
v9   restore integration
v8   identity, MFA, update and backup
v7   UI/runtime assets and security headers
v6   WebAuthn attestation
v5   final UI and workspace routing
v4   WebAuthn/passkeys
v3   production UI wrapper
v2   CSRF, recovery and login transactions
v1   base stores, API and WebSocket broker
```

Pliki v1-v14 są osiągalnymi zależnościami v15, a nie alternatywnymi wdrożeniami. `scripts/validate-no-legacy-runtime.js` buduje graf statycznych `require()` i odrzuca nieosiągalne pliki `server*.js`.

Usunięte zostały stare `entry.js`, równoległy `server.js`, preloady, wrappery hardened/production oraz duplikat sesji.

## Granice odpowiedzialności

### Central

- globalna tożsamość, role i access scope;
- Tenant → Customer → Site;
- rejestr/assignment Portali;
- approvals i audit;
- heartbeat, telemetryka i commands;
- zagregowane ticket projections;
- backup/update/restore Central.

### Portal

- urządzenia, Agenci i lokalne logowanie;
- lokalne sekrety connectorów;
- integracje Jira/ServiceDesk/GLPI;
- wykonanie commands i trwałe ACK;
- cooperative cancellation;
- publikacja ticketów zgodnie z Central policy.

Central nie przechowuje tokenów systemów ticketowych.

## Dane trwałe

Wolumen:

```text
/var/lib/sirk-central
```

Store używają atomowego write-to-temp + rename i plików 0600. Główne dane: users, sessions, WebAuthn, recovery codes, organizations, Portals, assignments, approvals, audit, telemetry, commands, ticket projections i policies.

### Single-writer lease

File-backed JSON nie jest bazą multi-writer. Runtime v15 przed inicjalizacją store atomowo tworzy:

```text
/var/lib/sirk-central/.sirk-central-runtime.lock/
  owner.json
```

Owner zawiera `instanceId`, PID, hostname, start i heartbeat. Drugi runtime na tym samym storage kończy start `RUNTIME_STORAGE_LOCKED`.

Zasady:

- świeży lock, także uszkodzony, jest fail-closed;
- stale lock może być odzyskany po quarantine;
- przy braku poprawnego owner timestamp używany jest `mtime` katalogu;
- SIGTERM/SIGINT zamyka HTTP server i zwalnia lease;
- `SIRK_RUNTIME_LOCK_DISABLED=true` jest zabronione w production.

Skalowanie active-active wymaga transakcyjnej bazy, optimistic concurrency i distributed locking. Nie należy montować tego samego volume RW do dwóch replik Central.

## Identity i RBAC

Użytkownicy: Entra ID, local users i built-in BreakGlass. Cookies są `HttpOnly`, `Secure`, `SameSite`; mutacje wymagają CSRF cookie/header i kontroli Origin/Sec-Fetch-Site.

Role i zakres są rozdzielone:

- `SecAdmin` — security, sessions, privileged approvals, audit;
- `Admin` — organization, Portals i operational execution;
- `Auditor` — read-only;
- role operacyjne — ograniczony zakres;
- `accessStore` — widoczność konkretnych Portali.

`pending`, `conflict` i `disabled` nie otrzymują uprawnień.

## Portal commands

Kolejka jest trwała i nie wykonuje arbitrary shell/PowerShell. Dozwolone typy są zamkniętą allowlistą.

```text
queued -> delivered -> running -> completed|failed
   |          |          |
   +------ cancelled      +-> cancel_requested -> cancelled
                          `-> completed|failed (race)
```

Dla delivered/running Central wysyła podczas pollingu `control: "cancel"`. Portal musi idempotentnie zatrzymać operację i potwierdzić `cancelled`.

## Tickets

Klucz projekcji:

```text
portalId + ticketId
```

Tenant/Customer/Site pochodzą z canonical assignment. Portal nie może nadpisać metadanych Central. Domyślna policy to `none`.

Ordering/replay:

- starsza wersja nie nadpisuje nowszej;
- równy timestamp z innym payloadem jest konfliktem;
- `eventId` i snapshot cursor są wiązane z digestem payloadu;
- pojedynczy błąd zwraca precyzyjny status HTTP;
- HTTP 207 jest wyłącznie dla partial batch.

## Kontenery

### central

- `USER node`;
- `no-new-privileges`;
- `cap_drop: ALL`;
- health `/readyz`;
- single-writer lease.

### auth

- profil `auth`;
- `USER node`;
- internal signed front-channel logout relay;
- publiczny dostęp do internal relay blokuje Caddy.

### backup-manager

- stale dostępny scheduler/metadata service;
- bez Docker socket;
- brak host port.

### updater-gateway

- stale dostępny, `USER node`;
- bez Docker CLI, Git i tar;
- bez wolumenów i host ports;
- dokładna allowlista tras i hosta workera;
- przy zamkniętym maintenance zwraca `409 UPDATER_MAINTENANCE_REQUIRED`.

### updater

- profil `maintenance`;
- `restart: "no"`;
- Docker socket i RW repo/data tylko podczas jawnego maintenance window;
- root-equivalent trust boundary;
- brak host port.

```bash
sudo bash deploy/maintenance-up.sh
sudo bash deploy/maintenance-down.sh
```

### caddy

Jedyny publiczny ingress: porty 80/443, TLS, reverse proxy i security headers.

## Build context

`.dockerignore` wyklucza Git, dokumentację, testy, raporty, lokalne `.env`, dane, logi i archiwa. Zmniejsza to kontekst builda i zapobiega przypadkowemu dołączeniu lokalnych danych do obrazu.

## Gotowość

Kod jest na `main`, ale produkcyjna akceptacja wymaga zielonego CI dla finalnego HEAD, VPS acceptance, backup/restore i update/rollback drill, realnego YubiKey, pełnego workflow Entra oraz manualnego przeglądu UI/TLS.
