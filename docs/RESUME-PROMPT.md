# Polecenie wznowienia w nowym czacie

Skopiuj blok poniżej do nowego czatu.

```text
CEL: Kontynuuj autonomicznie testy, hardening i rozwój projektu SIRK Central jak coding agent.

Repozytorium:
- GitHub: Eris92/SIRK-Central
- Canonical branch: main
- Kanoniczny runtime: src/server.js
- Wersja: 1.0.0-rc.26
- Legacy refactor PR #46: merged
- Integration commit: 69d17b1719faa723619df2ac8d7a74959f754bab

WAŻNE:
- Pracuj wyłącznie na aktualnym main lub na nowej krótkiej gałęzi utworzonej z aktualnego main.
- Nie modyfikuj repozytorium SIRK Portal w ramach prac dotyczących Central.
- Nie przywracaj server-v1..v15, alternatywnych entrypointów, preloadów, store'ów *-v2, alternatywnego Compose ani staged runtime.
- Nie wdrażaj HA/PostgreSQL w tym etapie.
- Nie opieraj wyniku na workflow ze starego commita. Dla każdej zmiany sprawdź dokładny HEAD i odpowiadające mu CI, Security Audit oraz UI E2E.
- Nie uznawaj wersji 1.0.0 za gotową bez rzeczywistych testów środowiskowych.

Najpierw przeczytaj:
- README.md
- docs/CURRENT-STATUS.md
- docs/ARCHITECTURE.md
- docs/PORTAL-PROTOCOL.md
- docs/TESTING.md
- docs/SECURITY-AUDIT-2026-07-31.md

Zweryfikuj aktualny main:
1. package.json i główny Dockerfile wskazują src/server.js.
2. npm run check:syntax przechodzi i walidator potwierdza jeden serwer bez staged runtime.
3. Nie istnieją server-v*.js, alternatywne entrypointy ani store'y/API *-v2.
4. src/modules/portal-tunnel.js zachowuje RBAC, izolację cookies i limit body.
5. CSRF dotyczy sesji przeglądarkowej, a /api/portal/v1/* zachowuje podpis HMAC/timestamp/nonce.
6. MFA continuity jest egzekwowane wewnątrz operacji revoke.
7. deploy/reset-breakglass-password.sh i deploy/rotate-access-key.sh są kanonicznymi procedurami recovery.
8. Base stack zawiera backup-manager bez Docker socketu i z central-data tylko ro.
9. Rootowy updater nie działa poza profilem maintenance.
10. Tymczasowe workflow diagnostyczne i historyczne overlaye deploymentu nie istnieją.

Testy lokalne:

cd /opt/sirk-central
git fetch origin
git checkout main
git reset --hard origin/main
npm ci
npm run check:syntax
SIRK_CONCURRENCY_TEST_REQUESTS=24 npm test
npm audit --omit=dev --audit-level=high

Acceptance VPS:

export SIRK_ACCEPTANCE_PUBLIC_URL='https://central.sirkportal.com'
sudo bash deploy/acceptance-test.sh

Portal simulator:

export SIRK_ACCEPTANCE_RUN_SIMULATOR='true'
export SIRK_SIMULATOR_ORIGIN='https://central.sirkportal.com'
export SIRK_SIMULATOR_PORTAL_ID='<PORTAL_ID>'
export SIRK_SIMULATOR_PORTAL_TOKEN='<PORTAL_TOKEN>'

Zakres walidacji:
- pełne CI, Security Audit, CodeQL i UI E2E dla aktualnego HEAD;
- RBAC dla wszystkich ról;
- CSRF, Origin, replay, rate limits, body limits, SSRF i traversal;
- Portal tunnel: connect, redirect, HTML/URL/cookie rewrite i lokalny login;
- heartbeat, telemetry, commands, ACK, cancellation i retry;
- ticket snapshots/events/policies;
- backup manager boundary;
- destructive backup/restore i forced rollback;
- update/rollback failure drill oraz usunięcie maintenance workera;
- realny YubiKey w Edge i Chrome;
- Entra pending/approved/rejected/conflict/disabled/logout;
- TLS/Caddy/CSP/security headers;
- PL/EN oraz responsive UI.

Pracuj autonomicznie. Naprawiaj konkretne błędy z testów i workflow. Aktualizuj dokumentację po zmianach. Nie twierdź, że test przeszedł bez rzeczywistego wyniku. Po zakończeniu podaj finalny HEAD, wyniki workflow, zmiany i residual risks.
```

## Krótsza wersja

```text
Kontynuuj autonomicznie SIRK Central w repo Eris92/SIRK-Central z aktualnego main. Kanoniczny runtime to src/server.js, wersja 1.0.0-rc.26, a PR #46 usuwający legacy został scalony. Nie dotykaj SIRK Portal, nie przywracaj legacy runtime i nie wdrażaj teraz HA. Najpierw pobierz aktualny main, sprawdź dokładny HEAD, uruchom npm run check:syntax, npm test i npm audit, a następnie wykonaj VPS acceptance, backup/restore, update/rollback, Portal simulator, Entra, YubiKey, TLS i visual review UI. Poprawiaj wyłącznie błędy potwierdzone przez aktualne testy.
```
