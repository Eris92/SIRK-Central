# SIRK Central

Centralny management plane i broker tuneli dla lokalnych instalacji **SIRK Portal**.

## Publiczne adresy

| Adres | Rola |
|---|---|
| `https://sirkportal.com` | publiczna strona produktu |
| `https://central.sirkportal.com` | panel SIRK Central i endpoint tunelu |
| `https://auth.sirkportal.com` | planowany SIRK Auth Broker |

Strona produktu jest serwowana bezpośrednio przez Caddy z katalogu `website/`.
Nie jest reverse-proxy do aplikacji Central, dzięki czemu nie udostępnia tras API,
`/connect` ani WebSocket `/tunnel`.

## Aktualny model połączenia

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

Aktualny lokalny login SIRK Central pozostaje mechanizmem administracyjnym i
wymaga dodatkowego klucza we fragmencie URL:

```text
https://central.sirkportal.com/#access=<KLUCZ>
```

Fragment nie trafia do logów HTTP ani nagłówka `Referer`. Klucz URL jest wyłącznie
dodatkową bramą discovery i nie zastępuje uwierzytelnienia administratora.

## Uruchomienie lokalne

1. `npm install`
2. `npm run hash-password`
3. `npm run generate-access-key`
4. Skopiuj `.env.example` do `.env` i ustaw wygenerowane hashe.
5. `npm start`

## Wdrożenie produkcyjne

Wymagane rekordy DNS wskazujące na VPS:

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

`compose.yaml` uruchamia SIRK Central za Caddy. Caddy:

- serwuje `website/` dla `sirkportal.com`,
- przekierowuje `www.sirkportal.com` do domeny głównej,
- reverse-proxy `central.sirkportal.com` do aplikacji,
- pobiera i odnawia certyfikaty Let's Encrypt.

Na nowym VPS:

```bash
cd /opt/sirk-central
./deploy/configure-and-start.sh
```

Konfigurator zapisuje tylko hashe hasła i klucza. Pełny adres z kluczem pokazuje
jednorazowo w terminalu administratora.

Reset hasła administratora bez zmiany klucza URL:

```bash
cd /opt/sirk-central
./deploy/reset-admin-password.sh
```

Rotacja klucza URL bez zmiany hasła:

```bash
cd /opt/sirk-central
./deploy/rotate-access-key.sh
```

## Weryfikacja

```bash
docker compose config
docker compose up -d --build
docker compose ps
curl -I https://sirkportal.com
curl -I https://www.sirkportal.com
curl -I https://central.sirkportal.com/healthz
```

Oczekiwane wyniki:

- `sirkportal.com` zwraca `200`,
- `www.sirkportal.com` zwraca redirect permanent do `sirkportal.com`,
- `central.sirkportal.com/healthz` zwraca `200`,
- panel Central nie jest indeksowany przez wyszukiwarki.
