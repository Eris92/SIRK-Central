# SIRK Central — bieżący stan

Data aktualizacji: 2026-07-31

## Repozytorium

```text
Repo: Eris92/SIRK-Central
Branch: main
Runtime: src/server-v15.js
Version: 1.0.0-rc.25
```

`main` jest kanoniczną gałęzią wdrożeniową. Repozytorium SIRK Portal nie zostało zmodyfikowane.

## Canonical runtime

Jedynym entrypointem jest `src/server-v15.js`.

Usunięto nieużywany równoległy runtime i jego zależności:

```text
src/entry.js
src/server.js
src/preload-api.js
src/preload-hardening.js
src/server-hardened.js
src/server-production.js
src/persistent-session-map.js
test/persistent-session-map.test.js
```

Usunięto również alternatywne ścieżki operatorskie:

```text
deploy/reset-admin-password.sh
scripts/hash-password.js
scripts/generate-access-key.js
package script: start:legacy
```

Pliki `src/server-v1.js` do `src/server-v14.js` pozostają, ponieważ są aktywnymi warstwami importowanymi przez `server-v15.js`. Nie są osobnymi wdrażanymi runtime.

`scripts/validate-no-legacy-runtime.js`:

- blokuje powrót usuniętych entrypointów i helperów;
- sprawdza `package.json`;
- buduje statyczny graf lokalnych `require()`;
- potwierdza osiągalność warstw v1-v14 z v15;
- odrzuca każdy dodatkowy, nieosiągalny plik `server*.js`.

Audyt działa w `npm run check:syntax` oraz jako `pretest` dla `npm test`.

## Optymalizacja obrazu

Dodano `.dockerignore`, który wyklucza z build context między innymi:

- `.git` i `.github`;
- dokumentację i testy;
- raporty Playwright/coverage;
- lokalne `.env` i katalog danych;
- archiwa, logi i lokalną stronę montowaną z hosta.

Zmniejsza to build context i ogranicza ryzyko przypadkowego dołączenia danych lokalnych do obrazu.

## Emergency recovery

Kanoniczne procedury:

```text
deploy/reset-breakglass-password.sh
deploy/rotate-access-key.sh
```

Rotacja Access Key została przebudowana i teraz:

- używa obu canonical Compose files;
- generuje klucz i hash w odizolowanym kontenerze;
- aktualizuje `.env` atomowo z backupem;
- zatrzymuje Central przed zmianą danych;
- wykonuje offline update przez `apply-emergency-security-reset.js`;
- unieważnia lokalne i BreakGlass sessions;
- wykonuje health check po restarcie;
- sprawdza, że rootowy updater nie pozostał uruchomiony;
- pokazuje nowy Access Key dokładnie raz.

Stary helper przyjmujący widoczne hasło został usunięty.

## Storage i concurrency

- fail-fast single-writer lease w `/var/lib/sirk-central/.sirk-central-runtime.lock`;
- druga instancja na tym samym storage kończy start `RUNTIME_STORAGE_LOCKED`;
- heartbeat i owner identity;
- fresh malformed lock jest fail-closed;
- stale lock jest odzyskiwany po quarantine;
- graceful shutdown zwalnia lease;
- concurrency suite obejmuje heartbeat, tickets, command polling i ACK.

## Portal commands

- trwała kolejka z delivery lease;
- ACK ordering oraz idempotent terminal ACK;
- `queued` może zostać anulowany natychmiast;
- `delivered/running` przechodzi w `cancel_requested`;
- Portal otrzymuje `control: cancel`;
- `completed` lub `failed` może bezpiecznie wygrać race.

## Tickets

- provider-independent projection schema v2;
- canonical Tenant/Customer/Site assignment;
- fail-closed publication policy;
- snapshot i event ingestion;
- digest-bound replay protection;
- version/order conflict oraz capacity protection;
- właściwe `400/409/429/5xx` dla pojedynczego eventu;
- `207` tylko dla jawnego partial batch.

## Updater trust split

```text
Central -> updater-gateway:8092 -> updater:8090
```

`updater-gateway` działa stale jako nieuprzywilejowany `USER node`, bez Docker socket, wolumenów i host ports.

`updater` działa wyłącznie w profilu `maintenance`, jako jawny root/Docker-socket trust boundary, z `restart: "no"`.

## Test instalatora

`test/installer.test.js` został zaktualizowany. Usunięto stare asercje oczekujące `reset-admin-password.sh` i legacy `configure-production.js` w helperach recovery.

Test sprawdza teraz:

- canonical Compose;
- właściwy `server-v15.js` w obrazie;
- offline reset BreakGlass;
- transakcyjną rotację Access Key;
- health check;
- brak workera poza maintenance.

## Walidacja do wykonania

Kod nie ma jeszcze potwierdzonego zielonego wyniku dla finalnego HEAD po cleanupie.

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

1. `deploy/acceptance-test.sh` na nieprodukcyjnym VPS;
2. destructive backup/restore z forced rollback;
3. update/rollback failure drill;
4. realny YubiKey w Edge i Chrome;
5. pełny workflow Entra;
6. Portal simulator z prawdziwym tokenem;
7. external TLS/Caddy/CSP/security headers;
8. PL/EN i responsive visual review.

## Residual risks

- file-backed stores są single-writer, nie active-active HA;
- aktywny runtime nadal jest warstwowo złożony z modułów v1-v15; nie są to martwe pliki, ale późniejsza konsolidacja routerów może dodatkowo uprościć profil requestów;
- worker maintenance pozostaje root-equivalent podczas otwartego okna;
- konektory Jira/ServiceDesk/GLPI należą do repo SIRK Portal;
- finalny HEAD wymaga zielonego CI i walidacji środowiskowej.
