# SIRK Central — audyt bezpieczeństwa i gotowości

Data: 2026-07-31  
Branch: `feat/central-production-hardening`  
PR: #45 (draft)  
Runtime: `src/server.js`  
Version: `1.0.0-rc.24`

## Decyzja

**CONDITIONAL / NOT READY FOR PRODUCTION.**

Pozostałe znane problemy techniczne zostały naprawione w kodzie i testach, ale wynik nie jest produkcyjnie potwierdzony bez merge z aktualnym `main`, zielonych GitHub Actions i testów środowiskowych.

## Naprawione problemy krytyczne/wysokie

- high-risk approval jest exact-scope, single-use i zużywany dopiero przy utworzeniu command;
- retry `update/restart/diagnostics` wymaga nowej zgody;
- identity `pending/conflict/disabled` nie otrzymuje uprawnień;
- Portal commands/tickets/telemetry respektują access scope;
- Tenant/Customer/Site dla ticketów pochodzi z canonical Portal assignment;
- ticket publication defaults są fail-closed;
- event/cursor replay jest związany z digestem payloadu;
- legacy approval mutations są wyłączone;
- updater path/origin ma exact allowlist;
- publiczny internal SSO logout relay jest ukryty przez Caddy;
- backup archives mają checksum/manifest/path/type validation i transactional rollback.

## Naprawione problemy z ostatniej iteracji

### File-backed storage

Ryzyko multi-writer silent corruption zostało zamknięte przez runtime single-writer lease:

```text
/var/lib/sirk-central/.sirk-central-runtime.lock/owner.json
```

Drugi runtime na tym samym storage nie startuje. Fresh malformed lock jest fail-closed; stale lock jest odzyskiwany po quarantine. Wyłączenie locka jest zabronione w production.

### Command cancellation

Wprowadzono cooperative cancellation:

```text
queued -> cancelled
delivered/running -> cancel_requested -> cancelled
```

Portal dostaje idempotentny control message `control: "cancel"`. Central nie deklaruje `cancelled` przed ACK. Portal nie może samodzielnie anulować command bez requestu Central. `completed/failed` może wygrać race.

### Ticket HTTP semantics

- pojedynczy event zachowuje właściwy `400/409/429/5xx`;
- HTTP `207` dotyczy wyłącznie jawnego partial batch;
- per-item wynik zawiera `status`, `code` i `retryable`;
- replay z innym payloadem zwraca `409 TICKET_EVENT_REPLAY_CONFLICT`.

### Docker socket

Updater nie jest stale uruchomiony:

```yaml
profiles: ["maintenance"]
restart: "no"
user: "0:0"
```

Normalny stack nie tworzy kontenera updatera. Jawne maintenance window otwierają/zamykają `deploy/maintenance-up.sh` i `deploy/maintenance-down.sh`. Acceptance sprawdza brak updatera przed i po operacji.

### Concurrency

Dodano deterministyczny suite dla równoległych heartbeat, ticket events, command polling i terminal ACK oraz testy runtime lease/cancellation/event semantics.

## Mechanizmy obecne

- hashowane persistent sessions z idle/absolute expiry;
- `HttpOnly`, `Secure`, `SameSite`;
- CSRF + Origin + Sec-Fetch-Site;
- login/Portal/Entra rate limiting;
- WebAuthn ES256/P-256, UP/UV, challenge binding i replay protection;
- scrypt recovery codes;
- RBAC, separation of duties i self-approval protection;
- tamper-evident audit;
- signed heartbeat HMAC/timestamp/nonce;
- zamknięta allowlista command types, bez arbitrary shell;
- payload/result secret redaction i prototype pollution protection;
- ticket privacy policies, ordering, replay i capacity fail-closed;
- non-root Central/Auth, dropped capabilities i no-new-privileges;
- updater internal-only, maintenance-only i bez host port;
- npm audit, SBOM, secret scan i CodeQL.

## Otwarte ryzyka i ograniczenia

### Wymagające środowiska

- brak potwierdzonego wyniku Actions dla finalnego HEAD;
- PR nadal ma konflikt z `main` w package metadata;
- brak wykonanego VPS acceptance;
- brak destructive restore/rollback drill;
- brak update/rollback drill z updater self-recreate;
- brak realnego YubiKey Edge/Chrome;
- brak pełnego Entra pending/conflict/disabled/logout workflow;
- brak external TLS/CSP validation;
- brak finalnego PL/EN/responsive review.

### Residual architectural risk

- file-backed stores są single-writer, nie active-active HA;
- updater w czasie otwartego maintenance window jest root-equivalent przez Docker socket;
- Portal-side Jira/ServiceDesk/GLPI connector nie należy do tego repo i nie jest jeszcze wdrożony.

## Blockery merge

- branch nie zawiera aktualnego `main`;
- dowolny czerwony required workflow;
- High/Critical dependency lub CodeQL issue bez wyjątku;
- nieudany acceptance, backup/restore lub update/rollback;
- naruszenie Portal/Tenant isolation;
- high-risk command bez nowej zgody lub reuse approval;
- unsigned/replayed heartbeat accepted;
- command cancellation deklarowana przed Portal ACK;
- nieprecyzyjny single-event HTTP 207;
- running updater poza maintenance window;
- brak działającego BreakGlass MFA.

## Wymagane następne kroki

```bash
cd /opt/sirk-central
bash scripts/sync-main.sh
npm ci
npm run check:syntax
SIRK_CONCURRENCY_TEST_REQUESTS=24 npm test
npm audit --omit=dev --audit-level=high
git push origin feat/central-production-hardening
```

Następnie uruchomić `deploy/acceptance-test.sh` na kontrolowanym VPS i wykonać pełną listę z `docs/TESTING.md`.
