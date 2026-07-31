# SIRK Central

SIRK Central jest centralnym, wielotenantowym management plane dla instalacji SIRK Portal.

```text
Branch: feat/central-production-hardening
PR: #45 (draft)
Runtime: src/server-v15.js
Version: 1.0.0-rc.24
```

PR pozostaje draftem do czasu zielonego CI, VPS acceptance oraz testów backup/restore, update/rollback, YubiKey i Entra.

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

Ten sam entry point jest wymagany przez `package.json`, oba Dockerfile, CI, Security Audit i acceptance test. Pliki legacy są zachowane wyłącznie dla zgodności z `main`; nie są produkcyjnym entry pointem.

## Najważniejsze mechanizmy

### Identity i RBAC

- Entra ID Authorization Code + PKCE;
- lokalny BreakGlass z Access URL;
- passkeys/WebAuthn, YubiKey i recovery codes;
- trwałe hashowane sesje z idle/absolute timeout;
- globalny browser CSRF i Origin/Sec-Fetch-Site;
- centralne blokowanie `pending`, `conflict` i `disabled`;
- separation of duties `Admin` / `SecAdmin`;
- tamper-evident audit.

### Approval Center

- jedna lub dwie niezależne decyzje;
- self-approval protection;
- exact-scope i single-use approval;
- high-risk approval zużywany dopiero przy utworzeniu command;
- retry wysokiego ryzyka wymaga nowej zgody;
- legacy approval mutations są wyłączone.

### Portal monitoring i commands

- signed heartbeat HMAC, timestamp i nonce replay protection;
- rate limiting per IP i Portal;
- access-scope filtering;
- trwała kolejka z delivery lease, ACK, progress, result i timeout;
- secret redaction i prototype pollution protection;
- cooperative cancellation:
  - `queued` → natychmiast `cancelled`,
  - `delivered/running` → `cancel_requested`,
  - Portal otrzymuje `control: "cancel"` i kończy ACK `cancelled`;
- `completed/failed` może bezpiecznie wygrać race z anulowaniem.

### Tickets

- provider-independent projection store schema v2;
- assignment-bound Tenant/Customer/Site;
- fail-closed policy `none`;
- opis/requester publikowane wyłącznie po jawnej zgodzie;
- digest replay i version conflict detection;
- full snapshot usuwa nieobecne projekcje;
- policy tightening usuwa lub redaguje istniejące dane;
- pojedynczy błędny event zachowuje status `400/409/429/5xx`;
- `207 Multi-Status` jest wyłącznie dla jawnego batcha z częściowym błędem;
- każdy element batcha ma `status`, `code` i `retryable`.

### Storage

Dane znajdują się w `/var/lib/sirk-central`. Runtime używa fail-fast single-writer lease:

```text
/var/lib/sirk-central/.sirk-central-runtime.lock/owner.json
```

Druga instancja korzystająca z tego samego file-backed storage nie uruchomi się. To blokuje silent corruption, ale nie jest active-active HA. Active-active wymaga transakcyjnej bazy danych i distributed locking.

## Usługi Compose

```text
docker-compose.yml
docker-compose.portal-runtime.yml
```

Normalny runtime:

- `central` — v15 API/UI, `USER node`;
- `auth` — broker Entra, `USER node`;
- `backup-manager` — scheduler/backup metadata;
- `caddy` — TLS i reverse proxy.

### Updater maintenance window

Updater ma Docker socket i jest root-equivalent względem hosta, dlatego nie działa stale:

```yaml
profiles: ["maintenance"]
restart: "no"
user: "0:0"
```

Otwarcie maintenance window:

```bash
sudo bash /opt/sirk-central/deploy/maintenance-up.sh
```

Po update/restore natychmiast zamknij okno:

```bash
sudo bash /opt/sirk-central/deploy/maintenance-down.sh
```

Updater nie publikuje host portu, działa w internal network, wymaga silnego bearer tokenu i ma exact host/path allowlist.

## Instalacja

```bash
curl -fsSL \
  https://raw.githubusercontent.com/Eris92/SIRK-Central/main/deploy/install.sh \
  -o /tmp/install-sirk-central.sh
sudo bash /tmp/install-sirk-central.sh
sudo rm -f /tmp/install-sirk-central.sh
```

Nie używaj `curl | sudo bash`. Instalator uruchamia stack bez uprzywilejowanego updatera.

## Testy

```bash
npm ci
npm run check:syntax
npm test
npm audit --omit=dev --audit-level=high
```

`npm run check:syntax` sprawdza JavaScript, Python oraz wszystkie skrypty shell w `deploy/` i `scripts/`.

VPS acceptance:

```bash
cd /opt/sirk-central
export SIRK_ACCEPTANCE_PUBLIC_URL='https://central.sirkportal.com'
bash deploy/acceptance-test.sh
```

Acceptance potwierdza również single-writer lock oraz cykl updatera: nieobecny → maintenance → usunięty.

## Synchronizacja z main

Gałąź ma guarded helper:

```bash
bash scripts/sync-main.sh
npm ci
npm test
git push origin feat/central-production-hardening
```

Skrypt tworzy safety branch i automatycznie rozwiązuje wyłącznie spodziewany konflikt `package.json`/`package-lock.json`. Każdy inny konflikt przerywa merge.

## Zasada dotycząca SIRK Portal

Nie modyfikować repozytorium SIRK Portal. Integracja Central↔Portal jest obecnie weryfikowana przez testy HTTP i symulator w repo SIRK Central.
