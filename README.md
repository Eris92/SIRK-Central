# SIRK Central

Centralny panel zarządzania dla wielu instalacji **SIRK Portal**. Projekt odpowiada za centralny RBAC, zarządzanie tenantami, użytkownikami, klientami, lokalizacjami i połączonymi Portalami oraz za publiczny punkt logowania Entra ID.

## Architektura

Projekt składa się z usług uruchamianych przez Docker Compose:

- `central` — panel SIRK Central i API,
- `auth` — opcjonalny broker logowania Entra ID,
- `updater` — izolowany mechanizm aktualizacji,
- `caddy` — wspólny reverse proxy, TLS i serwowanie stron statycznych.

Ten sam Caddy może obsługiwać publiczną stronę firmową `sir-k.pl` zamontowaną tylko do odczytu z `/opt/sir-k.pl`.

```text
Internet
   |
   v
Caddy :80/:443
   |-- sirkportal.com          -> statyczna strona produktu
   |-- central.sirkportal.com  -> SIRK Central
   |-- auth.sirkportal.com     -> SIRK Auth, opcjonalnie
   |-- sir-k.pl                -> /opt/sir-k.pl
   `-- www.sir-k.pl            -> redirect do sir-k.pl
```

Lokalne Portale inicjują wychodzące połączenie WSS do Central. Nie wymagają publicznego adresu, przekierowania portów ani wystawienia lokalnego HTTP do Internetu.

## Aktywny runtime

Nowa instalacja uruchamia:

```text
src/server-v2.js
```

Stary `entry.js` i `server.js` pozostają wyłącznie diagnostycznie. Kontener nie uruchamia kodu legacy.

Runtime v2 zapewnia:

- globalny CSRF dla operacji modyfikujących API,
- trwałe sesje przechowywane jako hashe tokenów,
- idle timeout i absolutny limit sesji,
- gotowość pod `/readyz`,
- Tenant → Customer → Site,
- Approval Center,
- Portal → Tenant → Customer → Site,
- recovery codes dla konta break-glass przechowywane wyłącznie jako hashe.

Pełne wymuszenie YubiKey/WebAuthn nie jest jeszcze oznaczone jako ukończone. Wymaga kompletnej ceremonii registration i authentication z kryptograficzną walidacją odpowiedzi przeglądarki.

## Publiczne adresy

| Adres | Rola |
|---|---|
| `https://sirkportal.com` | publiczna strona produktu SIRK Portal |
| `https://central.sirkportal.com` | panel SIRK Central |
| `https://auth.sirkportal.com` | opcjonalny broker logowania Entra ID |
| `https://sir-k.pl` | publiczna strona firmowa Sir-K |
| `https://www.sir-k.pl` | przekierowanie do `sir-k.pl` |

## Logowanie i role

Podstawowym mechanizmem logowania jest Microsoft Entra ID. Lokalne konto pozostaje jako dostęp awaryjny `break-glass`.

Aktualny lokalny login wymaga dodatkowego klucza we fragmencie URL:

```text
https://central.sirkportal.com/#access=<KLUCZ>
```

Fragment URL nie trafia do logów HTTP ani do nagłówka `Referer`. Klucz jest warstwą ukrycia wejścia i nie zastępuje uwierzytelnienia.

Główne role:

- `BreakGlass` — awaryjne zarządzanie dostępem i pierwszą konfiguracją,
- `SecAdmin` — bezpieczeństwo i zatwierdzanie uprzywilejowanych operacji,
- `Admin` — administracja tenantami, użytkownikami i Portalami,
- `Auditor` — dostęp tylko do odczytu i audytu,
- role operacyjne — obsługa w przydzielonym zakresie.

`Admin` i `SecAdmin` są rozdzielone. Wnioskodawca nie może zatwierdzić własnej operacji w Approval Center.

Kanoniczny obszar zarządzania uprawnieniami znajduje się pod `/permissions`. Trasa `/admin` nie jest używana.

## DNS i porty

Wymagane rekordy powinny wskazywać na VPS z Caddy:

```text
sirkportal.com          A/AAAA -> VPS
www.sirkportal.com      A/AAAA -> VPS
central.sirkportal.com  A/AAAA -> VPS
auth.sirkportal.com     A/AAAA -> VPS, gdy Auth jest używany
sir-k.pl                A/AAAA -> VPS
www.sir-k.pl            A/AAAA -> VPS
```

