# SIRK Central — bieżący stan

Data aktualizacji: 2026-07-31

## Repozytorium

```text
Repo: Eris92/SIRK-Central
Branch: feat/central-production-hardening
PR: #45 (draft)
Runtime: src/server-v15.js
Version: 1.0.0-rc.24
```

Nie modyfikować repozytorium SIRK Portal. Integracja pozostaje testowana przez runtime Central i `scripts/portal-simulator.js`.

## Zamknięte problemy techniczne

### Storage i concurrency

- runtime posiada fail-fast single-writer lease w `/var/lib/sirk-central/.sirk-central-runtime.lock`;
- druga instancja na tym samym storage kończy start `RUNTIME_STORAGE_LOCKED`;
- lease zawiera owner identity i heartbeat;
- fresh malformed lock jest fail-closed, stale lock jest odzyskiwany po quarantine;
- graceful SIGTERM/SIGINT zwalnia lock;
- concurrency suite obejmuje heartbeat, ticket ingestion, command polling i terminal ACK.

### Portal commands

- cooperative cancellation jest częścią protokołu;
- queued command jest anulowany natychmiast;
- delivered/running przechodzi w `cancel_requested`;
- Portal dostaje `control: cancel` z lease i redelivery;
- `cancelled` jest ustawiane dopiero po ACK Portalu;
- Portal nie może samodzielnie anulować command bez requestu Central;
- `completed` lub `failed` może bezpiecznie wygrać race;
- terminal ACK pozostaje idempotentny.

### Tickets

- pojedynczy błędny event zwraca właściwe `400/409/429/5xx`;
- HTTP `207` jest wyłącznie dla jawnego partial batch;
- każdy wynik batcha zawiera `status`, `code` i `retryable`;
- replay ID z innym payloadem zwraca `409 TICKET_EVENT_REPLAY_CONFLICT`;
- `events` musi być tablicą, gdy pole jest obecne;
- fail-closed policy, assignment binding, redakcja i capacity protection są aktywne.

### Updater i Docker socket

Trust boundary został rozdzielony na dwie usługi:

```text
Central -> updater-gateway:8092 -> updater:8090
```

`updater-gateway`:

- działa stale jako `USER node`;
- ma minimalny obraz bez Docker CLI, Git i tar;
- nie ma wolumenów ani host ports;
- otrzymuje tylko `SIRK_UPDATER_TOKEN` i jawne ustawienia proxy;
- ma exact route/worker-host allowlist, timeout i body limit;
- gdy worker jest wyłączony, zwraca kontrolowane `409 UPDATER_MAINTENANCE_REQUIRED`.

`updater` worker:

- ma profil Compose `maintenance`;
- ma `restart: "no"`;
- jest root-equivalent przez Docker socket wyłącznie podczas maintenance window;
- `deploy/maintenance-up.sh` go uruchamia;
- `deploy/maintenance-down.sh` zatrzymuje i usuwa kontener;
- install, clean reinstall, smoke, acceptance, update i restore pozostawiają worker wyłączony po operacji.

### Deployment

Canonical stack używa zawsze:

```text
docker-compose.yml
docker-compose.portal-runtime.yml
--profile auth
```

Base services:

```text
central
auth
updater-gateway
backup-manager
caddy
```

Naprawione zostały `install.sh`, `configure-and-start.sh`, `clean-reinstall.sh`, `smoke-test.sh`, `acceptance-test.sh`, `web-update.sh` i `restore.sh`.

### Testy

Dodano:

```text
test/runtime-lock.test.js
test/portal-command-cancellation.test.js
test/ticket-event-http-semantics.test.js
test/protocol-concurrency.test.js
test/updater-gateway.test.js
```

CI i Security Audit walidują również dwa profile Compose, osobny minimalny gateway image, brak wolumenów/secrets w gatewayu oraz rootowego workera tylko w profilu maintenance.

### Synchronizacja z main

Na branch zachowano compatibility files dodane później na `main`:

```text
src/persistent-session-map.js
src/preload-hardening.js
src/server-hardened.js
src/server-production.js
test/persistent-session-map.test.js
```

Kanoniczny runtime pozostaje `src/server-v15.js`.

## Stan wykonania

Nie ma jeszcze potwierdzonego zielonego wyniku dla finalnego HEAD:

- connector GitHub nie udostępnia kompletnej listy push workflow runs;
- PR nadal raportował konflikt z `main`;
- lokalny runner nie rozwiązuje `github.com`, więc nie może wykonać `git fetch`, merge ani pełnego `npm ci`;
- wymagany jest standardowy merge commit z aktualnym `main`.

## Pozostały blocker Git

Na runnerze z działającym DNS:

```bash
cd /opt/sirk-central
git fetch origin
git checkout feat/central-production-hardening
git reset --hard origin/feat/central-production-hardening
bash scripts/sync-main.sh
npm ci
npm run check:syntax
SIRK_CONCURRENCY_TEST_REQUESTS=24 npm test
npm audit --omit=dev --audit-level=high
git push origin feat/central-production-hardening
```

`scripts/sync-main.sh` tworzy safety branch, automatycznie rozwiązuje wyłącznie oczekiwany konflikt `package.json`/`package-lock.json` i abortuje każdy inny konflikt.

## Blockery środowiskowe

Tych punktów nie można wiarygodnie zamknąć bez środowiska lub hardware:

1. pełny `deploy/acceptance-test.sh` na nieprodukcyjnym VPS;
2. destructive backup/restore drill z wymuszonym rollbackiem;
3. update/rollback drill z awarią checkout/build/start oraz potwierdzeniem, że worker po operacji jest usunięty;
4. realny YubiKey w Edge i Chrome;
5. Entra pending/approved/rejected/conflict/disabled i front-channel logout;
6. external Caddy/TLS/CSP/security headers;
7. Portal simulator z prawdziwym testowym tokenem;
8. PL/EN i responsive visual review.

## Residual risks

- file-backed stores są single-writer, nie active-active HA;
- worker podczas otwartego maintenance window pozostaje root-equivalent przez Docker socket;
- Portal-side connector Jira/ServiceDesk/GLPI nie należy do repo SIRK Central.

## Kryterium gotowości

PR pozostaje draftem do czasu integracji z `main`, zielonych workflow dla aktualnego HEAD, pełnego VPS acceptance oraz wykonania testów backup/restore, update/rollback, YubiKey, Entra, TLS i UI.
