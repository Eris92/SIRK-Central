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
- Runtime commit z zaliczonym VPS acceptance: 8d35cab995734606b0fe8811735022ffd90c20eb
- Acceptance log na VPS: /root/sirk-central-acceptance-final-20260801-112059.log

STAN POTWIERDZONY 2026-08-01:
- 62/62 pliki testowe Node przeszły;
- npm audit dla zależności produkcyjnych: 0 podatności;
- central, auth, updater-gateway i backup-manager są healthy;
- Caddy działa z katalogowym mountem ./deploy/caddy -> /etc/caddy:ro;
- publiczny /auth/sso/frontchannel-logout zwraca 404;
- wewnętrzny endpoint bez podpisanego ticketu zwraca 401;
- updater działa wyłącznie w profilu maintenance i został usunięty po teście;
- audit ma version 2, hmac-sha256 i integralność ok;
- podstawowy VPS acceptance zakończył się statusem 0;
- finalny szyfrowany backup jest jeszcze niewykonany, bo brakuje SIRK_BACKUP_AGE_RECIPIENT.

WAŻNE:
- Najpierw pobierz aktualny main. Commit 8d35cab jest punktem odniesienia zaliczonego runtime, ale dokumentacja i kolejne poprawki mogą przesunąć HEAD.
- Pracuj wyłącznie na aktualnym main lub na nowej krótkiej gałęzi utworzonej z aktualnego main.
- Nie modyfikuj repozytorium SIRK Portal w ramach prac dotyczących Central.
- Nie przywracaj server-v1..v15, alternatywnych entrypointów, preloadów, store'ów *-v2, alternatywnego Compose ani staged runtime.
- Nie wdrażaj HA/PostgreSQL w tym etapie.
- Nie montuj ponownie pojedynczego deploy/Caddyfile. Kanoniczna konfiguracja to deploy/caddy/Caddyfile i katalogowy bind mount.
- Nie wyłączaj szyfrowania finalnego backupu produkcyjnego przez SIRK_BACKUP_REQUIRE_ENCRYPTION=false.
- Nie opieraj wyniku na workflow ze starego commita. Dla każdej zmiany sprawdź dokładny HEAD i odpowiadające mu CI, Security Audit oraz UI E2E.
- Nie uznawaj wersji 1.0.0 za gotową bez pozostałych testów środowiskowych.

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
4. deploy/caddy/Caddyfile zawiera blokadę publicznej trasy logout przed reverse_proxy.
5. docker-compose.yml montuje ./deploy/caddy:/etc/caddy:ro.
6. CSRF dotyczy sesji przeglądarkowej, a /api/portal/v1/* zachowuje podpis HMAC/timestamp/nonce.
7. MFA continuity jest egzekwowane wewnątrz operacji revoke.
8. deploy/reset-breakglass-password.sh i deploy/rotate-access-key.sh są kanonicznymi procedurami recovery.
9. Base stack zawiera backup-manager bez Docker socketu i z central-data tylko ro.
10. Rootowy updater nie działa poza profilem maintenance.

Testy lokalne:

cd /opt/sirk-central
git fetch origin
git checkout main
git reset --hard origin/main
npm ci
npm run check:syntax
SIRK_CONCURRENCY_TEST_REQUESTS=24 npm test
npm audit --omit=dev --audit-level=high

Podstawowego acceptance nie powtarzaj bez potrzeby. Powtórz go po zmianach runtime, Compose, Caddy, auth, security lub deployment:

export SIRK_ACCEPTANCE_PUBLIC_URL='https://central.sirkportal.com'
export SIRK_ACCEPTANCE_SKIP_BUILD=true
sudo bash deploy/acceptance-test.sh

NASTĘPNY PRIORYTET — BACKUP AGE:
1. wygeneruj prywatną tożsamość age poza repo;
2. zdeponuj ją w bezpiecznym offline miejscu;
3. wpisz tylko publicznego recipienta jako SIRK_BACKUP_AGE_RECIPIENT w .env;
4. wykonaj deploy/backup.sh z wymaganym szyfrowaniem;
5. zweryfikuj checksum pliku .age;
6. nie ujawniaj prywatnego klucza ani zawartości .env.

Po backupie wykonaj:
- destructive backup/restore z safety backupem i forced rollback;
- update/rollback failure drill oraz potwierdzenie usunięcia maintenance workera;
- Portal simulator z prawdziwym tokenem;
- realny YubiKey w Edge i Chrome;
- Entra pending/approved/rejected/conflict/disabled/logout;
- PL/EN oraz responsive UI review.

Portal simulator:

export SIRK_ACCEPTANCE_RUN_SIMULATOR='true'
export SIRK_SIMULATOR_ORIGIN='https://central.sirkportal.com'
export SIRK_SIMULATOR_PORTAL_ID='<PORTAL_ID>'
export SIRK_SIMULATOR_PORTAL_TOKEN='<PORTAL_TOKEN>'

Pracuj autonomicznie. Naprawiaj konkretne błędy z testów i workflow. Aktualizuj dokumentację po zmianach. Nie twierdź, że test przeszedł bez rzeczywistego wyniku. Po zakończeniu podaj finalny HEAD, wyniki workflow, zmiany i residual risks.
```

## Krótsza wersja

```text
Kontynuuj autonomicznie SIRK Central w repo Eris92/SIRK-Central z aktualnego main. Kanoniczny runtime to src/server.js, wersja 1.0.0-rc.26. VPS acceptance przeszedł na runtime commit 8d35cab: 62/62 testy, audit HMAC v2 poprawny, publiczny logout 404, wszystkie usługi bazowe zdrowe i updater usunięty po maintenance. Następny priorytet to skonfigurowanie publicznego recipienta age, wykonanie szyfrowanego backupu produkcyjnego oraz destructive restore/update rollback drills. Nie dotykaj SIRK Portal, nie przywracaj legacy runtime, nie montuj pojedynczego Caddyfile i nie wyłączaj szyfrowania finalnego backupu.
```