Nie publikuj rekordu `AAAA`, jeżeli wskazuje na inny serwer niż VPS.

Publiczne porty:

```text
80/tcp   ACME HTTP-01 i redirect HTTPS
443/tcp  HTTPS
443/udp  HTTP/3, opcjonalnie
```

Port aplikacji Central `8080` nie jest publikowany bezpośrednio do Internetu.

## Czysta instalacja

Serwer testowy można postawić od początku. Instalator nie przenosi starych sesji ani danych aplikacji.

```bash
curl -fsSL \
  https://raw.githubusercontent.com/Eris92/SIRK-Central/main/deploy/install.sh \
  -o /tmp/install-sirk-central.sh

sudo bash /tmp/install-sirk-central.sh
sudo rm -f /tmp/install-sirk-central.sh
```

Dla istniejącego katalogu użyj `--force`. Instalator archiwizuje poprzednią instalację zamiast kasować ją bez kopii:

```bash
sudo bash /tmp/install-sirk-central.sh --force
```

Nie używaj `curl | sudo bash`, ponieważ instalator pobiera dane interaktywnie.

Instalator:

- obsługuje Ubuntu i Debian,
- instaluje Docker Engine i Compose plugin,
- tworzy klon Git w `/opt/sirk-central`,
- tworzy `.env`,
- generuje dane break-glass i jednorazowy Access URL,
- konfiguruje UFW,
- buduje kontenery,
- czeka na `/readyz`,
- pokazuje logi, gdy start się nie powiedzie.

## Najważniejsze zmienne `.env`

| Zmienna | Przykład |
|---|---|
| `NODE_ENV` | `production` |
| `SIRK_WEBSITE_DOMAIN` | `sirkportal.com` |
| `SIRK_CENTRAL_DOMAIN` | `central.sirkportal.com` |
| `SIRK_AUTH_ORIGIN` | puste bez SSO albo `https://auth.sirkportal.com` |
| `SIRK_ACME_EMAIL` | adres administratora certyfikatów |
| `SIRK_ADMIN_USERNAME` | lokalne konto awaryjne |
| `SIRK_SESSION_IDLE_MINUTES` | domyślnie `30` |
| `SIRK_SESSION_ABSOLUTE_HOURS` | domyślnie `8` |
| `SIRK_TRUST_PROXY` | `true` za Caddy |

Sekretów nie należy umieszczać w repozytorium ani dokumentacji publicznej.

## Recovery codes break-glass

Po zalogowaniu jako wbudowane konto break-glass dostępne jest API:

```text
GET    /api/break-glass/mfa/status
POST   /api/break-glass/mfa/recovery-codes/rotate
DELETE /api/break-glass/mfa/recovery-codes
```

Rotacja:

- zwraca kody jawne tylko w odpowiedzi na jedno żądanie,
- zapisuje na dysku wyłącznie hashe scrypt,
- odbiera pozostałe sesje break-glass,
- zapisuje zdarzenie w audycie.

Kody są jednorazowe. Po pięciu błędnych próbach następuje czasowa blokada weryfikacji.

## Backup i odtwarzanie

Backup:

```bash
sudo bash /opt/sirk-central/deploy/backup.sh
```

Odtworzenie wymaga jawnego potwierdzenia:

```bash
sudo SIRK_RESTORE_CONFIRM='RESTORE SIRK CENTRAL' \
  bash /opt/sirk-central/deploy/restore.sh /var/backups/sirk-central/sirk-central-<DATA>.tar.gz
```

Backup może być szyfrowany `age` przez ustawienie `SIRK_BACKUP_AGE_RECIPIENT`.

## Operacje awaryjne

Reset hasła break-glass:

```bash
sudo bash /opt/sirk-central/deploy/reset-admin-password.sh
```

Rotacja Access URL:

```bash
sudo bash /opt/sirk-central/deploy/rotate-access-key.sh
```

Zmiana hasła lub klucza dostępu unieważnia aktywne sesje break-glass.

## Weryfikacja wdrożenia

```bash
cd /opt/sirk-central

docker compose config
docker compose ps
docker compose logs --tail=200 caddy central

curl -fsS https://central.sirkportal.com/healthz
curl -fsS https://central.sirkportal.com/readyz
```

Testy developerskie:

```bash
npm ci
npm test
npm run check
```

Przed połączeniem wersji z `main` wymagane są działające testy CI oraz smoke test czystej instalacji na nieprodukcyjnym VPS.
