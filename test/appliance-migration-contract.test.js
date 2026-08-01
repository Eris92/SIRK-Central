"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");

const migration = fs.readFileSync("deploy/appliance-migrate.sh", "utf8");
const bootstrap = fs.readFileSync("website/migrate", "utf8");

test("migration preserves environment and creates safety backup before update", () => {
    assert.match(migration, /install -m 0600 \.env "\$ENV_BACKUP"/);
    assert.match(migration, /SIRK_BACKUP_REQUIRE_ENCRYPTION=false bash deploy\/backup\.sh/);
    assert.match(migration, /PREVIOUS_COMMIT=/);
    assert.match(migration, /TARGET_COMMIT=/);
});

test("migration validates code before replacing the running stack", () => {
    assert.match(migration, /npm run check:syntax/);
    assert.match(migration, /npm test/);
    assert.match(migration, /npm audit --omit=dev --audit-level=high/);
    assert.match(migration, /compose_appliance config/);
    assert.match(migration, /updater\/appliance-restore-server\.js/);
});

test("migration starts complete appliance and verifies no updater host port", () => {
    assert.match(migration, /docker-compose\.appliance\.yml/);
    assert.match(migration, /central auth updater-gateway updater backup-manager caddy/);
    assert.match(migration, /readyz/);
    assert.match(migration, /NetworkSettings\.Ports/);
    assert.match(migration, /privileged updater unexpectedly publishes a host port/);
});

test("migration rolls back repository environment and base stack on failure", () => {
    assert.match(migration, /rollback\(\)/);
    assert.match(migration, /git reset --hard "\$PREVIOUS_COMMIT"/);
    assert.match(migration, /install -m 0600 "\$ENV_BACKUP" \.env/);
    assert.match(migration, /docker compose -f docker-compose\.yml --profile auth up/);
});

test("public migration endpoint downloads canonical script over strict HTTPS", () => {
    assert.match(bootstrap, /raw\.githubusercontent\.com\/Eris92\/SIRK-Central\/main\/deploy\/appliance-migrate\.sh/);
    assert.match(bootstrap, /--proto '=https'/);
    assert.match(bootstrap, /--tlsv1\.2/);
    assert.match(bootstrap, /exec bash/);
});
