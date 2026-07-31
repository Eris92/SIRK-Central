# SIRK Central

SIRK Central jest centralnym panelem zarządzania wieloma instalacjami **SIRK Portal**. Odpowiada za tożsamość, RBAC, Tenant → Customer → Site, rejestrację i monitoring Portali, Centrum Akceptacji, audyt, backup/update/restore, operacje zdalne oraz zagregowany widok zgłoszeń.

> Status: aktywna gałąź rozwojowa `feat/central-production-hardening`, PR #45 pozostaje draftem do czasu zaliczenia CI i testów akceptacyjnych na VPS.

## Dokumentacja

- [Bieżący stan i lista otwartych prac](docs/CURRENT-STATUS.md)
- [Architektura](docs/ARCHITECTURE.md)
- [Protokół Central ↔ Portal](docs/PORTAL-PROTOCOL.md)
- [Testy i wieczorna procedura akceptacyjna](docs/TESTING.md)
- [Audyt bezpieczeństwa](docs/SECURITY-AUDIT-2026-07-31.md)
- [Polecenie wznowienia w nowym czacie](docs/RESUME-PROMPT.md)

## Aktywny runtime

Kanonicznym punktem wejścia jest:

```text
src/server-v15.js
```

Ten sam runtime jest wskazany przez:

- `package.json` (`main`, `start`, `dev`),
- `Dockerfile.portal-runtime`,
- GitHub Actions CI,
- `deploy/acceptance-test.sh`.

Runtime v15 rozszerza wcześniejsze warstwy:

```text
v15  projekcja i koordynacja zgłoszeń
v14  kolejka operacji Portali
v13  Centrum Akceptacji i wykonanie zatwierdzonych zmian
v12  aktywne sesje i ich unieważnianie
v11  backup policy, eksport audytu i informacje systemowe
v10  heartbeat i telemetryka Portali
v9   restore
v8   MFA, passkeys, update i backup
```

Pliki wcześniejszych runtime pozostają częścią łańcucha kompozycji. Nie należy samodzielnie przełączać kontenera na niższy numer runtime.

## Usługi

Projekt działa przez Docker Compose:

- `central` — aplikacja, API i UI,
- `auth` — opcjonalny broker Entra ID,
- `updater` — backup, update, rollback i operacje administracyjne,
- `caddy` — TLS, reverse proxy i publiczne strony statyczne.

```text
Internet
   |
   v
Caddy :80/:443
   |-- sirkportal.com          -> strona produktu
   |-- central.sirkportal.com  -> SIRK Central
   |-- auth.sirkportal.com     -> SIRK Auth (opcjonalnie)
   |-- sir-k.pl                -> strona firmowa
   `-- www.sir-k.pl            -> redirect
