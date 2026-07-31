# SIRK Central

SIRK Central jest wielotenantowym management plane dla instalacji SIRK Portal.

```text
Branch: main
Runtime: src/server-v15.js
Version: 1.0.0-rc.25
```

Gałąź `main` jest kanonicznym kodem SIRK Central. Wersja pozostaje release candidate do czasu zielonego CI, VPS acceptance oraz testów backup/restore, update/rollback, YubiKey i Entra.

## Dokumentacja

- [Bieżący stan](docs/CURRENT-STATUS.md)
- [Architektura](docs/ARCHITECTURE.md)
- [Protokół Central ↔ Portal](docs/PORTAL-PROTOCOL.md)
- [Testy](docs/TESTING.md)
- [Audyt bezpieczeństwa](docs/SECURITY-AUDIT-2026-07-31.md)
- [Polecenie wznowienia](docs/RESUME-PROMPT.md)

## Kanoniczny runtime

```text
src/server-v15.js
```

Ten sam entry point jest wymagany przez `package.json`, Dockerfile, CI, Security Audit i acceptance. Pliki legacy są zachowane wyłącznie dla zgodności i migracji.

## Bezpieczeństwo i tożsamość

- Entra ID Authorization Code + PKCE;
- lokalny BreakGlass z Access URL;
- passkeys/WebAuthn, YubiKey i recovery codes;
- hashowane persistent sessions z idle/absolute timeout;
- globalny browser CSRF i Origin/Sec-Fetch-Site;
- blokowanie `pending`, `conflict` i `disabled`;
- separation of duties `Admin` / `SecAdmin`;
- tamper-evident audit.

## Approval Center

- jedna lub dwie niezależne decyzje;
- self-approval protection;
- exact-scope i single-use approvals;
- high-risk approval zużywany dopiero przy utworzeniu command;
- retry wysokiego ryzyka wymaga nowej zgody;
- legacy approval mutations są wyłączone.

## Portal monitoring i commands

- signed heartbeat HMAC, timestamp i nonce replay protection;
- rate limiting per IP i Portal;
- access-scope filtering;
- trwała kolejka z delivery lease, ACK, progress, result i timeout;
- secret redaction i prototype-pollution protection;
- cooperative cancellation:
  - `queued` → `cancelled`,
  - `delivered/running` → `cancel_requested`,
  - Portal dostaje `control: "cancel"` i kończy ACK `cancelled`;
- `completed/failed` może bezpiecznie wygrać race.

## Tickets

- projection store schema v2;
- canonical Tenant/Customer/Site assignment;
- fail-closed publication policy `none`;
- opis/requester tylko po jawnej zgodzie;
- digest replay i version conflict detection;
- full snapshot usuwa nieobecne projekcje;
- policy tightening usuwa/redaguje istniejące dane;
- pojedynczy błąd zachowuje `400/409/429/5xx`;
- `207 Multi-Status` jest wyłącznie dla partial batch;
- każdy wynik batcha ma `status`, `code` i `retryable`.

## Storage

Dane znajdują się w `/var/lib/sirk-central`. Runtime używa fail-fast single-writer lease:

```text
/var/lib/sirk-central/.sirk-central-runtime.lock/owner.json
```

Druga instancja na tym samym file-backed storage nie uruchomi się. Active-active wymaga transakcyjnej bazy danych i distributed locking.

## Usługi Compose

Canonical stack:

```text
docker-compose.yml
docker-compose.portal-runtime.yml
--profile auth
```

Base services:

- `central` — v15 API/UI, `USER node`;
- `auth` — broker Entra, `USER node`;
- `updater-gateway` — minimalny, nieuprzywilejowany proxy jako `USER node`;
- `backup-manager` — scheduler i backup metadata;
- `caddy` — TLS i reverse proxy.

### Updater gateway

Central nigdy nie łączy się bezpośrednio z rootowym workerem:

```text
Central -> updater-gateway:8092 -> updater:8090
```

Gateway:

- ma osobny minimalny obraz bez Docker CLI, Git i tar;
- nie ma wolumenów ani host ports;
- otrzymuje wyłącznie `SIRK_UPDATER_TOKEN` i parametry proxy;
- ma exact route/host allowlist, timeout i body limit;
- przy zamkniętym maintenance zwraca `409 UPDATER_MAINTENANCE_REQUIRED`.

### Maintenance worker

Rootowy worker z Docker socket nie działa stale:

```yaml
profiles: ["maintenance"]
restart: "no"
user: "0:0"
```

Otwarcie:

```bash
sudo bash /opt/sirk-central/deploy/maintenance-up.sh
```

Zamknięcie po operacji:

```bash
sudo bash /opt/sirk-central/deploy/maintenance-down.sh
```

## Instalacja

```bash
curl -fsSL \
  https://raw.githubusercontent.com/Eris92/SIRK-Central/main/deploy/install.sh \
  -o /tmp/install-sirk-central.sh
sudo bash /tmp/install-sirk-central.sh
sudo rm -f /tmp/install-sirk-central.sh
```

Nie używaj `curl | sudo bash`. Instalator uruchamia base stack z gatewayem, bez rootowego workera.

## Testy

```bash
npm ci
npm run check:syntax
SIRK_CONCURRENCY_TEST_REQUESTS=24 npm test
npm audit --omit=dev --audit-level=high
```

VPS acceptance:

```bash
cd /opt/sirk-central
export SIRK_ACCEPTANCE_PUBLIC_URL='https://central.sirkportal.com'
bash deploy/acceptance-test.sh
```

Acceptance sprawdza single-writer lock oraz lifecycle: gateway `409` → worker maintenance → gateway `200` → worker removed → gateway `409`.

## Kod główny i walidacja

`main` jest jedyną kanoniczną gałęzią wdrożeniową. Zmiany funkcjonalne należy prowadzić przez krótkie branche i scalać dopiero po testach. Bieżący RC wymaga jeszcze pełnego CI i testów środowiskowych opisanych w `docs/CURRENT-STATUS.md`.

## SIRK Portal

Nie modyfikować repozytorium SIRK Portal w ramach zmian dotyczących Central. Integracja jest obecnie weryfikowana przez testy HTTP i symulator w repo SIRK Central.
