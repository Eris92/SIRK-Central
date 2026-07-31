# Testy SIRK Central

## Cel

Dokument opisuje testy wymagane przed oznaczeniem PR #45 jako gotowego do merge. Sam fakt istnienia testu w repozytorium nie oznacza, że został zaliczony.

## 1. Przygotowanie gałęzi

```bash
cd /opt/sirk-central

git fetch origin
git checkout feat/central-production-hardening
git reset --hard origin/feat/central-production-hardening

git status --short
git rev-parse HEAD
```

Repozytorium powinno być czyste. Nie wykonuj tego w katalogu zawierającym niewypchnięte zmiany.

## 2. Testy lokalne Node.js

```bash
npm ci
npm run check:syntax
npm test
npm audit --omit=dev --audit-level=high
```

Wymagany wynik:

- zero błędów składni,
- wszystkie testy zaliczone,
- brak podatności High/Critical,
- brak nieobsłużonych rejection i warningów wskazujących regresję.

## 3. Pełny acceptance test

```bash
cd /opt/sirk-central

export SIRK_ACCEPTANCE_PUBLIC_URL='https://central.sirkportal.com'

bash deploy/acceptance-test.sh
```

Skrypt wykonuje:

- shell syntax,
- JavaScript syntax,
- testy jednostkowe i HTTP,
- npm audit,
- kontrakt runtime v15,
- renderowanie Compose,
- build obrazów,
- start usług,
- oczekiwanie na healthcheck,
- `/readyz`,
- kontrolę użytkownika kontenera,
- `no-new-privileges`,
- zewnętrzny HTTPS i nagłówki bezpieczeństwa.

Opcje:

```bash
export SIRK_ACCEPTANCE_SKIP_BUILD='true'
export SIRK_ACCEPTANCE_SKIP_LIVE='true'
```

Stosować tylko świadomie; pełna akceptacja nie powinna pomijać build ani live checks.

## 4. Symulator Portalu

Najpierw utwórz testowy Portal i pobierz jego token.

```bash
export SIRK_SIMULATOR_ORIGIN='https://central.sirkportal.com'
export SIRK_SIMULATOR_PORTAL_ID='<PORTAL_ID>'
export SIRK_SIMULATOR_PORTAL_TOKEN='<PORTAL_TOKEN>'

node scripts/portal-simulator.js
```

Sprawdzić:

- heartbeat accepted,
- Portal widoczny jako online,
- telemetryka na kafelku,
- policy endpoint,
- snapshot zgłoszeń,
- event status change,
- zgłoszenie widoczne w Central,
- pobranie komendy,
- ACK running/completed,
- audyt zdarzeń.

Testy negatywne:

- zły token,
- zły podpis heartbeat,
- ponowne użycie nonce,
- timestamp poza oknem,
- zbyt duży body,
- command ACK dla innego Portalu,
- nieznany status zgłoszenia,
- starszy event próbujący nadpisać nowszy.

## 5. Playwright i testy przycisków

Workflow `.github/workflows/ui-e2e.yml` uruchamia Chromium i mock backend.

Sprawdza:

- główną nawigację,
- dashboard,
- audyt,
- Centrum Akceptacji,
- operacje Portali,
- ustawienia,
- backup/update,
- sesje,
- zgłoszenia,
- błędy konsoli,
- page errors,
- HTTP 5xx.

Po błędzie pobierz artefakt:

```text
sirk-central-ui-e2e
```

Przejrzyj trace, screenshot, video i log mock backendu.

## 6. Testy Centrum Akceptacji

Wykonać osobno:

1. utworzenie zwykłego wniosku,
2. jedna akceptacja,
3. dwie akceptacje,
4. self-approval — musi zostać odrzucone,
5. drugi głos tego samego użytkownika — musi zostać odrzucony,
6. reject,
7. cancel przez wnioskodawcę,
8. próba cancel przez inną osobę,
9. expiry,
10. role.assignment i rzeczywista zmiana roli,
11. operation.high-risk dla właściwego Portalu i typu,
12. użycie zgody drugi raz — musi zostać odrzucone,
13. próba użycia zgody dla innego Portalu,
14. próba użycia zgody dla innego typu operacji,
15. kontrola wpisów audytu.

