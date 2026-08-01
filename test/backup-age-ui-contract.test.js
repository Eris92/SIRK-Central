"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");

function source(filePath) {
    return fs.readFileSync(filePath, "utf8");
}

test("BreakGlass UI downloads the private age identity without browser persistence", () => {
    const ui = source("public/backup-age-ui.js");
    assert.match(ui, /\/api\/break-glass\/backup-age\/identity/);
    assert.match(ui, /response\.blob\(\)/);
    assert.match(ui, /link\.download = "sirk-central-backup\.agekey"/);
    assert.match(ui, /URL\.revokeObjectURL/);
    assert.doesNotMatch(ui, /localStorage|sessionStorage|indexedDB/);
    assert.doesNotMatch(ui, /identityBlob\.(?:text|arrayBuffer)\(/);
});

test("Central image and UI bundle include age key generation support", () => {
    const dockerfile = source("Dockerfile");
    const assets = source("src/modules/ui-assets.js");
    const server = source("src/server.js");
    assert.match(dockerfile, /apk add --no-cache age/);
    assert.match(assets, /publicPath\("backup-age-ui\.js"\)/);
    assert.match(server, /registerBackupAgeKeyManagement/);
});

test("offline backup prefers the recipient persisted by BreakGlass UI", () => {
    const backup = source("deploy/backup.sh");
    const persisted = backup.indexOf("read_persisted_age_recipient");
    const dotenv = backup.indexOf("read-env-value.py");
    assert.notEqual(persisted, -1);
    assert.notEqual(dotenv, -1);
    assert.ok(persisted < dotenv, "Persisted BreakGlass recipient must be checked before the legacy dotenv fallback.");
    assert.match(backup, /read-backup-age-recipient\.js/);
});
