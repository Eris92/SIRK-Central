# SIRK Central — audyt bezpieczeństwa i gotowości

Data: 2026-07-31  
Gałąź: `feat/central-production-hardening`  
Aktywny runtime: `src/server-v15.js`

## Status

Projekt nie jest jeszcze zatwierdzony do wdrożenia produkcyjnego. Kod, dokumentacja i automatyczne kontrole są przygotowane, ale wymagane są rzeczywiste wyniki GitHub Actions oraz testy na kontrolowanym VPS.

## Zakres audytu

- uwierzytelnianie lokalne, Entra i Break-Glass,
- sesje i CSRF,
- WebAuthn/passkeys i recovery codes,
- RBAC i separation of duties,
- Centrum Akceptacji,
- heartbeat i uwierzytelnianie Portali,
- kolejka poleceń Portali,
- projekcja i synchronizacja zgłoszeń,
- polityki publikacji danych zgłoszeń,
- backup, restore, update i rollback,
- audyt i integralność danych,
- Docker/Compose/Caddy,
- zależności i committed secrets,
- interfejs oraz testy przycisków.

## Znalezione i poprawione problemy

### Krytyczne / wysokie

1. **Wielokrotne użycie akceptacji wysokiego ryzyka**  
   Zatwierdzony wniosek `operation.high-risk` mógł zostać użyty do utworzenia więcej niż jednego polecenia.  
   **Poprawka:** akceptacja dokładnie wskazuje `portalId` i typ operacji, nie może mieć wcześniejszego `execution`, a po utworzeniu polecenia jest trwale wiązana z `commandId`.

2. **Rozbieżność aktywnego runtime**  
   `package.json`, Dockerfile, CI i dokumentacja wskazywały różne wersje runtime.  
   **Poprawka:** kanoniczny entry point, skrypt startowy, `Dockerfile.portal-runtime`, CI i acceptance test wskazują `server-v15.js`.

3. **Brak realnego build-testu kontenerów w CI**  
   Compose był tylko renderowany.  
   **Poprawka:** CI buduje `central`, `auth` i `updater`, sprawdza użytkownika `node` i wykonuje kontrolę składni runtime wewnątrz obrazu.

### Średnie

4. **Monitoring Portali nie był dołączony do produkcyjnego bundla**  
   Kod UI istniał, ale nie był ładowany.  
   **Poprawka:** skrypt i CSS są dołączone do bundla oraz sprawdzane przez `/readyz` i CI.

5. **Brak automatycznego skanowania kodu i zależności**  
   **Poprawka:** dodano `npm audit`, CodeQL, skan kluczy prywatnych/sekretów oraz kontrolę niebezpiecznego dynamicznego wykonywania kodu.

6. **Nieaktualna dokumentacja**  
   README wskazywało runtime v2, a opis PR v14.  
   **Poprawka:** dodano kanoniczne dokumenty dla runtime v15, protokołu Portali, zgłoszeń, testów i wznowienia pracy.

## Mechanizmy bezpieczeństwa obecne w projekcie

- sesje przechowywane jako hashe tokenów,
- idle timeout i absolutny czas życia sesji,
- `HttpOnly`, `Secure`, `SameSite` dla cookie sesji,
- globalna ochrona CSRF dla modyfikujących endpointów API,
- walidacja `Origin` i `Sec-Fetch-Site`,
- limity rozmiaru request body,
- rate limiting logowania lokalnego,
- WebAuthn ES256/P-256, UP/UV, challenge binding i ochrona replay,
- recovery codes przechowywane jako hashe scrypt,
- unieważnianie sesji po operacjach bezpieczeństwa,
- RBAC i zakaz samodzielnej akceptacji,
- trwały audit log,
- podpisany heartbeat z timestamp, nonce i ochroną clock-skew,
- tokeny Portali przechowywane jako hashe,
- kolejka komend bez obsługi dowolnego shell/PowerShell,
- redakcja pól `token`, `password`, `secret` i podobnych w payloadach,
- dokładne i jednorazowe zgody high-risk,
- projekcja zgłoszeń oddzielona od sekretów zewnętrznych connectorów,
- polityki ograniczające opis i dane zgłaszającego przesyłane do Central,
- odrzucanie starszych aktualizacji projekcji,
- kontener aplikacji uruchamiany jako użytkownik `node`,
- `no-new-privileges` i `cap_drop: ALL` dla Central/Auth.

## Obszary wymagające szczególnej weryfikacji

### Portal API

- rate limiting heartbeat, polling komend i ingestion zgłoszeń,
- replay i nonce heartbeat,
- izolacja poleceń między Portalami,
- idempotencja ACK,
- limit aktywnych komend per Portal,
- odporność na reconnect i duplikaty.

### Zgłoszenia

- maksymalny rozmiar snapshotu,
- ochrona przed masowym tworzeniem projekcji,
- walidacja wszystkich pól i dat,
- brak HTML/XSS w tytułach, opisach, komentarzach i nazwach,
- brak sekretów connectorów w przesyłanych danych,
- ochrona danych osobowych zgodnie z polityką Portalu,
- izolacja Tenant/Customer/Site,
- uprawnienia do centralnych zmian statusu i przypisania,
- konflikt i kolejność zdarzeń,
- retencja zamkniętych zgłoszeń.

### Updater

Updater posiada dostęp do `/var/run/docker.sock`; jest to świadomie uprzywilejowana usługa. Port 8090 musi pozostać wyłącznie w sieci wewnętrznej i wymagać silnego tokenu. Należy zweryfikować brak ścieżki SSRF lub obejścia autoryzacji prowadzącej do updatera.

## Ryzyka pozostające do zweryfikowania

1. Rzeczywisty wynik wszystkich GitHub Actions dla aktualnego HEAD.
2. Realny test YubiKey w Edge i Chrome.
3. Restore drill na kopii środowiska.
4. Update/rollback drill.
5. Caddy/TLS i CSP z zewnętrznego klienta.
6. Symulator Portalu: heartbeat, zgłoszenia, komendy i ACK.
7. Pełna macierz RBAC dla wszystkich endpointów.
8. Layout PL/EN na desktopie, tablecie i telefonie.
9. Zachowanie pod równoległymi requestami i restartami procesu.
10. Polityka retencji audytu, komend, heartbeat i zgłoszeń.

## Kryteria blokujące merge

- jakikolwiek czerwony wymagany workflow,
- podatność `high` lub `critical` bez udokumentowanego wyjątku,
- błąd CodeQL o wysokiej ważności,
- nieudany backup/restore albo update/rollback,
- możliwość wykonania high-risk command bez nowej akceptacji,
- możliwość ponownego wykorzystania akceptacji,
- możliwość zatwierdzenia własnego wniosku,
- naruszenie izolacji między Portalami lub Tenantami,
- przyjęcie niepodpisanego/replay heartbeat,
- nieautoryzowana zmiana zgłoszenia,
- błąd konsoli lub HTTP 5xx w Playwright,
- niepoprawne nagłówki bezpieczeństwa lub brak HTTPS,
- brak działającego Break-Glass MFA.

## Decyzja

**Aktualny status: CONDITIONAL / NOT READY FOR PRODUCTION.**  
Przejście do `READY` jest możliwe dopiero po wykonaniu pełnej listy z `docs/TESTING.md` i `deploy/acceptance-test.sh`, uzyskaniu rzeczywistych zielonych statusów CI oraz zakończeniu testów środowiskowych.
