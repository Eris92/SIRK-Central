# Testy SIRK Central

## Zasada

Istnienie testu w repo nie oznacza zaliczenia. `main` jest kodem głównym, ale wersja `1.0.0-rc.25` pozostaje RC do czasu zielonego CI i testów środowiskowych dla tego samego HEAD.

## 1. Pobranie kodu

```bash
cd /opt/sirk-central
git fetch origin
git checkout main
git reset --hard origin/main
```

## 2. Testy lokalne

```bash
npm ci
npm run check:syntax
SIRK_CONCURRENCY_TEST_REQUESTS=24 npm test
npm audit --omit=dev --audit-level=high
```

`check:syntax` obejmuje shell, JavaScript, Python backup validator oraz audyt braku legacy runtime. `npm test` uruchamia ten sam audyt jako `pretest`.

## 3. Audyt legacy runtime

```bash
npm run check:legacy
```

Walidator sprawdza:

- brak alternatywnych entrypointów i preloadów;
- brak starego `start:legacy`;
- brak duplikatu persistent session map;
- brak starych helperów sekretów;
- osiągalność `server-v1.js` do `server-v14.js` z `server-v15.js`;
- brak dodatkowego nieosiągalnego pliku `server*.js`.

## 4. Security regression suite

```bash
node --test \
  test/runtime-lock.test.js \
  test/portal-command-cancellation.test.js \
  test/ticket-event-http-semantics.test.js \
  test/protocol-concurrency.test.js \
  test/updater-gateway.test.js
```

## 5. Pełny acceptance test VPS

```bash
cd /opt/sirk-central
export SIRK_ACCEPTANCE_PUBLIC_URL='https://central.sirkportal.com'
sudo bash deploy/acceptance-test.sh
```

Acceptance sprawdza między innymi:

- syntax, unit, HTTP, security i concurrency;
- canonical Compose;
- brak rootowego `updater` w base profile;
- gateway `409` przy zamkniętym maintenance;
- start workera i gateway proxy `200`;
- usunięcie workera po zamknięciu maintenance;
- readiness i runtime single-writer lock;
- TLS/CSP/security headers, jeżeli podano publiczny URL.

Finalna akceptacja nie może używać `SIRK_ACCEPTANCE_SKIP_BUILD=true` ani `SIRK_ACCEPTANCE_SKIP_LIVE=true`.

## 6. Emergency recovery

Reset BreakGlass:

```bash
sudo bash deploy/reset-breakglass-password.sh
```

Rotacja Access Key:

```bash
sudo bash deploy/rotate-access-key.sh
```

Dla obu operacji sprawdź:

1. backup `.env`;
2. zatrzymanie Central;
3. offline update security override;
4. unieważnienie lokalnych i BreakGlass sessions;
5. health po restarcie;
6. brak kontenera `updater`;
7. poprawne logowanie nowymi danymi;
8. brak działania starych danych i sesji.

## 7. Maintenance window

```bash
sudo bash deploy/maintenance-up.sh
# wykonaj zaplanowaną operację
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

Wynik ma być pusty.

## 8. Portal simulator

```bash
export SIRK_SIMULATOR_ORIGIN='https://central.sirkportal.com'
export SIRK_SIMULATOR_PORTAL_ID='<PORTAL_ID>'
export SIRK_SIMULATOR_PORTAL_TOKEN='<PORTAL_TOKEN>'
node scripts/portal-simulator.js
```

Portal musi mieć active Tenant/Customer/Site assignment oraz odpowiednią ticket policy.

## 9. Commands i cancellation

Sprawdź kolejno:

1. enqueue;
2. delivery;
3. ACK `running`;
4. cancel w Central;
5. `cancel_requested`;
6. poll z `control: "cancel"`;
7. terminal ACK `cancelled`;
8. idempotentny powtórzony ACK;
9. race `completed/failed` podczas anulowania.

## 10. Tickets

Pojedynczy event musi zachować właściwe `400/409/429/5xx` i nigdy nie zwracać `207`.

Jawny batch może zwrócić `207`, ale każdy element musi zawierać `index`, `status`, `code` i `retryable`.

## 11. RBAC i approvals

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

Sprawdź read/write, CSRF, obcy Origin, self-approval, duplicate vote, exact-scope, single-use oraz retry wymagający nowej approval.

## 12. Backup/restore i update/rollback

Wykonaj destructive backup/restore drill oraz update/rollback failure drill. Wymuś awarię checkout, build, start i restore. Po każdej ścieżce potwierdź prawidłowy base stack, komplet danych i brak workera maintenance.

## 13. YubiKey i Entra

YubiKey: Edge i Chrome, rejestracja, logowanie, recovery codes, challenge replay/expiry, wrong origin/RP ID i last-method protection.

Entra: pending, approved, rejected, conflict, disabled, zmiana roli, front-channel logout i unieważnienie sesji.

## 14. UI i TLS

Sprawdź PL/EN, dark/light, keyboard/focus, mobile/tablet, błędy API, długie i puste listy oraz wszystkie akcje.

Z zewnętrznej sieci sprawdź valid chain, HTTP→HTTPS, HSTS, CSP, X-Content-Type-Options, X-Frame-Options, Referrer-Policy, brak publicznego 8080 i WebSocket upgrade.

## 15. Raport końcowy

Zapisz HEAD, środowisko, wersje Node/Docker/browser, workflow, wyniki testów, błędy, poprawki, residual risks i decyzję: `BLOCK`, `READY FOR REVIEW` albo `READY TO DEPLOY`.