```

Port aplikacji `8080` nie jest publikowany bezpośrednio do Internetu.

## Główne funkcje

### Tożsamość i bezpieczeństwo

- Entra ID jako podstawowy login,
- lokalne konto Break-Glass,
- ukryty Access URL,
- passkeys/WebAuthn ES256 P-256,
- YubiKey jako preferowany authenticator,
- jednorazowe recovery codes przechowywane jako hashe scrypt,
- trwałe sesje z idle i absolute timeout,
- globalny CSRF,
- aktywne sesje i ich unieważnianie,
- tamper-evident audit trail,
- rozdzielenie ról `Admin` i `SecAdmin`.

### Centrum Akceptacji

Obsługiwane typy:

```text
role.assignment
tenant.activation
portal.enrollment
operation.high-risk
credential.use
```

Właściwości:

- jedna lub dwie niezależne akceptacje,
- zakaz zatwierdzania własnego wniosku,
- komentarze, odrzucenie, anulowanie i wygaśnięcie,
- trwały wynik wykonania,
- jednorazowe użycie zgody wysokiego ryzyka,
- dokładne powiązanie zgody z Portalem i typem operacji.

### Monitoring i operacje Portali

Central przechowuje heartbeat i telemetrykę:

- online/offline/never,
- wersja i commit,
- health,
- CPU i RAM,
- liczba Agentów,
- backup,
- dostępna aktualizacja.

Kolejka operacji obsługuje:

```text
backup
update
restart
reconnect
sync
diagnostics
```

Stany:

```text
queued
delivered
running
completed
failed
cancelled
expired
```

Operacje `update`, `restart` i `diagnostics` wymagają zatwierdzonego `operation.high-risk`.

### Zgłoszenia

Central nie integruje się bezpośrednio z Jira, ServiceDesk, GLPI ani innymi systemami. Każdy Portal będzie lokalnym punktem integracji, a Central korzysta ze wspólnego modelu projekcji zgłoszeń.

Central obsługuje:

- snapshoty i zdarzenia z Portali,
- znormalizowane statusy i priorytety,
- SLA,
- stan synchronizacji,
- filtrowanie wielu Tenantów i Portali,
- polityki publikacji per Portal,
- koordynację statusu i przypisania, jeśli Portal na to zezwala.

## Role

- `BreakGlass` — awaryjne zarządzanie i pierwsza konfiguracja,
- `SecAdmin` — bezpieczeństwo i akceptacje uprzywilejowane,
- `Admin` — administracja organizacją i Portalami,
- `Auditor` — odczyt i audyt,
- `OperatorL1`, `SupportL2`, `EngineerL3` — role operacyjne.

## Publiczne adresy

| Adres | Rola |
|---|---|
| `https://sirkportal.com` | strona produktu |
| `https://central.sirkportal.com` | SIRK Central |
| `https://auth.sirkportal.com` | opcjonalny broker Entra ID |
| `https://sir-k.pl` | strona firmowa |

## Instalacja

```bash
curl -fsSL \
  https://raw.githubusercontent.com/Eris92/SIRK-Central/main/deploy/install.sh \
  -o /tmp/install-sirk-central.sh

sudo bash /tmp/install-sirk-central.sh
sudo rm -f /tmp/install-sirk-central.sh
```

Dla istniejącego katalogu:

```bash
sudo bash /tmp/install-sirk-central.sh --force
```

Nie używaj `curl | sudo bash`.

## Najważniejsze zmienne `.env`

| Zmienna | Znaczenie |
|---|---|
| `NODE_ENV=production` | tryb produkcyjny |
| `SIRK_CENTRAL_DOMAIN` | domena Central |
| `SIRK_AUTH_ORIGIN` | adres Auth lub puste |
| `SIRK_SSO_SHARED_SECRET` | sekret Central↔Auth |
| `SIRK_ADMIN_USERNAME` | konto Break-Glass |
| `SIRK_ADMIN_PASSWORD_HASH` | hash hasła Break-Glass |
| `SIRK_ACCESS_KEY_HASH` | hash Access URL |
| `SIRK_SESSION_IDLE_MINUTES` | idle timeout |
| `SIRK_SESSION_ABSOLUTE_HOURS` | maksymalny czas sesji |
| `SIRK_TRUST_PROXY=true` | użycie nagłówków Caddy |
| `SIRK_UPDATER_TOKEN` | sekret Central↔Updater |

Sekretów nie wolno commitować.

## Backup i restore

```bash
sudo bash /opt/sirk-central/deploy/backup.sh
```

```bash
sudo SIRK_RESTORE_CONFIRM='RESTORE SIRK CENTRAL' \
  bash /opt/sirk-central/deploy/restore.sh \
  /var/backups/sirk-central/sirk-central-<DATA>.tar.gz
```

## Testy

Podstawowe:

```bash
npm ci
npm run check:syntax
npm test
```

Pełna procedura na VPS:

```bash
cd /opt/sirk-central
export SIRK_ACCEPTANCE_PUBLIC_URL='https://central.sirkportal.com'
bash deploy/acceptance-test.sh
```

Szczegóły, symulator Portalu i lista testów manualnych znajdują się w [docs/TESTING.md](docs/TESTING.md).

## Zasada dotycząca SIRK Portal

Aktualna praca dotyczy wyłącznie repozytorium **SIRK Central**. Repozytorium SIRK Portal posiada niezakończone i niewypchnięte zmiany, dlatego nie należy go modyfikować ani zakładać, że nowe API jest już przez Portal używane. Central zawiera kontrakty, kolejki, projekcje i symulator przygotowujący późniejszą integrację.
