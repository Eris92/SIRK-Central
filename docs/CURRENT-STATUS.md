# SIRK Central — bieżący stan

Data aktualizacji: 2026-07-31

## Repozytorium i gałąź

```text
Repo: Eris92/SIRK-Central
Branch: feat/central-production-hardening
PR: #45
Runtime: src/server-v15.js
```

PR pozostaje draftem. Nie wolno scalać ani wdrażać produkcyjnie przed zakończeniem CI i testów akceptacyjnych.

## Zakres ukończony po stronie Central

### Bezpieczeństwo i tożsamość

- trwałe hashowane sesje,
- idle i absolute timeout,
- CSRF dla operacji modyfikujących,
- Entra ID,
- lokalny Break-Glass,
- Access URL,
- passkeys/WebAuthn,
- recovery codes,
- ciągłość MFA,
- aktywne sesje i revoke,
- audyt bezpieczeństwa.

### Operacje administracyjne

- dashboard operacyjny,
- alerty bazowe,
- backup i retencja,
- restore,
- update i rollback,
- eksport audytu,
- historia operacji.

### Centrum Akceptacji

- wnioski, decyzje, komentarze,
- jedna lub dwie akceptacje,
- zakaz self-approval,
- wygaśnięcie i anulowanie,
- wykonanie zatwierdzonej zmiany roli,
- jednorazowe zgody wysokiego ryzyka.

### Portale

- rejestr Portali,
- uwierzytelnienie Portalu,
- podpisany heartbeat,
- telemetryka,
- stan online/offline/never,
- kolejka poleceń,
- potwierdzanie, postęp, wynik, timeout, retry i cancel,
- UI monitoringu i operacji.

### Zgłoszenia

- wspólny model niezależny od systemu zewnętrznego,
- snapshot i event ingestion,
- trwała projekcja,
- statusy, priorytety, SLA i synchronizacja,
- polityki publikacji per Portal,
- zagregowany workspace Central,
- zmiany statusu/przypisania, gdy polityka zezwala,
- symulator protokołu.

### Testy przygotowane

- testy jednostkowe i regresyjne,
- testy HTTP,
- testy store dla akceptacji, komend i zgłoszeń,
- Playwright Chromium,
- kontrola błędów konsoli, page errors i HTTP 5xx,
- CI build obrazów,
- Compose validation,
- CodeQL,
- npm audit,
- skan sekretów,
- skrypt pełnej akceptacji na VPS.

## Niezmienna zasada

Nie modyfikować repozytorium SIRK Portal. Znajdują się tam niezakończone i niewypchnięte zmiany z wcześniejszej pracy. Wszystkie mechanizmy są obecnie przygotowywane po stronie Central i testowane symulatorem.

## Co nadal wymaga wykonania

1. Uruchomić i przeanalizować wszystkie GitHub Actions dla aktualnego HEAD.
2. Naprawić każdy błąd CI, testów, Docker build i Playwright.
3. Uruchomić `deploy/acceptance-test.sh` na nieprodukcyjnym VPS.
4. Wykonać prawdziwy backup/restore drill.
5. Wykonać update/rollback drill.
6. Przetestować YubiKey w Edge i Chrome.
7. Przetestować Entra ID i role pending/approved/rejected.
8. Uruchomić symulator Portalu z prawdziwym tokenem testowego Portalu.
9. Przejść macierz RBAC dla wszystkich endpointów.
10. Przejrzeć UI PL/EN, mobile, tablet i desktop.
11. Zweryfikować Caddy, TLS, CSP i nagłówki z zewnętrznego klienta.
12. Zaktualizować raport audytu po uzyskaniu rzeczywistych wyników.

## Kryterium gotowości do merge

PR można oznaczyć jako ready dopiero, gdy:

- wszystkie wymagane workflow są zielone,
- acceptance test przechodzi,
- nie ma otwartych podatności High/Critical,
- backup/restore i update/rollback zostały wykonane,
- Break-Glass oraz YubiKey zostały sprawdzone,
- wyniki testów i ograniczenia są opisane w dokumentacji.
