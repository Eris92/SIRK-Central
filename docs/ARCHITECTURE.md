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
   `--> updater (wyłącznie profil maintenance)

SIRK Portal ---- outbound HTTPS/WSS ----> Central
```

## Runtime

Kanoniczny entry point:

```text
src/server-v15.js
```

Łańcuch kompozycji:

```text
v15  tickets, SSO callback, runtime storage lease
v14  Portal command queue and ACK
v13  approval execution
v12  session administration
v11  admin/backup controls
v10  heartbeat and telemetry
v9   restore integration
v8   identity, MFA, update and backup
```

Pliki legacy z `main` są zachowane dla zgodności merge, ale nie są produkcyjnym runtime.

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

Skalowanie active-active wymaga PostgreSQL/SQL Server lub innej transakcyjnej bazy, optimistic concurrency i distributed locking. Nie należy montować tego samego volume RW do dwóch replik Central.

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

Lifecycle:

```text
queued -> delivered -> running -> completed|failed
   |          |          |
   +------ cancelled      +-> cancel_requested -> cancelled
                          `-> completed|failed (race)
```

Dla delivered/running Central wysyła podczas pollingu `control: "cancel"`. Portal musi idempotentnie zatrzymać operację i potwierdzić `cancelled`. Dopóki nie ma ACK, Central nie deklaruje fałszywego zakończenia.

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
- HTTP 207 jest wyłącznie dla partial batch i zawiera per-item retry guidance.

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

### updater

- profil `maintenance`;
- `restart: "no"`;
- Docker socket i RW repo/data tylko podczas jawnego maintenance window;
- root-equivalent trust boundary;
- brak host port, internal network, token i exact allowlists.

Otwarcie/zamknięcie:

```bash
sudo bash deploy/maintenance-up.sh
sudo bash deploy/maintenance-down.sh
```

### caddy

Jedyny publiczny ingress: porty 80/443, TLS, reverse proxy i security headers.

## Gotowość

Architektura jest zaimplementowana statycznie, ale produkcyjna akceptacja wymaga zielonego CI, merge z aktualnym `main`, VPS acceptance, backup/restore i update/rollback drill, realnego YubiKey, Entra workflow oraz manualnego przeglądu UI/TLS.
