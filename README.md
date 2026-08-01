# SIRK Central

SIRK Central jest wielotenantowym management plane dla instalacji SIRK Portal.

```text
Canonical branch: main
Runtime: src/server.js
Version: 1.0.0-rc.26
Storage: single-writer file-backed
```

`main` pozostaje jedyną kanoniczną gałęzią wdrożeniową. Wersja pozostaje RC do czasu zakończenia walidacji środowiskowej na nieprodukcyjnym VPS.

## Jeden runtime

Jedynym entrypointem aplikacji jest:

```text
src/server.js
```

Ten sam entrypoint jest używany przez `package.json`, obraz Central, CI, Security Audit i acceptance test.

Usunięto alternatywne i historyczne ścieżki:

- `server-v1.js`–`server-v15.js`;
- stary `entry.js` oraz równoległe serwery hardened/production;
- preload podmieniający `http.createServer` lub `require.cache`;
- store’y i API z sufiksem `-v2`;
- duplikat persistent session map;
- legacy `start:legacy`;
- stare helpery resetu administratora i generowania sekretów;
- etapowe uruchamianie części runtime.

Central używa jednego serwera HTTP, jednego handlera WebSocket upgrade, wspólnego transportu HTTP i nazwanych modułów w `src/modules/`.

## Główne mechanizmy

- Entra ID Authorization Code + PKCE;
- BreakGlass z Access URL;
- passkeys/WebAuthn, YubiKey i recovery codes;
- trwałe hashowane sesje z idle i absolute expiry;
- CSRF dla mutacji sesji przeglądarkowej oraz osobna podpisana granica protokołu Portal;
- RBAC oraz rozdzielenie Admin/SecAdmin;
- tamper-evident audit;
- Approval Center z exact-scope i single-use approvals;
- podpisany protokół Portal heartbeat/telemetry/commands;
- tunel Portal z RBAC, izolacją cookies i przepisywaniem ścieżek;
- cooperative command cancellation;
- provider-independent ticket projection;
- fail-fast single-writer runtime lock;
- updater gateway oddzielony od uprzywilejowanego workera maintenance;
- izolowany backup manager bez Docker socketu.

## Canonical Compose

Jedyną definicją stacku jest:

```text
docker-compose.yml
```

Base stack:

```text
central
auth
updater-gateway
backup-manager
caddy
```

`backup-manager` nie publikuje portów, nie montuje Docker socketu i widzi dane Central tylko do odczytu. Rootowy worker `updater` istnieje wyłącznie w profilu `maintenance` i nie może działać po zakończeniu operacji.

## Instalacja

```bash
curl -fsSL \
  https://raw.githubusercontent.com/Eris92/SIRK-Central/main/deploy/install.sh \
  -o /tmp/install-sirk-central.sh
sudo bash /tmp/install-sirk-central.sh
sudo rm -f /tmp/install-sirk-central.sh
```

Nie przekazuj zdalnie pobranego instalatora bezpośrednio do powłoki uruchomionej jako root. Najpierw zapisz plik, sprawdź go i dopiero wtedy uruchom.

## Operacje awaryjne

Reset hasła BreakGlass:

```bash
sudo bash /opt/sirk-central/deploy/reset-breakglass-password.sh
```

Rotacja Access Key:

```bash
sudo bash /opt/sirk-central/deploy/rotate-access-key.sh
```

Obie operacje:

- używają kanonicznego Compose;
- zatrzymują Central przed zmianą danych;
- aktualizują `.env` atomowo z backupem;
- wykonują offline update security overrides;
- unieważniają lokalne i BreakGlass sessions;
- wymagają poprawnego health checku po restarcie;
- sprawdzają, że uprzywilejowany updater nie pozostał uruchomiony.

## Walidacja

```bash
npm ci
npm run check:syntax
SIRK_CONCURRENCY_TEST_REQUESTS=24 npm test
npm audit --omit=dev --audit-level=high
```

`npm run check:syntax` oraz `npm test` uruchamiają walidator płaskiej architektury i odrzucają powrót legacy runtime.

VPS acceptance:

```bash
cd /opt/sirk-central
export SIRK_ACCEPTANCE_PUBLIC_URL='https://central.sirkportal.com'
sudo bash deploy/acceptance-test.sh
```

## Storage

Dane znajdują się w `/var/lib/sirk-central`. Runtime utrzymuje fail-fast lease:

```text
/var/lib/sirk-central/.sirk-central-runtime.lock/owner.json
```

Druga instancja na tym samym file-backed storage nie uruchomi się. Active-active będzie wymagało transakcyjnej bazy danych i distributed locking; nie jest częścią bieżącego zakresu RC.

## Dokumentacja

- [Bieżący stan](docs/CURRENT-STATUS.md)
- [Architektura](docs/ARCHITECTURE.md)
- [Protokół Central ↔ Portal](docs/PORTAL-PROTOCOL.md)
- [Testy](docs/TESTING.md)
- [Audyt bezpieczeństwa](docs/SECURITY-AUDIT-2026-07-31.md)
- [Polecenie wznowienia](docs/RESUME-PROMPT.md)
