# Testy SIRK Central

## Zasada

Istnienie testu w repo nie oznacza zaliczenia. PR #45 pozostaje draftem, dopóki rzeczywiste workflow i testy środowiskowe nie są zielone dla tego samego HEAD.

## 1. Synchronizacja z `main`

Na runnerze z działającym DNS:

```bash
cd /opt/sirk-central
git fetch origin
git checkout feat/central-production-hardening
git reset --hard origin/feat/central-production-hardening
bash scripts/sync-main.sh
```

Skrypt:

- wymaga czystego working tree i właściwej gałęzi;
- tworzy safety branch;
- wykonuje merge `origin/main` bez rebase/force push;
- automatycznie rozwiązuje wyłącznie oczekiwany konflikt `package.json`/`package-lock.json` wersją brancha;
- przerywa przy każdym innym konflikcie;
- potwierdza, że entry point nadal wskazuje `src/server-v15.js`.

Po synchronizacji:

```bash
git status --short
git log -1 --oneline
```

## 2. Testy lokalne

```bash
npm ci
npm run check:syntax
SIRK_CONCURRENCY_TEST_REQUESTS=24 npm test
npm audit --omit=dev --audit-level=high
```

`check:syntax` obejmuje:

- shell w `deploy/` i `scripts/`;
- JavaScript w `src/`, `auth/`, `updater/`, `scripts/`, `public/`, `test/`;
- Python backup archive validator.

Wymagane: zero błędów, zero High/Critical dependency vulnerabilities i brak unhandled rejection/warnings wskazujących regresję.

## 3. Security regression suite

```bash
node --test \
  test/runtime-lock.test.js \
  test/portal-command-cancellation.test.js \
  test/ticket-event-http-semantics.test.js \
  test/protocol-concurrency.test.js
```

Sprawdza:

- jeden owner file-backed storage;
- stale/malformed lock recovery;
- cooperative cancellation i race handling;
- pojedyncze `400/409` vs batch `207`;
- równoległe heartbeat, ticket events, command polling i terminal ACK.

## 4. Pełny acceptance test VPS

```bash
cd /opt/sirk-central
export SIRK_ACCEPTANCE_PUBLIC_URL='https://central.sirkportal.com'
bash deploy/acceptance-test.sh
```

Skrypt wykonuje:

- syntax, unit, HTTP, concurrency i npm audit;
- dwa renderingi Compose;
- normalny stack bez updatera;
- maintenance stack z updaterem;
- build obrazów i kontrolę users;
- health/readiness wszystkich usług;
- runtime single-writer owner file;
- internal SSO logout contract;
- security options i brak nieautoryzowanych host ports;
- maintenance lifecycle: updater absent → start → socket/API test → stop/remove;
- external TLS/CSP/security headers, gdy podano URL.

Nie ustawiaj `SIRK_ACCEPTANCE_SKIP_BUILD=true` ani `SIRK_ACCEPTANCE_SKIP_LIVE=true` dla finalnej akceptacji.

## 5. Maintenance window

Poza acceptance updater nie może działać stale.

```bash
sudo bash deploy/maintenance-up.sh
# wykonaj dokładnie zaplanowaną operację
sudo bash deploy/maintenance-down.sh
```

Weryfikacja:

```bash
docker ps --format '{{.Names}}' | grep updater && exit 1 || true
```

Po zamknięciu nie może istnieć running updater z zamontowanym Docker socket.

## 6. Portal simulator

```bash
export SIRK_SIMULATOR_ORIGIN='https://central.sirkportal.com'
export SIRK_SIMULATOR_PORTAL_ID='<PORTAL_ID>'
export SIRK_SIMULATOR_PORTAL_TOKEN='<PORTAL_TOKEN>'
node scripts/portal-simulator.js
```

Portal musi mieć active Tenant/Customer/Site assignment i ticket policy inną niż `none`.

Sprawdź heartbeat, telemetrykę, snapshot/event, command delivery, ACK i audit. Negatywnie: zły token/HMAC/nonce/timestamp, obcy Portal ACK, replay digest conflict, body limit i rate limit.

