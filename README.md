# SIRK Central

SIRK Central jest wielotenantowym management plane dla instalacji SIRK Portal.

```text
Branch: main
Runtime: src/server-v15.js
Version: 1.0.0-rc.25
Storage: single-writer file-backed
```

`main` jest jedyną kanoniczną gałęzią wdrożeniową. Wersja pozostaje RC do czasu pełnego CI oraz testów na rzeczywistym VPS.

## Jeden runtime

Jedynym entrypointem aplikacji jest:

```text
src/server-v15.js
```

Ten sam plik jest wskazany przez `package.json`, oba Dockerfile, CI, Security Audit i acceptance test.

Usunięto alternatywne i nieużywane ścieżki:

- stary `entry.js` i równoległy `server.js`;
- preload podmieniający `http.createServer`;
- preload podmieniający moduł przez `require.cache`;
- stare wrappery `server-hardened` i `server-production`;
- duplikat persistent session map;
- legacy `start:legacy`;
- starą nazwę resetu administratora;
- helper pokazujący wpisywane hasło oraz redundantny generator klucza.

Pliki `server-v1.js` do `server-v14.js` nie są alternatywnymi runtime. Są aktywnymi warstwami importowanymi przez `server-v15.js`. Skrypt `scripts/validate-no-legacy-runtime.js` sprawdza ich osiągalność i blokuje dodanie drugiego entrypointu.

## Główne mechanizmy

- Entra ID Authorization Code + PKCE;
- BreakGlass z Access URL;
- passkeys/WebAuthn, YubiKey i recovery codes;
- trwałe hashowane sesje z idle i absolute expiry;
- globalna walidacja CSRF, Origin i Sec-Fetch-Site;
- RBAC oraz rozdzielenie Admin/SecAdmin;
- tamper-evident audit;
- Approval Center z exact-scope i single-use approvals;
- podpisany protokół Portal heartbeat/telemetry/commands;
- cooperative command cancellation;
- provider-independent ticket projection;
- fail-fast single-writer runtime lock;
- updater gateway oddzielony od uprzywilejowanego workera maintenance.

## Canonical Compose

Zawsze używaj obu plików:

```text
docker-compose.yml
docker-compose.portal-runtime.yml
```

Base stack:

```text
central
auth
updater-gateway
backup-manager
caddy
```

Rootowy worker `updater` istnieje wyłącznie w profilu `maintenance` i nie może działać po zakończeniu operacji.

## Instalacja

```bash
curl -fsSL \
  https://raw.githubusercontent.com/Eris92/SIRK-Central/main/deploy/install.sh \
  -o /tmp/install-sirk-central.sh
sudo bash /tmp/install-sirk-central.sh
sudo rm -f /tmp/install-sirk-central.sh
```

Nie używaj `curl | sudo bash`.

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
npm test
npm audit --omit=dev --audit-level=high
```

`npm run check:syntax` oraz `npm test` uruchamiają także audyt braku legacy runtime.

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

Druga instancja na tym samym file-backed storage nie uruchomi się. Active-active będzie wymagało transakcyjnej bazy danych i distributed locking.

## Dokumentacja

- [Bieżący stan](docs/CURRENT-STATUS.md)
- [Architektura](docs/ARCHITECTURE.md)
- [Protokół Central ↔ Portal](docs/PORTAL-PROTOCOL.md)
- [Testy](docs/TESTING.md)
- [Audyt bezpieczeństwa](docs/SECURITY-AUDIT-2026-07-31.md)
- [Polecenie wznowienia](docs/RESUME-PROMPT.md)
