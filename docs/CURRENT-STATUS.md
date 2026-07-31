# SIRK Central — bieżący stan

Data aktualizacji: 2026-07-31

## Repozytorium

```text
Repo: Eris92/SIRK-Central
Branch: feat/central-production-hardening
PR: #45
PR state: draft
Runtime: src/server-v15.js
Version: 1.0.0-rc.21
```

Nie modyfikować repozytorium SIRK Portal. Integracja jest testowana wyłącznie przez `scripts/portal-simulator.js` i runtime SIRK Central.

## Wykonane w ostatnim audycie

### Runtime i CI

- package, lock, Docker runtime, CI i acceptance wskazują `src/server-v15.js`;
- usunięto zduplikowany workflow `central-ci.yml`, który wcześniej driftował do v2;
- `security-audit.yml` został przełączony z v14 na v15;
- CI sprawdza pełny Compose, obrazy, users, overlay i nowe testy;
- package version została ujednolicona na `1.0.0-rc.21`.

### RBAC

- centralne `identityActive()` blokuje `pending`, `conflict` i `disabled`;
- BreakGlass jest ważny wyłącznie jako lokalna built-in identity;
- pełna macierz obejmuje:
  - brak sesji,
  - Pending,
  - OperatorL1,
  - SupportL2,
  - EngineerL3,
  - Auditor,
  - Admin,
  - SecAdmin,
  - BreakGlass;
- Admin i SecAdmin mają rozdzielone obowiązki;
- SecAdmin nie wykonuje update, restore, Portal commands ani ticket changes.

### Approval Center

- naprawiono high-risk approval zużywany przed operacją;
- approval jest exact-scope i single-use;
- retry wymaga nowej zgody;
- legacy `/api/approvals` jest read-only/deprecated, mutations zwracają `410`;
- Auditor i nieaktywne identities nie mogą składać wniosków;
- self-approval pozostaje zabronione.

### Portal commands

- delivery lease i kontrolowana redelivery;
- ACK ordering i terminal-state conflict;
- payload/result secret redaction;
- prototype pollution keys są odrzucane;
- limit aktywnych poleceń per Portal;
- list/create/cancel/retry respektują access scope;
- cancel tylko przed delivery;
- poll i ACK mają rate limiting.

### Heartbeat i telemetry

- rate limiting per IP i Portal;
- podpis HMAC, timestamp i nonce replay protection;
- aktywne nonce nie są wyrzucane przy capacity;
- telemetry URL dopuszcza tylko HTTPS;
- wartości agents/RAM/CPU są walidowane i ograniczane;
- telemetry UI używa aktualnego flat schema;
- Central pokazuje wyłącznie Portale dostępne przez `accessStore`.

### Tickets

- hardened projection store schema v2;
- fail-closed default policy `none`;
- Tenant/Customer/Site pochodzą wyłącznie z Portal assignment;
- Portal nie może modyfikować `central`;
- snapshot/event ID są związane z SHA-256 payloadu;
- conflict przy tym samym timestampie i innej treści;
- full snapshot usuwa nieobecne projekcje zamiast fabrykować `closed`;
- policy tightening usuwa lub redaguje już zapisane dane;
- capacity jest fail-closed, bez silent eviction;
- Central read/write respektuje Portal access scope;
- event batches zwracają partial result przez HTTP 207;
- Portal ingestion ma rate limits.

### Auth i updater

- Entra broker ma rate limits, bounded pending OAuth state i timeouty;
- upstream Entra errors nie są zwracane klientowi;
- updater origin i path mają dokładną allowlistę;
- instalator uruchamia pełny stack z overlayem v15;
- updater jest jawną privileged trust boundary z Docker socket;
- updater nie publikuje portu hosta i działa wyłącznie w sieci internal;
- acceptance sprawdza Docker socket, healthchecks, users i ports.

### Testy przygotowane

- unit/regression stores;
- rzeczywiste HTTP tests runtime v15;
- pełna macierz RBAC;
- Portal heartbeat replay/rate limit;
- ticket snapshot/event replay;
- approval exact-scope/single-use;
- command poll/ACK ordering;
- updater path/SSRF;
- Playwright z console/page/HTTP error detection;
- Compose build/runtime/user validation;
- CodeQL, npm audit i secret scan.

## Rzeczywisty stan wykonania

Nie uzyskano jeszcze wyniku testów dla aktualnego HEAD:

- GitHub connector nie zwraca status checks ani workflow runs;
- lokalny runner nie może rozwiązać `github.com` i nie klonuje repozytorium;
- nie ma podstaw do oznaczenia testów jako zielone.

## Otwarte zadania automatyczne

1. Uzyskać rzeczywisty wynik wszystkich GitHub Actions.
2. Naprawić ewentualne syntax/unit/HTTP/Docker/Playwright failures.
3. Uruchomić pełny `deploy/acceptance-test.sh` na VPS.
4. Uruchomić Portal simulator z testowym Portal tokenem i jawnie włączoną ticket policy.
5. Wykonać load/concurrency tests dla heartbeat, commands i ticket ingestion.
6. Zweryfikować partial-event batch retry po stronie przyszłego Portalu.

## Blockery manualne

1. Backup/restore drill z kontrolą integralności danych.
2. Update/rollback drill, w tym awaria po checkout/build/start.
3. YubiKey w Edge i Chrome.
4. Entra: pending, approved, rejected, conflict i disabled.
5. Caddy/TLS/CSP/security headers z zewnętrznego klienta.
6. PL/EN.
7. Mobile, tablet i desktop visual review.
8. Test odzyskiwania przez recovery codes.
9. Weryfikacja storage permissions i retencji backupów na docelowym VPS.

## Residual risks

- updater z Docker socket jest root-equivalent względem hosta;
- file-backed stores nie obsługują multi-instance HA;
- cooperative cancellation po delivery nie jest jeszcze częścią protokołu;
- pełne HA wymaga bazy transakcyjnej i distributed locks;
- Portal-side connector do Jira/ServiceDesk/GLPI nie jest jeszcze implementowany w SIRK Portal.

## Kryterium gotowości

PR pozostaje draftem do czasu, gdy:

- wszystkie workflow są zielone na bieżącym HEAD;
- VPS acceptance przejdzie bez wyjątków;
- High/Critical nie pozostają otwarte;
- backup/restore i update/rollback zostaną wykonane;
- YubiKey i Entra zostaną sprawdzone;
- wyniki, logi i ograniczenia zostaną zapisane w dokumentacji.
