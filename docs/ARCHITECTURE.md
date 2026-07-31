# Architektura SIRK Central

## Cel

SIRK Central jest centralnym management plane dla wielu niezależnych instalacji SIRK Portal. Central nie zastępuje lokalnych Portali i nie powinien wymagać od nich publicznego adresu. Portal inicjuje połączenia wychodzące i zachowuje możliwość autonomicznej pracy lokalnej.

## Warstwy systemu

```text
Użytkownik
   |
   v
Caddy / TLS
   |
   +--> Central UI + API (server-v15)
   +--> Auth broker (opcjonalny)
   +--> Updater/Backup service

SIRK Portal ---- wychodzące HTTPS/WSS ----> Central
```

## Runtime

`src/server-v15.js` jest kanonicznym runtime. Wykorzystuje kompozycję poprzednich warstw, dlatego niższe runtime nie są samodzielnymi zamiennikami produkcyjnego entry pointu.

```text
server-v15  ticket projection and coordination
server-v14  portal operation queue
server-v13  approval execution
server-v12  session administration
server-v11  admin runtime and backup controls
server-v10  portal heartbeat and telemetry
server-v9   restore integration
server-v8   hardened identity, MFA, update and backup
```

## Granice odpowiedzialności

### SIRK Central

- globalna tożsamość i role,
- Tenant, Customer, Site,
- rejestr i stan Portali,
- akceptacje,
- audyt,
- polecenia do Portali,
- zagregowane zgłoszenia,
- raportowanie i alerty,
- backup/update/restore Central.

### SIRK Portal

- lokalna obsługa urządzeń i Agentów,
- lokalne logowanie/fallback zgodnie z konfiguracją klienta,
- wykonanie poleceń Central,
- heartbeat i telemetryka,
- lokalny moduł zgłoszeń,
- integracje Jira/ServiceDesk/GLPI/inne,
- lokalne sekrety connectorów,
- mapowanie pól i statusów zewnętrznych systemów.

### Zasada integracji zgłoszeń

Central zna wyłącznie wspólny model SIRK. Nie przechowuje tokenów Jira ani ServiceDesk. Connector działa po stronie Portalu, a Central przechowuje projekcję wybranych zgłoszeń.

## Dane trwałe

Dane Central znajdują się w wolumenie `/var/lib/sirk-central`. Store wykorzystują atomowy zapis przez plik tymczasowy i rename. Krytyczne dane są przechowywane z prawami ograniczonymi do użytkownika procesu.

Główne klasy danych:

- użytkownicy i role,
- sesje,
- passkeys i transakcje WebAuthn,
- recovery codes,
- organizacje,
- Portale i przypisania,
- approvals,
- audit,
- heartbeat/telemetry,
- portal commands,
- ticket projections i policies.

## Uwierzytelnianie

### Użytkownicy

- Entra ID przez opcjonalny broker Auth,
- lokalni użytkownicy,
- wbudowany Break-Glass,
- cookies `HttpOnly`, `Secure`, `SameSite`,
- CSRF cookie + nagłówek + kontrola Origin/Sec-Fetch-Site.

### Portale

Portal używa nagłówka:

```text
Authorization: SIRK-Portal <base64url(portalId:token)>
```

Heartbeat dodatkowo wymaga podpisu HMAC, timestampu i nonce. API komend i zgłoszeń korzysta z uwierzytelnienia Portalu i limitów body.

## RBAC

Role uprzywilejowane są rozdzielone:

- `SecAdmin` odpowiada za bezpieczeństwo i decyzje,
- `Admin` odpowiada za administrację,
- `BreakGlass` jest kontem awaryjnym,
- role operacyjne otrzymują ograniczony zakres.

Wnioskujący nie może zatwierdzać własnej operacji. Wysokiego ryzyka zgoda jest jednorazowa.

## Operacje Portali

Central przechowuje trwałą kolejkę. Portal pobiera polecenia i wysyła ACK ze stanem i postępem. Central nie zakłada, że Portal jest stale połączony.

## Zgłoszenia

Klucz projekcji:

```text
portalId + ticketId
```

Central przyjmuje:

- pełny snapshot,
- zdarzenia przyrostowe,
- dane tylko zgodne z polityką publikacji.

Starsze aktualizacje nie powinny zastępować nowszej projekcji.

## Usługi kontenerowe

### central

- użytkownik `node`,
- `no-new-privileges`,
- `cap_drop: ALL`,
- healthcheck `/readyz`.

### auth

- opcjonalny profil Compose,
- broker Entra ID,
- osobny healthcheck.

### updater

- jedyna usługa z dostępem do Docker socket,
- backup/update/rollback,
- dostęp do wolumenów zgodnie z zadaniem.

### caddy

- publiczne porty 80/443,
- TLS,
- reverse proxy,
- nagłówki bezpieczeństwa.

## Ograniczenia przed testami

Architektura i kontrakty są zaimplementowane, ale nie należy traktować ich jako produkcyjnie potwierdzonych przed:

- zielonym CI,
- testem na VPS,
- realnym YubiKey,
- backup/restore drill,
- update/rollback drill,
- symulatorem Portalu,
- testem RBAC i UI.
