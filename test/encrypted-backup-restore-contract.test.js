"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");

const worker = fs.readFileSync("updater/appliance-restore-server.js", "utf8");
const gateway = require("../updater/gateway-server");
const central = fs.readFileSync("src/modules/appliance-management.js", "utf8");
const ui = fs.readFileSync("public/encrypted-backup-ui.js", "utf8");
const compose = fs.readFileSync("docker-compose.appliance.yml", "utf8");

test("encrypted restore validates identity and recipient fingerprint before decrypt", () => {
    assert.match(worker, /AGE-SECRET-KEY-1/);
    assert.match(worker, /age-keygen/);
    assert.match(worker, /recipientFingerprint/);
    assert.match(worker, /safeEqual\(fingerprint\(recipient\), encrypted\.metadata\.recipientFingerprint\)/);
    assert.match(worker, /age[\s\S]*--decrypt[\s\S]*--identity/);
});

test("encrypted restore removes identity decrypted archive and checksum", () => {
    assert.match(worker, /finally[\s\S]*rmSync\(identityPath/);
    assert.match(worker, /finally[\s\S]*rmSync\(plaintext/);
    assert.match(worker, /rmSync\(plaintext \+ "\.sha256"/);
    assert.match(worker, /encryptSafetyBackup/);
    assert.match(worker, /removePlainBackup/);
});

test("restore route is internal and operation locked", () => {
    assert.equal(gateway.pathAllowed("/backup/encrypted/restore"), true);
    assert.equal(gateway.pathAllowed("/backup/encrypted/restore/extra"), false);
    assert.match(worker, /authorized\(req\)/);
    assert.match(worker, /encryptedRestoreRunning \|\| runtime\.operationRunning\(\)/);
    assert.match(worker, /RESTORE SIRK CENTRAL/);
    assert.match(compose, /appliance-restore-server\.js/);
});

test("Central accepts restore only for Admin or BreakGlass with CSRF", () => {
    assert.match(central, /function writable/);
    assert.match(central, /actor\.builtIn === true/);
    assert.match(central, /actor\.role === "Admin"/);
    assert.match(central, /csrfAccepted\(req, config\)/);
    assert.match(central, /\/backup\/encrypted\/restore/);
    assert.doesNotMatch(central, /audit[\s\S]*identity/);
});

test("browser uploads a small agekey once and clears the input", () => {
    assert.match(ui, /input\.accept = "\.agekey,text\/plain"/);
    assert.match(ui, /file\.size > 16384/);
    assert.match(ui, /AGE-SECRET-KEY-1/);
    assert.match(ui, /restore-encrypted/);
    assert.match(ui, /identity = ""/);
    assert.match(ui, /input\.remove\(\)/);
});