## 7. Cooperative cancellation manual test

1. Utwórz command i pobierz go przez Portal.
2. Ustaw ACK `running`.
3. W Central wybierz cancel.
4. Potwierdź stan `cancel_requested`.
5. Poll Portalu musi zwrócić ten sam command z `control: "cancel"`.
6. Portal zatrzymuje operację i wysyła `cancelled`.
7. Powtórzony identyczny terminal ACK ma być idempotentny.
8. `cancelled` bez wcześniejszego request ma zwrócić `409 COMMAND_CANCEL_NOT_REQUESTED`.
9. Sprawdź race, gdzie operacja zdążyła zwrócić `completed` albo `failed`.

## 8. Ticket event semantics

Pojedynczy event:

- invalid schema/type → 400;
- replay z innym payloadem → 409;
- rate limit → 429;
- transient server error → 5xx;
- nigdy 207.

Jawny batch:

- `events` musi być tablicą;
- partial failure → 207;
- każdy wynik ma `index`, `status`, `code`, `retryable`;
- ponawiaj wyłącznie elementy `retryable: true`.

## 9. Approval Center i RBAC

Role:

```text
brak sesji
Pending
OperatorL1
SupportL2
EngineerL3
Auditor
Admin
SecAdmin
BreakGlass
```

Sprawdź wszystkie istotne read/write endpointy, CSRF, obcy Origin, self-approval, drugi głos tej samej identity, exact-scope, single-use oraz retry wymagający nowej high-risk approval.

## 10. Backup/restore drill

Wyłącznie na środowisku testowym:

1. utwórz znany dataset;
2. backup + checksum + archive validation;
3. zmień dane;
4. restore;
5. `/readyz` i integralność wszystkich store;
6. permissions 0600/0700;
7. wymuś awarię restore i potwierdź safety-backup rollback;
8. po operacji zamknij maintenance window;
9. potwierdź audit.

## 11. Update/rollback drill

1. zapisz HEAD i wersję;
2. otwórz maintenance window;
3. update do kontrolowanego commita;
4. sprawdź build, health, UI, dane i audit;
5. rollback;
6. zasymuluj awarię checkout/build/start;
7. potwierdź data rollback i updater self-recreate;
8. zamknij maintenance window.

## 12. YubiKey/BreakGlass

Edge i Chrome:

- rejestracja pierwszego passkey i YubiKey;
- logowanie passkey/YubiKey;
- recovery code i jednorazowość;
- rotacja codes;
- próba usunięcia ostatniej metody;
- signature counter;
- wrong origin/RP ID;
- expired/replayed challenge.

## 13. Entra

- właściwy i inny dozwolony tenant;
- konto bez roli;
- standard role;
- Admin/SecAdmin pending;
- approve/reject;
- role conflict i disabled;
- logout oraz signed front-channel logout;
- unieważnienie sesji po zmianie roli.

## 14. UI i TLS

Rozdzielczości: 1920x1080, 1366x768, tablet, telefon. Sprawdź PL/EN, keyboard/focus, contrast, długie/puste/duże listy, error/loading, dialogs, wszystkie buttons i CSP.

Z zewnętrznej sieci sprawdź valid chain, HTTP→HTTPS, HSTS, CSP, X-Content-Type-Options, X-Frame-Options, Referrer-Policy, brak portu 8080 i poprawny WebSocket upgrade.

## 15. GitHub Actions

Wymagane zielone:

- CI;
- UI E2E;
- Security Audit;
- CodeQL;
- branch protection checks.

Po naprawie konfliktu z `main` wypchnij merge commit:

```bash
git push origin feat/central-production-hardening
```

Nie oznaczaj PR jako ready, jeśli statusy nie dotyczą aktualnego HEAD.

## 16. Raport końcowy

Zapisz HEAD, środowisko, wersje Node/Docker/browser, wynik każdego bloku, workflow/artifacts, błędy, poprawki, zaakceptowane ryzyka i decyzję: `BLOCK`, `READY FOR REVIEW` albo `READY TO DEPLOY`.
