# SIRK Central

Centralny panel zarządzania dla wielu instalacji **SIRK Portal**. Projekt odpowiada za centralny RBAC, zarządzanie tenantami, użytkownikami, klientami, lokalizacjami i połączonymi Portalami oraz za publiczny punkt logowania Entra ID.

## Architektura

Projekt składa się z trzech usług uruchamianych przez Docker Compose:

- `central` — panel SIRK Central i API,
- `auth` — broker logowania Entra ID,
- `caddy` — wspólny reverse proxy, TLS i serwowanie stron statycznych.

Ten sam Caddy obsługuje również publiczną stronę firmową `sir-k.pl` zamontowaną tylko do odczytu z `/opt/sir-k.pl`.

```text
Internet
   |
   v
Caddy :80/:443
   |-- sirkportal.com          -> statyczna strona produktu
   |-- central.sirkportal.com  -> SIRK Central
   |-- auth.sirkportal.com     -> SIRK Auth
   |-- sir-k.pl                -> /opt/sir-k.pl
   `-- www.sir-k.pl            -> redirect do sir-k.pl
```

Lokalne Portale inicjują wychodzące połączenie WSS do Central. Nie wymagają publicznego adresu, przekierowania portów ani wystawienia lokalnego HTTP do Internetu.

## Publiczne adresy

| Adres | Rola |
|---|---|
| `https://sirkportal.com` | publiczna strona produktu SIRK Portal |
| `https://central.sirkportal.com` | panel SIRK Central |
| `https://auth.sirkportal.com` | broker logowania Entra ID |
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
- `SecAdmin` — bezpieczeństwo, zatwierdzanie uprzywilejowanych dostępów i role bezpieczeństwa,
- `Admin` — administracja tenantami, użytkownikami i Portalami,
- `Auditor` — dostęp tylko do odczytu i audytu,
- `Operator` — obsługa operacyjna w przydzielonym zakresie.

`Admin` i `SecAdmin` są rozdzielone. Uprzywilejowane przypisania pochodzące z grup Entra mogą wymagać zatwierdzenia w Central.

Kanoniczny obszar zarządzania uprawnieniami znajduje się pod:

```text
/permissions
```

Dostęp mają `Admin`, `SecAdmin` oraz `BreakGlass`. Trasa `/admin` nie jest używana.

## DNS

Wymagane rekordy powinny wskazywać na VPS z Caddy:

```text
sirkportal.com          A/AAAA -> VPS
www.sirkportal.com      A/AAAA -> VPS
central.sirkportal.com  A/AAAA -> VPS
auth.sirkportal.com     A/AAAA -> VPS
sir-k.pl                A/AAAA -> VPS
www.sir-k.pl            A/AAAA -> VPS
```

Nie publikuj rekordu `AAAA`, jeżeli wskazuje na inny serwer niż VPS. Błędny IPv6 powoduje, że ACME i użytkownicy mogą trafiać do starego hostingu zamiast do Caddy.

Porty publiczne:

```text
80/tcp   ACME HTTP-01 i redirect HTTPS
443/tcp  HTTPS dla wszystkich domen
443/udp  HTTP/3, jeżeli jest dozwolony
```

## Katalogi na VPS

```text
/opt/sirk-central   repozytorium i Docker Compose SIRK Central
/opt/sir-k.pl       statyczna strona firmowa montowana do Caddy
```

Caddy montuje stronę firmową przez:

```yaml
${SIRK_BUSINESS_SITE_PATH:-/opt/sir-k.pl}:/srv/sir-k:ro
```

## Czysta instalacja

```bash
curl -fsSL \
  https://raw.githubusercontent.com/Eris92/SIRK-Central/main/deploy/install.sh \
  -o /tmp/install-sirk-central.sh

sudo bash /tmp/install-sirk-central.sh
sudo rm -f /tmp/install-sirk-central.sh
```

Nie używaj `curl | sudo bash`, ponieważ instalator pobiera dane interaktywnie.

Instalator:

