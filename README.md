# SIRK Central

SIRK Central jest centralnym, wielotenantowym panelem zarządzania instalacjami SIRK Portal.

```text
Branch: feat/central-production-hardening
PR: #45 (draft)
Runtime: src/server-v15.js
Version: 1.0.0-rc.21
```

PR nie może zostać oznaczony jako ready ani scalony przed zielonym CI, VPS acceptance, backup/restore, update/rollback, YubiKey i Entra tests.

## Dokumentacja

- [Bieżący stan](docs/CURRENT-STATUS.md)
- [Architektura](docs/ARCHITECTURE.md)
- [Protokół Central ↔ Portal](docs/PORTAL-PROTOCOL.md)
- [Testy](docs/TESTING.md)
- [Audyt bezpieczeństwa](docs/SECURITY-AUDIT-2026-07-31.md)
- [Polecenie wznowienia](docs/RESUME-PROMPT.md)

## Kanoniczny runtime

```text
src/server-v15.js
```

Ten sam runtime jest wymagany przez:

- `package.json` i `package-lock.json`;
- `Dockerfile.portal-runtime`;
- `.github/workflows/ci.yml`;
- `.github/workflows/security-audit.yml`;
- `deploy/acceptance-test.sh`.

Warstwy wcześniejszych runtime są częścią kompozycji. Nie przełączaj kontenera na niższy numer.

## Funkcje

### Identity i bezpieczeństwo

- Entra ID Authorization Code + PKCE;
- lokalny BreakGlass;
- ukryty Access URL;
- passkeys/WebAuthn i YubiKey;
- recovery codes;
- trwałe sesje z idle i absolute timeout;
- globalny browser CSRF;
- active session management;
- tamper-evident audit;
- centralne blokowanie `pending`, `conflict` i `disabled`;
- rozdzielenie Admin/SecAdmin.

### Approval Center

- jedna lub dwie niezależne decyzje;
- self-approval protection;
- exact-scope i single-use;
- trwały execution state;
- high-risk approval zużywany dopiero przy utworzeniu command;
- retry wysokiego ryzyka wymaga nowej zgody;
- legacy approval mutations są wyłączone.

### Portal monitoring i operations

- signed heartbeat HMAC;
- nonce replay protection;
- rate limiting per IP i Portal;
- telemetry health/version/CPU/RAM/agents/backup/update;
- access-scope filtering;
- trwała kolejka commands;
- delivery lease, ACK, progress, result i timeout;
- secret redaction;
- bezpieczny cancel wyłącznie przed delivery;
- exact-scope approvals dla `update`, `restart`, `diagnostics`.

### Tickets

Central przechowuje projekcje niezależne od providera. Jira, ServiceDesk, GLPI i inne systemy będą integrowane lokalnie przez SIRK Portal.

- snapshot i event ingestion;
- schema v2;
- assignment-bound Tenant/Customer/Site;
- fail-closed default policy `none`;
- description/requester publikowane wyłącznie po jawnej zgodzie;
- replay digest i version conflict detection;
- full snapshot usuwa nieobecne projekcje;
- policy tightening usuwa lub redaguje zapisane dane;
- fail-closed capacity;
- Central-side coordination tylko przy `allowCentralChanges=true`;
- access-scope filtering.

## RBAC

- `BreakGlass` — lokalny awaryjny globalny dostęp;
- `SecAdmin` — bezpieczeństwo, sessions, privileged approvals i audit;
- `Admin` — organization, Portals, updater operations i operational execution;
- `Auditor` — read-only;
- `OperatorL1`, `SupportL2`, `EngineerL3` — role operacyjne.

Role określają typ operacji, a `accessStore` określa widoczne Portale.

## Usługi

Projekt używa dwóch plików Compose:

```text
docker-compose.yml
docker-compose.portal-runtime.yml
```

Pełny stack:

- `central` — canonical v15 API/UI, `USER node`;
- `auth` — Entra broker, `USER node`;
- `backup-manager` — scheduler/read-only data access, `USER node`;
- `updater` — privileged deployment/restore boundary;
- `caddy` — TLS i reverse proxy.

### Updater trust boundary

Updater ma Docker socket i RW do repo/danych, więc jest root-equivalent względem hosta. Compose jawnie ustawia:

```yaml
user: "0:0"
```

Kompensacje:

- internal network;
- brak host port;
- bearer token;
- exact host/path allowlist;
- checksums/manifest/tar validation;
- transactional restore i rollback;
- `no-new-privileges` i `cap_drop: ALL`.

## Publiczne adresy

| Adres | Rola |
|---|---|
| `https://sirkportal.com` | strona produktu |
| `https://central.sirkportal.com` | SIRK Central |
| `https://auth.sirkportal.com` | broker Entra |
| `https://sir-k.pl` | strona firmowa |

Porty Central/Auth/Updater/Backup Manager nie są publikowane bezpośrednio do Internetu.

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

Instalator uruchamia pełny stack przez bazowy Compose i overlay v15.

## Testy

```bash
npm ci
npm run check:syntax
npm test
```

Playwright:

```bash
npm install --no-save @playwright/test@1.58.2
npx playwright install --with-deps chromium
npx playwright test
```

VPS acceptance:

```bash
cd /opt/sirk-central
export SIRK_ACCEPTANCE_PUBLIC_URL='https://central.sirkportal.com'
bash deploy/acceptance-test.sh
```

Portal simulator:

```bash
export SIRK_SIMULATOR_ORIGIN='https://central.sirkportal.com'
export SIRK_SIMULATOR_PORTAL_ID='portal-test'
export SIRK_SIMULATOR_PORTAL_TOKEN='<TOKEN>'
node scripts/portal-simulator.js
```

Portal wymaga assignment i ticket policy innej niż `none`.

## Backup i restore

```bash
sudo bash /opt/sirk-central/deploy/backup.sh
```

```bash
sudo SIRK_RESTORE_CONFIRM='RESTORE SIRK CENTRAL' \
  bash /opt/sirk-central/deploy/restore.sh \
  /var/backups/sirk-central/sirk-central-<DATA>.tar.gz
```

Restore produkcyjny wymaga osobnego drill na nieprodukcyjnym VPS.

## Stan testów

Testy i workflow są przygotowane, ale nie są uznane za zaliczone bez rzeczywistego wyniku GitHub Actions/VPS. Aktualny szczegółowy stan znajduje się w [docs/CURRENT-STATUS.md](docs/CURRENT-STATUS.md).

## Zasada dotycząca SIRK Portal

Nie modyfikować repozytorium SIRK Portal. Repo zawiera niezakończone, niewypchnięte zmiany. Integracja Central↔Portal jest obecnie weryfikowana wyłącznie przez symulator i testy HTTP w SIRK Central.
