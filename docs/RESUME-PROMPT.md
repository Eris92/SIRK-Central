# Polecenie wznowienia w nowym czacie

Skopiuj blok poniżej do nowego czatu.

```text
CEL: Kontynuuj autonomicznie audyt, testy i rozwój projektu SIRK Central jak coding agent.

Repozytorium:
- GitHub: Eris92/SIRK-Central
- Working branch: refactor/remove-legacy-runtime
- Draft PR: #46 do main
- Kanoniczny runtime: src/server.js
- Wersja: 1.0.0-rc.26

WAŻNE:
- Nie modyfikuj repozytorium SIRK Portal w ramach prac dotyczących Central.
- Nie scalaj PR #46 bez zielonych CI, Security Audit i UI E2E dla dokładnego finalnego HEAD.
- Nie zakładaj, że wcześniejszy zielony wynik dotyczy aktualnego commita. Najpierw pobierz HEAD PR i sprawdź workflow.
- Nie przywracaj server-v1..v15, alternatywnych entrypointów, preloadów, store'ów *-v2 ani staged runtime.
- Nie wdrażaj HA/PostgreSQL w tym etapie.

Najpierw przeczytaj:
- README.md
- docs/CURRENT-STATUS.md
- docs/ARCHITECTURE.md
- docs/PORTAL-PROTOCOL.md
- docs/TESTING.md
- docs/SECURITY-AUDIT-2026-07-31.md

Zweryfikuj:
1. package.json i główny Dockerfile wskazują src/server.js.
2. npm run check:syntax przechodzi i walidator potwierdza jeden serwer bez staged runtime.
3. Nie istnieją server-v*.js, alternatywne entrypointy ani store'y/API *-v2.
4. src/modules/portal-tunnel.js zachowuje RBAC, izolację cookies i limit body.
5. CSRF dotyczy sesji przeglądarkowej, a /api/portal/v1/* zachowuje podpis HMAC/timestamp/nonce.
6. MFA continuity jest egzekwowane wewnątrz operacji revoke.
7. deploy/reset-breakglass-password.sh i deploy/rotate-access-key.sh są kanonicznymi procedurami recovery.
8. Base stack zawiera backup-manager bez Docker socketu i z central-data tylko ro.
9. Rootowy updater nie działa poza profilem maintenance.
10. Tymczasowy workflow test-diagnostics.yml nie istnieje.

Testy lokalne:

cd /opt/sirk-central
git fetch origin
git checkout refactor/remove-legacy-runtime
git reset --hard origin/refactor/remove-legacy-runtime
npm ci
npm run check:syntax
SIRK_CONCURRENCY_TEST_REQUESTS=24 npm test
npm audit --omit=dev --audit-level=high

Po scaleniu PR przełącz komendy na main.

Acceptance VPS po zatwierdzeniu merge:

export SIRK_ACCEPTANCE_PUBLIC_URL='https://central.sirkportal.com'
sudo bash deploy/acceptance-test.sh

Opcjonalny Portal simulator:

export SIRK_ACCEPTANCE_RUN_SIMULATOR='true'
export SIRK_SIMULATOR_ORIGIN='https://central.sirkportal.com'
export SIRK_SIMULATOR_PORTAL_ID='<PORTAL_ID>'
export SIRK_SIMULATOR_PORTAL_TOKEN='<PORTAL_TOKEN>'

Zakres walidacji:
- pełne CI, Security Audit, CodeQL i UI E2E;
- RBAC dla wszystkich ról;
- CSRF, Origin, replay, rate limits, body limits, SSRF i traversal;
- Portal tunnel: connect, redirect, HTML/URL/cookie rewrite i lokalny login;
- heartbeat, telemetry, commands, ACK, cancellation i retry;
- ticket snapshots/events/policies;
- backup manager boundary;
- backup/restore i forced rollback;
- update/rollback i usunięcie workera;
- realny YubiKey w Edge i Chrome;
- Entra pending/approved/rejected/conflict/disabled/logout;
- TLS/Caddy/CSP/security headers;
- PL/EN oraz responsive UI.

Pracuj autonomicznie. Naprawiaj konkretne błędy z workflow. Aktualizuj dokumentację po zmianach. Nie twierdź, że test przeszedł bez rzeczywistego wyniku. Po zakończeniu podaj finalny HEAD, wyniki workflow, zmiany i residual risks.
```

## Krótsza wersja

```text
Kontynuuj autonomicznie SIRK Central w repo Eris92/SIRK-Central, branch refactor/remove-legacy-runtime, draft PR #46 do main. Kanoniczny runtime to src/server.js, wersja 1.0.0-rc.26. Nie dotykaj SIRK Portal, nie przywracaj legacy runtime i nie wdrażaj teraz HA. Najpierw sprawdź dokładny HEAD oraz CI, Security Audit i UI E2E. Uruchom npm run check:syntax, npm test i npm audit. Następnie domknij dokumentację i przygotuj VPS acceptance, backup/restore, update/rollback, Portal simulator, Entra, YubiKey, TLS i UI.
```