- obsługuje Ubuntu i Debian,
- instaluje Docker Engine i Compose plugin, jeśli ich brakuje,
- tworzy klon Git w `/opt/sirk-central`,
- tworzy `.env`,
- generuje lokalne dane `break-glass`,
- konfiguruje UFW,
- buduje i uruchamia kontenery.

## Najważniejsze zmienne `.env`

| Zmienna | Przykład |
|---|---|
| `SIRK_WEBSITE_DOMAIN` | `sirkportal.com` |
| `SIRK_CENTRAL_DOMAIN` | `central.sirkportal.com` |
| `SIRK_AUTH_DOMAIN` | `auth.sirkportal.com` |
| `SIRK_BUSINESS_DOMAIN` | `sir-k.pl` |
| `SIRK_BUSINESS_SITE_PATH` | `/opt/sir-k.pl` |
| `SIRK_ACME_EMAIL` | adres administratora certyfikatów |
| `SIRK_SSO_SHARED_SECRET` | współdzielony sekret Central/Auth |
| `SIRK_ADMIN_USERNAME` | lokalne konto awaryjne |
| `SIRK_SESSION_HOURS` | czas sesji, domyślnie `8` |

Sekretów nie należy umieszczać w repozytorium ani w dokumentacji publicznej.

## Aktualizacja istniejącej instalacji

Standardowa aktualizacja:

```bash
cd /opt/sirk-central
sudo bash ./deploy/update.sh
```

Skrypt pobiera `origin/main`, waliduje konfigurację, przebudowuje obrazy i odtwarza `central`, `auth` oraz `caddy`.

Ręczne odtworzenie usług:

```bash
cd /opt/sirk-central
docker compose --profile auth up -d --build --force-recreate central auth caddy
```

Restart samego Caddy:

```bash
cd /opt/sirk-central
docker compose --profile auth restart caddy
```

## Aktualizacja strony `sir-k.pl`

Strona firmowa jest osobnym repozytorium, ale korzysta z tego samego Caddy:

```bash
cd /opt/sir-k.pl
git fetch --prune origin
git reset --hard origin/main
```

Ponieważ katalog jest zamontowany bezpośrednio do kontenera tylko do odczytu, zwykle nie jest potrzebna przebudowa. W razie potrzeby:

```bash
cd /opt/sirk-central
docker compose --profile auth restart caddy
```

## Operacje awaryjne

Reset lokalnego hasła administratora:

```bash
sudo bash /opt/sirk-central/deploy/reset-admin-password.sh
```

Rotacja klucza `access`:

```bash
sudo bash /opt/sirk-central/deploy/rotate-access-key.sh
```

Docelowo konto `break-glass` powinno wspierać klucz sprzętowy YubiKey jako dodatkowy, zalecany mechanizm ochrony.

## Weryfikacja wdrożenia

```bash
cd /opt/sirk-central

docker compose --profile auth config
docker compose --profile auth ps
docker compose --profile auth logs --tail=150 caddy central auth

curl -I https://sirkportal.com
curl -I https://central.sirkportal.com
curl -I https://auth.sirkportal.com
curl -I https://sir-k.pl
curl -I https://www.sir-k.pl
```

Sprawdzenie DNS z pominięciem lokalnego cache:

```bash
dig @1.1.1.1 +short A sir-k.pl
dig @1.1.1.1 +short AAAA sir-k.pl
dig @1.1.1.1 +short A central.sirkportal.com
dig @1.1.1.1 +short AAAA central.sirkportal.com
```

Oczekiwane zachowanie:

- wszystkie domeny trafiają do Caddy na tym samym VPS,
- `www.*` przekierowuje na domenę kanoniczną,
- odpowiedzi zawierają `server: Caddy` lub `via: 1.1 Caddy`,
- panel Central i Auth nie są indeksowane przez wyszukiwarki,
- żadna publiczna strona nie zawiera nazw klientów, tenantów ani wewnętrznych adresów.

## Development i testy

```bash
npm ci
npm test
```

Przed wdrożeniem należy sprawdzić testy, konfigurację Compose oraz brak danych klientów w publicznych plikach.