# SIRK Central — bieżący stan

Data aktualizacji: 2026-07-31

## Repozytorium

```text
Repo: Eris92/SIRK-Central
Branch: main
Runtime: src/server-v15.js
Version: 1.0.0-rc.25
```

`main` jest kanoniczną gałęzią wdrożeniową. Nie modyfikować repozytorium SIRK Portal w ramach zmian dotyczących Central. Integracja pozostaje testowana przez runtime Central i `scripts/portal-simulator.js`.

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

Naprawione zostały `install.sh`, `configure-and-start.sh`, `clean-reinstall.sh`, `smoke-test.sh`, `acceptance-test.sh`, `web-update.sh`, `update.sh`, `configure-auth.sh`, `bootstrap-ubuntu.sh` i `restore.sh`.

### Emergency recovery

- kanoniczny reset hasła znajduje się w `deploy/reset-breakglass-password.sh`;
- stary `deploy/reset-admin-password.sh` jest wyłącznie wrapperem do kanonicznej procedury;
- hasło jest hashowane w odizolowanym kontenerze i nie trafia do argumentów procesu;
- `.env` jest aktualizowany atomowo z backupem i walidacją Compose;
- lokalne i BreakGlass sessions są unieważniane offline przed publikacją nowych credentials;
- po operacji Central musi przejść health check;
- uprzywilejowany updater nie może pozostać uruchomiony.

### Testy przygotowane w repo

Dodano między innymi:

```text
test/runtime-lock.test.js
test/portal-command-cancellation.test.js
test/ticket-event-http-semantics.test.js
test/protocol-concurrency.test.js
test/updater-gateway.test.js
test/emergency-security-reset.test.js
```

CI i Security Audit walidują również dwa profile Compose, osobny minimalny gateway image, brak wolumenów/secrets w gatewayu oraz rootowego workera tylko w profilu maintenance.

## Stan wykonania

Kod został ujednolicony jako `main`, a kanoniczny runtime pozostaje `src/server-v15.js`. Wersja `1.0.0-rc.25` nie jest jeszcze oznaczona jako produkcyjnie zweryfikowana.

Nie ma jeszcze potwierdzonego zielonego wyniku dla finalnego HEAD. Integracja kodu z `main` nie zastępuje testów CI ani acceptance na rzeczywistym VPS.

## Walidacja do wykonania wieczorem

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

Następnie:

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
- Portal-side connector Jira/ServiceDesk/GLPI nie należy do repo SIRK Central;
- finalny HEAD wymaga jeszcze pełnego zielonego CI i walidacji środowiskowej.

## Kryterium gotowości produkcyjnej

`main` jest kodem głównym, ale wersję można oznaczyć jako produkcyjną dopiero po zielonych workflow, pełnym VPS acceptance oraz testach backup/restore, update/rollback, YubiKey, Entra, TLS i UI.
