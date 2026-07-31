# SIRK Central — audyt bezpieczeństwa i gotowości

Data: 2026-07-31  
Gałąź: `feat/central-production-hardening`  
Aktywny runtime: `src/server-v14.js`

## Status

Projekt nie jest jeszcze zatwierdzony do wdrożenia produkcyjnego. Kod i automatyczne kontrole są przygotowane, ale wymagane są wyniki GitHub Actions oraz testy na kontrolowanym VPS.

## Zakres audytu

- uwierzytelnianie lokalne, Entra i Break-Glass,
- sesje i CSRF,
- WebAuthn/passkeys i recovery codes,
- RBAC i separation of duties,
- Centrum Akceptacji,
- heartbeat i uwierzytelnianie Portali,
- kolejka poleceń Portali,
- backup, restore, update i rollback,
- audyt i integralność danych,
- Docker/Compose/Caddy,
- zależności i committed secrets,
- interfejs oraz testy przycisków.

## Znalezione i poprawione problemy

### Krytyczne / wysokie

1. **Wielokrotne użycie akceptacji wysokiego ryzyka**  
   Zatwierdzony wniosek `operation.high-risk` mógł zostać użyty do utworzenia więcej niż jednego polecenia.  
   **Poprawka:** akceptacja musi dokładnie wskazywać `portalId` i typ operacji, nie może mieć wcześniejszego `execution`, a po utworzeniu polecenia jest trwale wiązana z `commandId`.

2. **Rozbieżność aktywnego runtime**  
   `package.json`, Dockerfile i CI wskazywały różne wersje runtime.  
   **Poprawka:** kanoniczny entry point, skrypt startowy, obraz `Dockerfile.portal-runtime` oraz CI wskazują `server-v14.js`.

3. **Brak realnego build-testu kontenerów w CI**  
   Compose był tylko renderowany.  
   **Poprawka:** CI buduje `central`, `auth` i `updater`, sprawdza użytkownika `node` i wykonuje `node --check` wewnątrz obrazu.

### Średnie

4. **Monitoring Portali nie był dołączony do produkcyjnego bundla**  
   Kod UI istniał, ale nie był ładowany.  
   **Poprawka:** skrypt i CSS są dołączone do bundla oraz sprawdzane przez `/readyz` i CI.

5. **Brak automatycznego skanowania kodu i zależności**  
   **Poprawka:** dodano `npm audit`, CodeQL, skan kluczy prywatnych/sekretów oraz blokadę dynamicznego wykonania przez `eval`, `Function` i `child_process.exec` w krytycznych katalogach.

6. **Nieaktualny opis PR**  
   Opis wskazywał runtime v8.  
   **Poprawka:** PR #45 opisuje obecny runtime v14, funkcje, testy i blokady przed merge.

## Mechanizmy bezpieczeństwa obecne w projekcie

- sesje przechowywane jako hashe tokenów,
- idle timeout i absolutny czas życia sesji,
- `HttpOnly`, `Secure`, `SameSite` dla cookie sesji,
- globalna ochrona CSRF dla modyfikujących endpointów API,
- walidacja `Origin` i `Sec-Fetch-Site`,
- limit rozmiaru request body,
- rate limiting logowania lokalnego,
- WebAuthn ES256/P-256, UP/UV, challenge binding i ochrona replay,
- recovery codes przechowywane jako hashe scrypt,
- unieważnianie sesji po operacjach bezpieczeństwa,
- RBAC i zakaz samodzielnej akceptacji,
- trwały audit log,
- podpisany heartbeat z timestamp, nonce i ochroną clock-skew,
- tokeny Portali przechowywane w postaci hashy,
- kolejka komend bez obsługi dowolnego shell/PowerShell,
- redakcja pól `token`, `password`, `secret` i podobnych w payloadach,
- kontener aplikacji uruchamiany jako użytkownik `node`,
- `no-new-privileges` i `cap_drop: ALL` dla Central/Auth.

## Ryzyka pozostające do zweryfikowania

1. Updater ma dostęp do `/var/run/docker.sock`; jest to świadomie uprzywilejowana usługa. Należy potwierdzić, że port 8090 pozostaje wyłącznie w sieci wewnętrznej i wymaga silnego tokenu.
2. Należy wykonać realny test YubiKey w Edge i Chrome.
3. Należy wykonać restore drill na kopii środowiska, nie na produkcji.
4. Należy zweryfikować Caddy/TLS z zewnętrznego klienta.
5. Należy uruchomić symulator Portalu i potwierdzić heartbeat, pobranie komendy i ACK.
6. Należy sprawdzić wyniki CodeQL i `npm audit`; sam workflow nie zastępuje wyniku.
7. Należy ręcznie sprawdzić layout PL/EN na desktopie i urządzeniu mobilnym.

## Kryteria blokujące merge

- jakikolwiek czerwony workflow,
- podatność `high` lub `critical` w zależnościach bez zaakceptowanego wyjątku,
- błąd CodeQL o wysokiej ważności,
- nieudany backup/restore albo update/rollback,
- możliwość wykonania high-risk command bez nowej akceptacji,
- możliwość zatwierdzenia własnego wniosku,
- błąd konsoli lub HTTP 5xx w Playwright,
- niepoprawne nagłówki bezpieczeństwa lub brak HTTPS,
- brak działającego Break-Glass MFA.

## Decyzja

**Aktualny status: CONDITIONAL / NOT READY FOR PRODUCTION.**  
Przejście do `READY` jest możliwe dopiero po wykonaniu pełnej listy z `deploy/acceptance-test.sh` oraz testów środowiskowych opisanych wyżej.
