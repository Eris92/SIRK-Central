"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");

function source(filePath) { return fs.readFileSync(filePath, "utf8"); }

test("BreakGlass UI downloads only the encrypted persisted key bundle", () => {
    const ui = source("public/backup-age-ui.js");
    assert.match(ui, /\/api\/break-glass\/backup-age\/identity/);
    assert.match(ui, /\/api\/break-glass\/backup-age\/export/);
    assert.match(ui, /response\.blob\(\)/);
    assert.match(ui, /link\.download = "sirk-central-backup-key\.sirkkey"/);
    assert.match(ui, /URL\.revokeObjectURL/);
    assert.match(ui, /keyPersisted/);
    assert.doesNotMatch(ui, /localStorage|sessionStorage|indexedDB/);
    assert.doesNotMatch(ui, /AGE-SECRET-KEY-/);
});

test("encrypted restore asks for BreakGlass password and never uploads an identity file", () => {
    const ui = source("public/encrypted-backup-ui.js");
    assert.match(ui, /breakGlassPassword/);
    assert.match(ui, /Lokalny zaszyfrowany klucz/);
    assert.doesNotMatch(ui, /input\.type = "file"/);
    assert.doesNotMatch(ui, /\.agekey/);
    assert.doesNotMatch(ui, /AGE-SECRET-KEY-/);
});

test("Central image and UI bundle include encrypted age key support", () => {
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
