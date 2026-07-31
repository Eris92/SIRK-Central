# SIRK Central runtime flattening

## Decyzja

Pliki `src/server-v1.js` ... `src/server-v15.js` sa przejsciowym dlugiem architektonicznym, a nie docelowym modelem runtime.

Stan docelowy:

- jeden entrypoint: `src/server.js`;
- dokladnie jedno `http.createServer()` dla aplikacji Central;
- jeden router requestow i jeden handler `upgrade`;
- wspolne funkcje HTTP, cookies, body parsing, CSRF, audit context i error mapping w `src/http/`;
- funkcje biznesowe rejestrowane przez nazwane moduly w `src/modules/`;
- zero plikow `server-v*.js`.

## Problem obecnej architektury

Kazda kolejna wersja tworzy nowy serwer HTTP, pobiera handler poprzedniego serwera przez `listeners("request")[0]`, obsluguje swoje trasy i przekazuje pozostale requesty do nizszej warstwy.

Powoduje to:

- do 15 przejsc przez lancuch handlerow dla pojedynczego requestu;
- wiele kopii `json()`, `readBody()`, `parseCookies()`, CSRF i actor lookup;
- zaleznosc zachowania od kolejnosci historycznych wersji;
- trudniejsze profilowanie, testowanie i obsluge bledow;
- ryzyko roznic limitow body, naglowkow security i semantyki bledow pomiedzy trasami;
- brak czytelnej granicy pomiedzy transportem HTTP a logika domenowa.

## Docelowa struktura

```text
src/
  server.js
  application.js
  http/
    router.js
    request.js
    response.js
    security.js
    errors.js
    websocket.js
  modules/
    auth/
    break-glass/
    webauthn/
    ui-assets/
    continuity/
    maintenance/
    portal-telemetry/
    organizations/
    security/
    approvals/
    portal-commands/
    tickets/
  stores/
  services/
```

Kazdy modul eksportuje funkcje w stylu:

```js
function createModule(context) {
    return {
        routes: [handlerA, handlerB],
        upgrades: [upgradeHandler],
        close: async () => {}
    };
}
```

Router konczy obsluge po pierwszej trasie zwracajacej `true`. Modul nie tworzy wlasnego serwera HTTP i nie zna poprzedniej ani nastepnej warstwy.

## Mapowanie obecnych warstw

| Warstwa przejsciowa | Odpowiedzialnosc docelowa |
|---|---|
| `server-v1` | application context, podstawowe API, stores, WebSocket tunnel |
| `server-v2` | auth hardening, CSRF, recovery codes, login transactions |
| `server-v3` | Break-Glass MFA UI route |
| `server-v4` | WebAuthn authentication and passkey store |
| `server-v5` | passkey management and readiness |
| `server-v6` | WebAuthn attestation |
| `server-v7` | UI asset bundle and readiness aggregation |
| `server-v8` | continuity, audit, maintenance proxy and security policy |
| `server-v9` | update, backup and restore API |
| `server-v10` | Portal heartbeat and telemetry |
| `server-v11` | organizations, assignments and administrative APIs |
| `server-v12` | security center APIs |
| `server-v13` | approval workflow |
| `server-v14` | Portal commands and operations |
| `server-v15` | tickets, SSO callback, upgrade guard and runtime lock |

## Kolejnosc migracji

Migracja idzie od gory lancucha, aby kazdy etap zmniejszal liczbe wrapperow bez zmiany kontraktow zewnetrznych.

1. Wyciagnac wspolny transport HTTP i error mapping.
2. Przeniesc tickety z `server-v15` do `modules/tickets` i utworzyc `server.js` jako nowy entrypoint.
3. Przeniesc komendy Portal z `server-v14` do `modules/portal-commands`.
4. Przeniesc approvals, security i admin APIs.
5. Przeniesc telemetry oraz maintenance/update/restore.
6. Przeniesc WebAuthn, Break-Glass i auth.
7. Przeniesc bazowy context, podstawowe API oraz WebSocket z `server-v1`.
8. Usunac ostatni plik `server-v*.js` i zmienic `package.json` na `src/server.js`.

Po kazdym kroku:

- liczba `server-v*.js` musi spasc;
- `VERSIONED_LAYER_BUDGET` w `scripts/validate-runtime-architecture.js` musi zostac obnizony w tym samym commicie;
- testy API i security musza pozostac zielone;
- nie wolno tworzyc adaptera, ktory ponownie buduje lancuch wielu `http.createServer()`.

## Kryterium zakonczenia

Refactor jest zakonczony dopiero, gdy:

```text
find src -maxdepth 1 -name 'server-v*.js' | wc -l
```

zwraca `0`, `package.json` uruchamia `src/server.js`, a validator raportuje:

```text
Runtime architecture validation passed: one flat canonical server and zero versioned runtime layers.
```
