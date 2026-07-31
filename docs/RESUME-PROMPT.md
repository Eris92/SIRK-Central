# Polecenie wznowienia w nowym czacie

Skopiuj blok poniżej do nowego czatu.

```text
CEL: Kontynuuj autonomicznie audyt, testy i rozwój projektu SIRK Central jak coding agent.

Repozytorium:
- GitHub: Eris92/SIRK-Central
- Branch: main
- Kanoniczny runtime: src/server-v15.js
- Wersja: 1.0.0-rc.25

WAŻNE:
- Nie modyfikuj repozytorium SIRK Portal w ramach prac dotyczących Central.
- Nie zakładaj, że testy przeszły. Najpierw sprawdź rzeczywiste workflow i aktualny HEAD main.
- Nie przywracaj usuniętych alternatywnych entrypointów, preloadów ani helperów sekretów.

Najpierw przeczytaj:
- README.md
- docs/CURRENT-STATUS.md
- docs/ARCHITECTURE.md
- docs/PORTAL-PROTOCOL.md
- docs/TESTING.md
- docs/SECURITY-AUDIT-2026-07-31.md

Zweryfikuj:
1. package.json, Dockerfile i Dockerfile.portal-runtime wskazują src/server-v15.js.
2. npm run check:legacy przechodzi.
3. Nie istnieją alternatywne entrypointy: src/entry.js, src/server.js, preloady i stare wrappery runtime.
4. deploy/reset-breakglass-password.sh i deploy/rotate-access-key.sh są jedynymi procedurami recovery.
5. Rootowy updater nie działa poza maintenance.

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

Opcjonalny Portal simulator:

export SIRK_ACCEPTANCE_RUN_SIMULATOR='true'
export SIRK_SIMULATOR_ORIGIN='https://central.sirkportal.com'
export SIRK_SIMULATOR_PORTAL_ID='<PORTAL_ID>'
export SIRK_SIMULATOR_PORTAL_TOKEN='<PORTAL_TOKEN>'

Zakres walidacji:
- pełne CI, Security Audit, CodeQL i UI E2E;
- RBAC dla wszystkich ról;
- CSRF, Origin, replay, rate limits, body limits, SSRF i traversal;
- heartbeat, telemetry, commands, ACK, cancellation i retry;
- ticket snapshots/events/policies;
- backup/restore i forced rollback;
- update/rollback i usunięcie workera;
- realny YubiKey w Edge i Chrome;
- Entra pending/approved/rejected/conflict/disabled/logout;
- TLS/Caddy/CSP/security headers;
- PL/EN oraz responsive UI.

Pracuj autonomicznie. Aktualizuj dokumentację po zmianach. Nie twierdź, że test przeszedł bez rzeczywistego wyniku. Po zakończeniu podaj HEAD, commity, wyniki, błędy i residual risks.
```

## Krótsza wersja

```text
Kontynuuj autonomicznie SIRK Central z repo Eris92/SIRK-Central na main. Kanoniczny runtime to src/server-v15.js, wersja 1.0.0-rc.25. Przeczytaj README i docs/CURRENT-STATUS.md. Nie dotykaj repo SIRK Portal. Najpierw sprawdź workflow i uruchom npm run check:syntax, npm test oraz npm audit. Nie przywracaj usuniętego legacy runtime. Następnie wykonaj VPS acceptance, backup/restore, update/rollback, Portal simulator, Entra, YubiKey, TLS i UI.
```
