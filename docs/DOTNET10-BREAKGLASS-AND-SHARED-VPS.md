# SIRK Central .NET 10 — Break Glass i wspólny VPS

## Kontrakt logowania

### Bez Access URL

`https://central.sirkportal.com/` pokazuje wyłącznie logowanie Microsoft Entra.
Lokalny formularz Break Glass pozostaje ukryty.

### Z poprawnym Access URL

`https://central.sirkportal.com/#access=<kod>` pokazuje na tym samym ekranie:

- logowanie Microsoft Entra,
- lokalny formularz `Użytkownik + Hasło`.

Access code nie tworzy sesji i nie zastępuje uwierzytelnienia. Odsłania tylko lokalną ścieżkę oraz jest ponownie sprawdzany przy logowaniu.

### Pierwsze logowanie Break Glass

1. Access URL.
2. Użytkownik i hasło.
3. Jeżeli nie istnieje ani aktywny Windows Hello/YubiKey/passkey, ani recovery code, tworzona jest sesja.
4. Interfejs rekomenduje rejestrację MFA.

Nie wolno wymagać składnika, który nie został jeszcze zarejestrowany.

### Kolejne logowania po konfiguracji MFA

1. Access URL.
2. Użytkownik i hasło.
3. Backend wystawia krótką, jednorazową transakcję pre-auth. Nie tworzy jeszcze sesji.
4. Użytkownik potwierdza przez:
   - Windows Hello,
   - YubiKey/WebAuthn/passkey,
   - jednorazowy recovery code.
5. Dopiero poprawny drugi składnik tworzy sesję Break Glass.

Transakcja pre-auth jest ważna 5 minut, jednorazowa i związana z adresem klienta oraz User-Agent. Recovery codes są zapisywane wyłącznie jako hashe i są usuwane po użyciu.

## Topologia domen

Wszystkie usługi mogą działać na jednym VPS i jednym Caddy, ale pozostają niezależnymi hostami:

| Domena | Źródło | Funkcja |
|---|---|---|
| `central.sirkportal.com` | kontener `sirk-central-test` | aplikacja SIRK Central .NET 10 |
| `sirkportal.com` | `/opt/sirk-central/source/website` | publiczna strona produktu SIRK |
| `sir-k.pl` | osobne repo `/opt/sir-k.pl` | strona firmowa Sir-K |
| `auth.sirkportal.com` | alias edge | przekierowanie zgodności do natywnego logowania Entra w Central |

`sirkportal.com` i `sir-k.pl` nie mogą być przekierowywane do Central i nie mogą używać jego `index.html`.

## Niedestrukcyjny upgrade istniejącego VPS

Zachowuje:

- `/opt/sirk-central/data`,
- `/opt/sirk-central/secrets`,
- konto i hasło Break Glass,
- access code,
- certyfikaty Caddy,
- repo strony `sir-k.pl`.

```bash
cd / && curl -fsSL https://raw.githubusercontent.com/Eris92/SIRK-Central/rewrite/dotnet10/deploy/upgrade-dotnet10-vps.sh | env CENTRAL_HOST=central.sirkportal.com WEBSITE_HOST=sirkportal.com BUSINESS_HOST=sir-k.pl AUTH_HOST=auth.sirkportal.com ACME_EMAIL=admin@sirkportal.com bash
```

## Pełny reinstall

Usuwa dane i sekrety Central, tworzy nowy bootstrap Break Glass, a następnie uruchamia tę samą finalną topologię trzech hostów.

```bash
cd / && curl -fsSL https://raw.githubusercontent.com/Eris92/SIRK-Central/rewrite/dotnet10/deploy/install-dotnet10.sh | env FORCE=1 CENTRAL_HOST=central.sirkportal.com WEBSITE_HOST=sirkportal.com BUSINESS_HOST=sir-k.pl AUTH_HOST=auth.sirkportal.com ACME_EMAIL=admin@sirkportal.com bash
```

## Minimalna weryfikacja

```bash
docker ps
curl -fsS https://central.sirkportal.com/healthz | jq
curl -fsS https://central.sirkportal.com/api/v1/system/version | jq
curl -fsS https://sirkportal.com/ | grep -F 'SIRK — Central, Portal i Agent'
curl -fsS https://sir-k.pl/ | grep -F 'Krzysztof Lechmyc | Sir-K'
```

Weryfikacja Access URL bez ujawniania wartości w logu aplikacji:

```bash
ACCESS_CODE="$(cat /root/sirk-central-breakglass-access-code.txt)"
curl -fsS -H "Authorization: Bearer ${ACCESS_CODE}" https://central.sirkportal.com/api/access | jq
unset ACCESS_CODE
```

Oczekiwany wynik zawiera `localLoginEnabled: true`.
