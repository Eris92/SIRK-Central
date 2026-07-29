# SIRK Central

Centralny management plane i broker tuneli dla lokalnych instalacji **SIRK Portal**.

## Publiczne adresy

| Adres | Rola |
|---|---|
| `https://sirkportal.com` | publiczna strona produktu |
| `https://central.sirkportal.com` | panel SIRK Central i endpoint tunelu |
| `https://auth.sirkportal.com` | planowany SIRK Auth Broker |

Strona produktu jest serwowana bezpośrednio przez Caddy z katalogu `website/`.
Nie jest reverse-proxy do aplikacji Central, dlatego nie udostępnia tras API,
`/connect` ani WebSocket `/tunnel`.

Publiczny landing page używa wyłącznie anonimowych danych demonstracyjnych.
Nie wolno umieszczać w nim nazw klientów, identyfikatorów tenantów ani subdomen
instalacji klientów. Test `test/public-website.test.js` blokuje dodatkowe hosty
`*.sirkportal.com` poza domeną produktu, Auth Brokerem i SIRK Central.

## Model połączenia

```text
Przeglądarka administratora -> HTTPS -> SIRK Central
                                           ^
                                           |
                                 WSS wychodzący
                                           |
                                     SIRK Portal
```

Lokalny Portal inicjuje trwałe połączenie WSS do Central. Nie wymaga publicznego
adresu, przekierowania portów ani wystawienia lokalnego HTTP do Internetu.

Aktualny lokalny login SIRK Central wymaga dodatkowego klucza we fragmencie URL:

```text
https://central.sirkportal.com/#access=<KLUCZ>
```

Fragment nie trafia do logów HTTP ani nagłówka `Referer`. Klucz URL jest
warstwą discovery i nie zastępuje uwierzytelnienia administratora.

## Wymagania DNS

Przed uruchomieniem ustaw rekordy wskazujące na VPS:

```text
sirkportal.com          A/AAAA -> VPS
www.sirkportal.com      A/AAAA -> VPS
central.sirkportal.com  A/AAAA -> VPS
```

Porty publiczne:

```text
80/tcp   ACME HTTP-01 i redirect HTTPS
443/tcp  strona produktu oraz SIRK Central
```

## Czysta instalacja

Instalator:

- obsługuje Ubuntu i Debian,
- instaluje Docker Engine i Compose plugin, jeśli ich brakuje,
- tworzy prawdziwy klon Git w `/opt/sirk-central`,
- pyta o domeny, adres ACME, użytkownika i hasło,
- generuje jednorazowy URL access key,
- tworzy `.env` z hashami zamiast plaintext credentials,
- konfiguruje UFW dla SSH, HTTP i HTTPS,
- buduje i uruchamia kontenery.

Pobierz skrypt do pliku, a następnie uruchom go interaktywnie:

```bash
curl -fsSL \
  https://raw.githubusercontent.com/Eris92/SIRK-Central/main/deploy/install.sh \
  -o /tmp/install-sirk-central.sh

sudo bash /tmp/install-sirk-central.sh
rm -f /tmp/install-sirk-central.sh
```

Nie używaj bezpośrednio `curl | sudo bash`, ponieważ instalator wymaga terminala
do bezpiecznego wprowadzenia hasła.

### Instalacja ze zmiennymi

Domeny i parametry niesekretne można przekazać przez `sudo env`:

```bash
curl -fsSL \
  https://raw.githubusercontent.com/Eris92/SIRK-Central/main/deploy/install.sh \
  -o /tmp/install-sirk-central.sh

sudo env \
  SIRK_WEBSITE_DOMAIN=sirkportal.com \
  SIRK_CENTRAL_DOMAIN=central.sirkportal.com \
  SIRK_ACME_EMAIL=admin@sir-k.pl \
  SIRK_ADMIN_USERNAME=admin \
  SIRK_SESSION_HOURS=8 \
  bash /tmp/install-sirk-central.sh

rm -f /tmp/install-sirk-central.sh
```

Hasło administratora zawsze jest pobierane interaktywnie i nie jest przekazywane
w argumentach procesu ani zapisywane jako plaintext w `.env`.

Dostępne zmienne:

| Zmienna | Domyślna wartość |
|---|---|
| `SIRK_REPO_URL` | `https://github.com/Eris92/SIRK-Central.git` |
| `SIRK_REPO_REF` | `main` |
| `SIRK_INSTALL_DIR` | `/opt/sirk-central` |
| `SIRK_WEBSITE_DOMAIN` | `sirkportal.com` |
| `SIRK_CENTRAL_DOMAIN` | `central.<website-domain>` |
| `SIRK_ACME_EMAIL` | `admin@<website-domain>` |
| `SIRK_ADMIN_USERNAME` | `admin` |
| `SIRK_SESSION_HOURS` | `8`, zakres `1-24` |
| `SIRK_CONFIGURE_UFW` | `1` |
| `SIRK_SSH_PORT` | port bieżącej sesji SSH lub `22` |
| `SIRK_FORCE` | `0`; wartość `1` archiwizuje istniejący katalog |

Instalator nie usuwa automatycznie istniejących Docker volumes. Opcja `--force`
archiwizuje poprzedni katalog do `/opt/sirk-central.backup-<UTC_TIMESTAMP>`.

## Aktualizacja istniejącej instalacji

Instalacja utworzona przez `deploy/install.sh` jest normalnym klonem Git.
Aktualizację wykonaj poleceniem:

```bash
sudo /opt/sirk-central/deploy/update.sh
```

Skrypt:

1. sprawdza obecność `.git` i `.env`,
2. tworzy kopię `.env` w `/root`,
3. wykonuje `git fetch`, `git checkout main` i `git pull --ff-only`,
4. sprawdza `docker compose config`,
5. przebudowuje i aktualizuje kontenery.

Jeśli starsza instalacja nie ma katalogu `.git`, wykonaj czystą instalację przez
`deploy/install.sh` zamiast ręcznie kopiować pliki.

## Ręczna konfiguracja istniejącego klonu

```bash
cd /opt/sirk-central

sudo env \
  SIRK_WEBSITE_DOMAIN=sirkportal.com \
  SIRK_CENTRAL_DOMAIN=central.sirkportal.com \
  SIRK_ACME_EMAIL=admin@sir-k.pl \
  SIRK_ADMIN_USERNAME=admin \
  SIRK_SESSION_HOURS=8 \
  ./deploy/configure-and-start.sh
```

Konfigurator zapisuje wyłącznie hashe hasła i access key. Pełny URL z kluczem
jest pokazywany jednorazowo w terminalu.

Reset hasła administratora bez zmiany access key:

```bash
sudo /opt/sirk-central/deploy/reset-admin-password.sh
```

Rotacja access key bez zmiany hasła:

```bash
sudo /opt/sirk-central/deploy/rotate-access-key.sh
```

## Development i testy

```bash
npm ci
npm test
```

## Weryfikacja wdrożenia

```bash
cd /opt/sirk-central

docker compose config
docker compose ps
docker compose logs --tail=100 caddy central

curl -I https://sirkportal.com
curl -I https://www.sirkportal.com
curl -fsS https://central.sirkportal.com/healthz
```

Oczekiwane wyniki:

- `sirkportal.com` zwraca `200`,
- `www.sirkportal.com` zwraca permanent redirect do `sirkportal.com`,
- `central.sirkportal.com/healthz` zwraca `200` i `{"ok":true}`,
- panel Central nie jest indeksowany przez wyszukiwarki.
