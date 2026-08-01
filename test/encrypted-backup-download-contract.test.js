"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");

const worker = fs.readFileSync("updater/appliance-download-server.js", "utf8");
const gateway = fs.readFileSync("updater/gateway-server.js", "utf8");
const central = fs.readFileSync("src/modules/appliance-management.js", "utf8");
const ui = fs.readFileSync("public/encrypted-backup-ui.js", "utf8");
const compose = fs.readFileSync("docker-compose.appliance.yml", "utf8");
const dockerfile = fs.readFileSync("updater/Dockerfile", "utf8");

test("worker serves only validated encrypted backup names", () => {
    assert.match(worker, /encryptedNamePattern/);
    assert.match(worker, /path\.dirname\(target\) !== backupDir/);
    assert.match(worker, /authorized\(req\)/);
    assert.match(worker, /Content-Disposition/);
    assert.match(worker, /createReadStream/);
});

test("gateway allowlists encrypted download and preserves attachment metadata", () => {
    assert.match(gateway, /\/backup\\\/file\\\/sirk-central/);
    assert.match(gateway, /application\/octet-stream/);
    assert.match(gateway, /content-disposition/);
    assert.equal(require("../updater/gateway-server").pathAllowed("/backup/file/sirk-central-20260801T120000Z.tar.gz.age"), true);
    assert.equal(require("../updater/gateway-server").pathAllowed("/backup/file/../../etc/passwd"), false);
});

test("Central streams download only for authenticated approved roles", () => {
    assert.match(central, /sessionActor\(app, req\)/);
    assert.match(central, /allowed\(actor\)/);
    assert.match(central, /ENCRYPTED_BACKUP_PATTERN/);
    assert.match(central, /Readable\.fromWeb\(response\.body\)/);
    assert.match(central, /\/api\\\/settings\\\/backup\\\/download/);
});

test("UI exposes download and keeps restore identity-gated", () => {
    assert.match(ui, /\/api\/settings\/backup\/download\//);
    assert.match(ui, /download\.download = fileName/);
    assert.match(ui, /restoreAllowed/);
    assert.match(ui, /\.agekey/);
    assert.match(compose, /appliance-restore-server\.js/);
    assert.match(dockerfile, /COPY updater\/appliance-download-server\.js/);
    assert.match(dockerfile, /COPY updater\/appliance-restore-server\.js/);
});