## 7. Macierz RBAC

Przetestować każdą istotną trasę jako:

```text
brak sesji
Pending
OperatorL1
SupportL2
EngineerL3
Auditor
Admin
SecAdmin
BreakGlass
```

Obszary:

- `/api/session`,
- użytkownicy i role,
- organizacje,
- approvals,
- audit,
- backup/update/restore,
- aktywne sesje,
- telemetryka Portali,
- operacje Portali,
- zgłoszenia,
- polityki zgłoszeń,
- eksporty.

Każdy endpoint modyfikujący sprawdzić również bez CSRF i z obcym Origin.

## 8. Backup i restore drill

1. Utworzyć dane testowe.
2. Wykonać backup.
3. Sprawdzić checksum i zawartość archiwum.
4. Zmienić/usunąć dane testowe.
5. Wykonać restore z wymaganym potwierdzeniem.
6. Sprawdzić `/readyz`.
7. Sprawdzić odtworzenie sesji/store zgodnie z założeniami.
8. Sprawdzić prawa plików.
9. Sprawdzić wpis audytu.

Nie wykonywać pierwszego drill na produkcji.

## 9. Update i rollback drill

1. Zapisać bieżący commit i wersję.
2. Wykonać update do kontrolowanego commita.
3. Sprawdzić health, UI, dane i audyt.
4. Wykonać rollback.
5. Sprawdzić powrót do poprzedniego commita i danych.
6. Zasymulować błąd build/start i sprawdzić automatyczną reakcję.

## 10. YubiKey i Break-Glass

W Edge i Chrome:

- rejestracja pierwszego passkey,
- rejestracja YubiKey,
- logowanie passkey,
- logowanie YubiKey,
- recovery code,
- jednorazowość recovery code,
- rotacja recovery codes,
- próba usunięcia ostatniej metody MFA,
- signature counter,
- zły origin/RP ID,
- wygasła transakcja,
- ponowne użycie challenge.

## 11. Entra ID

- login z właściwego tenantu,
- login z innego dozwolonego tenantu,
- konto bez roli,
- standardowa rola z grupy,
- `Admin` pending,
- `SecAdmin` pending,
- konflikt wielu ról,
- approve/reject,
- logout i front-channel logout,
- unieważnienie sesji po zmianie roli.

## 12. UI manualne

Rozdzielczości:

```text
1920x1080
1366x768
tablet
telefon
```

Sprawdzić:

- PL i EN,
- długie nazwy,
- puste listy,
- setki rekordów,
- loading/error states,
- focus i obsługę klawiaturą,
- kontrast,
- modal/dialog,
- brak inline style blokowanego przez CSP,
- wszystkie przyciski i linki powrotu.

## 13. Caddy/TLS

Z zewnętrznej sieci:

```bash
curl -I https://central.sirkportal.com/
curl -fsS https://central.sirkportal.com/readyz
```

Sprawdzić:

- ważny certyfikat,
- pełny chain,
- redirect HTTP→HTTPS,
- HSTS,
- X-Content-Type-Options,
- X-Frame-Options,
- CSP,
- brak publikacji portu 8080,
- poprawny WebSocket upgrade.

## 14. GitHub Actions

Wymagane zielone workflow:

- CI,
- UI E2E,
- Security Audit/CodeQL,
- inne workflow wymagane przez branch protection.

Nie oznaczać PR jako ready, jeżeli API GitHub nie pokazuje rzeczywiście zaliczonych statusów.

## 15. Raport końcowy

Po testach uzupełnić:

- commit testowany,
- środowisko,
- wersje Docker/Node/przeglądarek,
- wynik każdego bloku,
- linki do workflow i artefaktów,
- wykryte błędy,
- poprawki i commity,
- ryzyka zaakceptowane,
- decyzję: BLOCK / READY FOR REVIEW / READY TO DEPLOY.
