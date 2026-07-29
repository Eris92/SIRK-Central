# SIRK Portal Central

Centralny broker zarządzania dla lokalnych instalacji SIRK Portal.

Publiczny adres administracyjny używa certyfikatu Let's Encrypt i portu
`44301`. Wymagany klucz znajduje się we fragmencie URL, dzięki czemu nie trafia
do logów HTTP ani nagłówka Referer:

```text
https://central.sir-k.pl:44301/#access=<KLUCZ>
```

Klucz URL jest dodatkową bramą. Nie zastępuje logowania administratora.

## Model połączenia

```text
Przeglądarka administratora -> HTTPS -> SIRK Portal Central
                                        ^
                                        |
                              WSS wychodzący
                                        |
                                  lokalny Portal
```

Lokalny Portal inicjuje trwałe połączenie WSS do Central. Nie wymaga publicznego
adresu, przekierowania portów ani wystawienia lokalnego HTTP do Internetu.

## Uruchomienie lokalne

1. `npm install`
2. `npm run hash-password`
3. `npm run generate-access-key`
4. Skopiuj `.env.example` do `.env` i ustaw oba wygenerowane hashe.
5. `npm start`

## Wdrożenie

`compose.yaml` uruchamia Central za Caddy. Caddy kończy TLS dla
`central.sir-k.pl:44301`, a aplikacja nasłuchuje wyłącznie w prywatnej sieci
kontenerów. Sekrety pozostają w niesledzonym pliku `.env`.

Na nowym VPS uruchom interaktywnie:

```bash
cd /opt/sirk-central
./deploy/configure-and-start.sh
```

Konfigurator zapisuje tylko hashe hasła i klucza. Pełny adres z kluczem pokazuje
jednorazowo w terminalu administratora.

Reset samego hasła administratora bez zmiany klucza URL:

```bash
cd /opt/sirk-central
./deploy/reset-admin-password.sh
```

Rotacja samego klucza URL bez zmiany hasła:

```bash
cd /opt/sirk-central
./deploy/rotate-access-key.sh
```
