# SIRK Central — bieżący stan

Data aktualizacji: 2026-07-31

## Repozytorium

```text
Repo: Eris92/SIRK-Central
Branch: feat/central-production-hardening
PR: #45
PR state: draft
Runtime: src/server-v15.js
Version: 1.0.0-rc.24
```

Nie modyfikować repozytorium SIRK Portal. Integracja pozostaje testowana przez runtime Central i `scripts/portal-simulator.js`.

## Zamknięte problemy techniczne

### Storage i concurrency

- aktywny runtime posiada fail-fast single-writer lease w `/var/lib/sirk-central/.sirk-central-runtime.lock`;
- drugi proces korzystający z tego samego storage kończy start kodem `RUNTIME_STORAGE_LOCKED`;
- lease ma heartbeat, owner identity i kontrolowane odzyskanie stale lock;
- uszkodzony świeży lock pozostaje fail-closed;
- uszkodzony stary lock jest odzyskiwany na podstawie `mtime`;
- graceful SIGTERM/SIGINT zwalnia lock po zamknięciu serwera;
- aktywne-active na file-backed JSON jest świadomie blokowane zamiast dopuszczać silent corruption.

### Portal commands

- cooperative cancellation jest częścią protokołu;
- queued command jest anulowany natychmiast;
- delivered/running przechodzi w `cancel_requested`;
- Portal dostaje control message `control: cancel` z lease i redelivery;
- Portal potwierdza `cancelled` dopiero po faktycznym zatrzymaniu operacji;
- Portal nie może samodzielnie ustawić `cancelled` bez żądania Central;
- `completed` lub `failed` może bezpiecznie wygrać race z anulowaniem;
- terminal ACK pozostaje idempotentny.

### Tickets

- pojedynczy błędny event zwraca właściwe `400`, `409`, `429` lub `5xx`;
- HTTP `207` jest używany wyłącznie dla jawnego batcha z częściowym wynikiem;
- każdy element batcha zawiera `status`, `code` i `retryable`;
- replay ID z innym payloadem zwraca `409 TICKET_EVENT_REPLAY_CONFLICT`;
- `events` musi być tablicą, gdy pole jest obecne;
- fail-closed policy, canonical Portal assignment, redakcja i capacity protection pozostają aktywne.

### Updater i Docker socket

- updater ma profil Compose `maintenance`;
- normalny runtime nie tworzy kontenera updatera i nie montuje Docker socket;
- updater ma `restart: "no"`;
- `deploy/maintenance-up.sh` otwiera jawne maintenance window;
- `deploy/maintenance-down.sh` zatrzymuje i usuwa kontener po operacji;
- `backup-manager` działa stale bez Docker socket;
- acceptance test sprawdza zamknięte okno, otwarcie, dostęp socket/API i ponowne zamknięcie.

### Testy

Dodano automatyczne testy:

```text
test/runtime-lock.test.js
test/portal-command-cancellation.test.js
test/ticket-event-http-semantics.test.js
test/protocol-concurrency.test.js
```

Concurrency suite obejmuje równoległe heartbeat, ticket events, command polling i terminal ACK.

### Synchronizacja z main

Na branch przywrócono pliki compatibility dodane później na `main`:

```text
src/persistent-session-map.js
src/preload-hardening.js
src/server-hardened.js
src/server-production.js
test/persistent-session-map.test.js
```

Kanoniczny runtime pozostaje `src/server-v15.js`; powyższe pliki są zachowane wyłącznie dla zgodności i bezpiecznego merge.

## Stan wykonania

Nie ma jeszcze potwierdzonego zielonego wyniku dla aktualnego HEAD:

- connector GitHub nie zwraca PR workflow runs;
- PR nadal raportuje `mergeable: false`;
- lokalny runner nie rozwiązuje `github.com`, więc nie może wykonać `git fetch/merge` ani pełnego `npm ci`;
- branch i `main` modyfikują `package.json`, dlatego wymagany jest standardowy merge commit rozwiązujący ten jeden wspólny plik.

## Pozostały blocker Git

Na runnerze z działającym DNS wykonać:

```bash
cd /opt/sirk-central
git fetch origin
git checkout feat/central-production-hardening
git merge --no-ff origin/main
```

Przy konflikcie `package.json`/`package-lock.json` zachować wersję brancha:

```bash
git checkout --ours package.json package-lock.json
git add package.json package-lock.json
git commit
npm ci
npm test
```

Nie używać `git reset --hard origin/main`, rebase ani force push bez kopii brancha.

## Blockery środowiskowe

Tych punktów nie da się wiarygodnie zamknąć statycznie ani bez dostępu do środowiska/hardware:

1. pełny `deploy/acceptance-test.sh` na nieprodukcyjnym VPS;
2. destructive backup/restore drill z rollbackiem;
3. update/rollback drill, w tym awaria build/start i updater self-recreate;
4. realny YubiKey w Edge i Chrome;
5. Entra pending/approved/rejected/conflict/disabled oraz front-channel logout;
6. external Caddy/TLS/CSP/security headers;
7. Portal simulator z prawdziwym testowym tokenem;
8. PL/EN i responsive visual review.

## Residual risks

- file-backed stores są bezpieczne tylko jako single-writer; produkcyjne active-active HA wymaga transakcyjnej bazy danych i distributed locking;
- updater podczas otwartego maintenance window nadal jest root-equivalent przez Docker socket, lecz nie działa stale;
- Portal-side connector Jira/ServiceDesk/GLPI nie jest implementowany w repo SIRK Central i wymaga późniejszej pracy w SIRK Portal.

## Kryterium gotowości

PR pozostaje draftem do czasu, gdy merge conflict zostanie rozwiązany, wszystkie workflow będą zielone na bieżącym HEAD, acceptance przejdzie bez wyjątków oraz zostaną wykonane testy VPS, YubiKey, Entra, backup/restore i update/rollback.
