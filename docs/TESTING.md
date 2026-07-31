# Testy SIRK Central

## Zasada

Istnienie testu w repo nie oznacza zaliczenia. PR #45 pozostaje draftem, dopóki rzeczywiste workflow i testy środowiskowe nie są zielone dla tego samego HEAD.

## 1. Synchronizacja z `main`

```bash
cd /opt/sirk-central
git fetch origin
git checkout feat/central-production-hardening
git reset --hard origin/feat/central-production-hardening
bash scripts/sync-main.sh
```

Skrypt wymaga czystego working tree, tworzy safety branch, wykonuje merge `origin/main`, automatycznie rozwiązuje wyłącznie oczekiwany konflikt `package.json`/`package-lock.json` wersją brancha i przerywa przy każdym innym konflikcie.

## 2. Testy lokalne

```bash
npm ci
npm run check:syntax
SIRK_CONCURRENCY_TEST_REQUESTS=24 npm test
npm audit --omit=dev --audit-level=high
```

`check:syntax` obejmuje shell w `deploy/` i `scripts/`, JavaScript oraz Python backup validator.

## 3. Security regression suite

```bash
node --test \
  test/runtime-lock.test.js \
  test/portal-command-cancellation.test.js \
  test/ticket-event-http-semantics.test.js \
  test/protocol-concurrency.test.js \
  test/updater-gateway.test.js
```

Sprawdza single-writer lease, stale/malformed lock recovery, cooperative cancellation, single-event `400/409` vs batch `207`, równoległy protokół oraz izolację gateway/worker.

## 4. Pełny acceptance test VPS

```bash
cd /opt/sirk-central
export SIRK_ACCEPTANCE_PUBLIC_URL='https://central.sirkportal.com'
bash deploy/acceptance-test.sh
```

Acceptance wykonuje:

- syntax, unit, HTTP, security, concurrency i npm audit;
- base Compose z `central/auth/updater-gateway/backup-manager/caddy`;
- potwierdzenie braku rootowego `updater` w base profile;
- maintenance Compose z workerem;
- build i user/image checks;
- readiness i runtime single-writer owner;
- gateway `409 UPDATER_MAINTENANCE_REQUIRED` przy zamkniętym workerze;
- otwarcie maintenance, Docker socket check i gateway proxy `200`;
- usunięcie workera i ponowne gateway `409`;
- external TLS/CSP/security headers, jeśli podano URL.

Finalna akceptacja nie może używać `SIRK_ACCEPTANCE_SKIP_BUILD=true` ani `SIRK_ACCEPTANCE_SKIP_LIVE=true`.

## 5. Maintenance window

```bash
sudo bash deploy/maintenance-up.sh
# wykonaj dokładnie zaplanowaną operację
sudo bash deploy/maintenance-down.sh
```

Po zamknięciu:

```bash
docker compose \
  -f docker-compose.yml \
  -f docker-compose.portal-runtime.yml \
  --profile auth \
  --profile maintenance \
  ps -q updater
```

Wynik ma być pusty. `updater-gateway` pozostaje healthy i dla chronionych tras zwraca `409 UPDATER_MAINTENANCE_REQUIRED`.

## 6. Portal simulator

```bash
export SIRK_SIMULATOR_ORIGIN='https://central.sirkportal.com'
export SIRK_SIMULATOR_PORTAL_ID='<PORTAL_ID>'
export SIRK_SIMULATOR_PORTAL_TOKEN='<PORTAL_TOKEN>'
node scripts/portal-simulator.js
```

Portal musi mieć active Tenant/Customer/Site assignment i ticket policy inną niż `none`.

## 7. Cooperative cancellation

1. Utwórz command i pobierz go przez Portal.
2. Wyślij ACK `running`.
3. W Central wybierz cancel.
4. Potwierdź `cancel_requested`.
5. Poll Portalu ma zwrócić `control: "cancel"`.
6. Portal zatrzymuje operację i wysyła `cancelled`.
7. Powtórzony identyczny terminal ACK jest idempotentny.
8. `cancelled` bez requestu zwraca `409 COMMAND_CANCEL_NOT_REQUESTED`.
9. Sprawdź race `completed/failed` podczas anulowania.

## 8. Ticket event semantics

Pojedynczy event:

- invalid schema/type → 400;
- replay z innym payloadem → 409;
- rate limit → 429;
- transient error → 5xx;
- nigdy 207.

Jawny batch:

- `events` musi być tablicą;
- partial failure → 207;
- każdy wynik ma `index`, `status`, `code`, `retryable`;
- ponawiaj wyłącznie `retryable: true`.

## 9. Approval Center i RBAC

Przejdź role:

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

Sprawdź read/write endpointy, CSRF, obcy Origin, self-approval, duplicate vote, exact-scope, single-use i retry wymagający nowej high-risk approval.

## 10. Backup/restore drill

Na środowisku testowym:

1. utwórz znany dataset;
2. backup + checksum + archive validation;
3. zmień dane;
4. otwórz maintenance i wykonaj restore;
5. sprawdź `/readyz`, dane i permissions;
6. wymuś błąd restore i potwierdź safety rollback;
7. potwierdź, że base stack zawiera gateway, a worker jest usunięty;
8. sprawdź audit.

## 11. Update/rollback drill

1. zapisz HEAD i wersję;
2. otwórz maintenance;
3. update do kontrolowanego commita;
4. sprawdź build, health, UI, dane i audit;
5. wykonaj rollback;
6. zasymuluj awarię checkout/build/start;
7. potwierdź data rollback i prawidłowy base stack z gatewayem;
8. wykonaj `maintenance-down.sh` i potwierdź brak workera.

## 12. YubiKey/BreakGlass

Edge i Chrome: rejestracja passkey/YubiKey, login, recovery code, jednorazowość, rotacja, last-method protection, signature counter, wrong origin/RP ID i challenge replay/expiry.

## 13. Entra

Sprawdź właściwy/inny dozwolony tenant, konto bez roli, standard role, Admin/SecAdmin pending, approve/reject, conflict, disabled, logout/front-channel logout i session revocation.

## 14. UI i TLS

Rozdzielczości: 1920x1080, 1366x768, tablet, telefon. Sprawdź PL/EN, keyboard/focus, contrast, loading/error, długie/puste/duże listy, wszystkie buttons oraz maintenance-required state bez retry storm.

Z zewnętrznej sieci sprawdź valid chain, HTTP→HTTPS, HSTS, CSP, X-Content-Type-Options, X-Frame-Options, Referrer-Policy, brak portu 8080 i WebSocket upgrade.

## 15. GitHub Actions

Wymagane zielone: CI, UI E2E, Security Audit, CodeQL i branch protection checks dla aktualnego HEAD.

```bash
git push origin feat/central-production-hardening
```

## 16. Raport końcowy

Zapisz HEAD, środowisko, wersje Node/Docker/browser, wyniki, workflow/artifacts, błędy, poprawki, residual risks i decyzję: `BLOCK`, `READY FOR REVIEW` albo `READY TO DEPLOY`.
