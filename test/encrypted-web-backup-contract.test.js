"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");

const worker = fs.readFileSync("updater/appliance-server.js", "utf8");
const dockerfile = fs.readFileSync("updater/Dockerfile", "utf8");
const ui = fs.readFileSync("public/encrypted-backup-ui.js", "utf8");
const assets = fs.readFileSync("src/modules/ui-assets.js", "utf8");

test("appliance web backups require a valid age recipient", () => {
    assert.match(worker, /backup-age-recipient\.json/);
    assert.match(worker, /\^age1\[0-9a-z\]\{58\}\$/);
    assert.match(worker, /BACKUP_AGE_RECIPIENT_REQUIRED/);
    assert.match(worker, /recipientFingerprint/);
});

test("web backup creates age ciphertext and always removes plaintext", () => {
    assert.match(dockerfile, /apk add --no-cache age/);
    assert.match(worker, /spawnSync\("age"/);
    assert.match(worker, /\.tar\.gz\.age/);
    assert.match(worker, /finally[\s\S]*rmSync\(plaintext/);
    assert.match(worker, /\.sha256/);
    assert.match(worker, /atomicJson\(allocated\.target \+ "\.json"/);
});

test("backup status marks ciphertext for password-only local-key restore", () => {
    assert.match(worker, /encrypted: true/);
    assert.match(worker, /encryption: "age"/);
    assert.match(worker, /restorable: false/);
    assert.match(ui, /\.tar\.gz\.age/);
    assert.match(ui, /restoreAllowed/);
    assert.match(ui, /breakGlassPassword/);
    assert.match(ui, /local encrypted key|lokalnego klucza/);
    assert.doesNotMatch(ui, /\.agekey/);
    assert.match(assets, /encrypted-backup-ui\.js/);
});

test("web backup route keeps existing confirmation and operation lock", () => {
    assert.match(worker, /body\.confirm !== "BACKUP SIRK CENTRAL"/);
    assert.match(worker, /runtime\.operationRunning\(\)/);
    assert.match(worker, /req\.method === "POST" && url\.pathname === "\/backup\/run"/);
});
