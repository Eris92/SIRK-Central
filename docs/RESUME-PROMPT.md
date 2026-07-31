# Polecenie wznowienia w nowym czacie

Skopiuj cały blok poniżej do nowego czatu.

```text
CEL: Kontynuuj autonomicznie rozwój, audyt i testy projektu SIRK Central jak coding agent.

Repozytorium:
- GitHub: Eris92/SIRK-Central
- Branch: feat/central-production-hardening
- PR: #45
- Kanoniczny runtime: src/server-v15.js

WAŻNE OGRANICZENIE:
- Nie modyfikuj repozytorium SIRK Portal.
- W repozytorium Portalu są niezakończone i niewypchnięte zmiany z poprzedniej pracy.
- Wszystkie mechanizmy połączeń, heartbeat, komend i zgłoszeń rozwijaj oraz testuj wyłącznie po stronie SIRK Central, używając symulatora Portalu.

Najpierw:
1. Pobierz aktualny stan PR #45 i HEAD gałęzi.
2. Przeczytaj obowiązkowo:
   - README.md
   - docs/CURRENT-STATUS.md
   - docs/ARCHITECTURE.md
   - docs/PORTAL-PROTOCOL.md
   - docs/TESTING.md
   - docs/SECURITY-AUDIT-2026-07-31.md
   - deploy/acceptance-test.sh
3. Zweryfikuj, że package.json i Dockerfile.portal-runtime wskazują src/server-v15.js.
4. Sprawdź rzeczywiste wyniki GitHub Actions dla aktualnego HEAD. Nie zakładaj, że testy przeszły.

Aktualnie zaimplementowane po stronie Central:
- Entra ID i lokalny Break-Glass,
- Access URL,
- passkeys/WebAuthn i recovery codes,
- trwałe sesje, CSRF i aktywne sesje,
- tamper-evident audit,
- Tenant → Customer → Site,
- Centrum Akceptacji z jedną/dwiema akceptacjami, self-approval protection i wykonaniem zmian,
- jednorazowe operation.high-risk,
- heartbeat i telemetryka Portali,
- kolejka komend backup/update/restart/reconnect/sync/diagnostics,
- ACK, progress, result, timeout, cancel i retry,
- backup, restore, update i rollback,
- zagregowany moduł zgłoszeń niezależny od Jira/ServiceDesk/GLPI,
- polityki publikacji zgłoszeń per Portal,
- snapshot i event ingestion,
- UI Zgłoszenia,
- symulator Portalu,
- testy jednostkowe, HTTP, Playwright, CI, CodeQL i npm audit.

Priorytet działania:
1. Uruchom/odczytaj pełne CI i napraw wszystkie błędy.
2. Sprawdź składnię i kompletność nowych plików, szczególnie server-v15.js, ticket-projection-store.js, UI zgłoszeń i symulatora.
3. Wykonaj pełny statyczny audyt bezpieczeństwa i logiki wszystkich endpointów.
4. Dodaj brakujące testy HTTP/API dla zgłoszeń, polityk, heartbeat, komend i approvals.
5. Rozszerz Playwright tak, aby klikał każdy dostępny przycisk i wykrywał console errors, page errors, 4xx nieoczekiwane i 5xx.
6. Przejdź macierz RBAC dla: brak sesji, Pending, OperatorL1, SupportL2, EngineerL3, Auditor, Admin, SecAdmin, BreakGlass.
7. Sprawdź rate limiting, replay, idempotency, body limits, CSRF, Origin, SSRF, traversal, secret redaction i concurrency.
8. Przygotuj poprawki wykrytych problemów i wypychaj je na tę samą gałąź.
9. Aktualizuj dokumentację po każdej istotnej zmianie.
10. Nie oznaczaj PR jako ready i nie merguj, dopóki wszystkie testy nie przejdą oraz nie zostaną wykonane testy VPS/YubiKey/backup-restore/update-rollback.

Wieczorna procedura VPS:

cd /opt/sirk-central
git fetch origin
git checkout feat/central-production-hardening
git reset --hard origin/feat/central-production-hardening

export SIRK_ACCEPTANCE_PUBLIC_URL='https://central.sirkportal.com'

# opcjonalnie pełny symulator po ustawieniu testowego Portalu:
export SIRK_ACCEPTANCE_RUN_SIMULATOR='true'
export SIRK_SIMULATOR_ORIGIN='https://central.sirkportal.com'
export SIRK_SIMULATOR_PORTAL_ID='<PORTAL_ID>'
export SIRK_SIMULATOR_PORTAL_TOKEN='<PORTAL_TOKEN>'

bash deploy/acceptance-test.sh

Pracuj autonomicznie i nie zatrzymuj się po każdym drobnym kroku. Bądź uczciwy: nie twierdź, że test przeszedł, jeżeli nie masz rzeczywistego wyniku. Po zakończeniu podaj aktualny HEAD, listę commitów, wyniki testów, błędy i dokładną listę tego, co pozostaje do manualnego sprawdzenia.
```

## Krótsza wersja

```text
Kontynuuj autonomicznie SIRK Central z repo Eris92/SIRK-Central, branch feat/central-production-hardening, PR #45. Przeczytaj README.md oraz wszystkie dokumenty w docs, szczególnie CURRENT-STATUS.md, TESTING.md i PORTAL-PROTOCOL.md. Kanoniczny runtime to src/server-v15.js. Nie dotykaj repozytorium SIRK Portal — testuj integrację wyłącznie symulatorem. Sprawdź rzeczywiste GitHub Actions, napraw CI, wykonaj pełny audyt bezpieczeństwa, testy HTTP/RBAC/Playwright, aktualizuj dokumentację i pozostaw PR jako draft do czasu pełnej akceptacji VPS, YubiKey, backup/restore i update/rollback.
```
