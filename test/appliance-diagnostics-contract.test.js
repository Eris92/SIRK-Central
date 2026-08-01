"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const { allowed, updaterOrigin } = require("../src/modules/appliance-management");
const { pathAllowed } = require("../updater/gateway-server");

const worker = fs.readFileSync("updater/appliance-server.js", "utf8");
const downloadWorker = fs.readFileSync("updater/appliance-download-server.js", "utf8");
const ui = fs.readFileSync("public/appliance-system-ui.js", "utf8");
const overlay = fs.readFileSync("docker-compose.appliance.yml", "utf8");

function actor(role, overrides = {}) {
    return Object.assign({ role, status: "active", source: "entra", builtIn: false, permissions: [] }, overrides);
}

test("appliance diagnostics are readable only by approved roles", () => {
    assert.equal(allowed(actor("Admin")), true);
    assert.equal(allowed(actor("SecAdmin")), true);
    assert.equal(allowed(actor("Auditor")), true);
    assert.equal(allowed(actor("BreakGlass", { builtIn: true, source: "local" })), true);
    assert.equal(allowed(actor("OperatorL1")), false);
    assert.equal(allowed(actor("Admin", { status: "pending" })), false);
});

test("diagnostics stay on the allowlisted updater gateway", () => {
    assert.equal(pathAllowed("/appliance/status"), true);
    assert.equal(pathAllowed("/appliance/status?secrets=1"), false);
    assert.equal(updaterOrigin({ env: {
        SIRK_UPDATER_ORIGIN: "http://updater-gateway:8092",
        SIRK_UPDATER_ALLOWED_HOSTS: "updater-gateway"
    } }), "http://updater-gateway:8092");
    assert.throws(() => updaterOrigin({ env: {
        SIRK_UPDATER_ORIGIN: "http://169.254.169.254/latest",
        SIRK_UPDATER_ALLOWED_HOSTS: "updater-gateway"
    } }));
});

test("worker diagnostics expose operational metadata without environment or secret values", () => {
    assert.match(worker, /\/appliance\/status/);
    assert.match(worker, /docker[\s\S]*compose[\s\S]*ps[\s\S]*--format[\s\S]*json/);
    assert.match(worker, /statfsSync/);
    assert.doesNotMatch(worker, /process\.env\s*[),}]/);
    assert.doesNotMatch(worker, /\.env["']/);
    assert.doesNotMatch(worker, /SIRK_ADMIN_PASSWORD_HASH|SIRK_ACCESS_KEY_HASH|SIRK_SSO_SHARED_SECRET/);
});

test("System tab renders containers storage and operation state", () => {
    assert.match(ui, /data-settings-tab='system'/);
    assert.match(ui, /\/api\/settings\/appliance\/status/);
    assert.match(ui, /result\.containers/);
    assert.match(ui, /result\.storage/);
    assert.match(ui, /result\.update/);
    assert.match(ui, /result\.restore/);
    assert.match(downloadWorker, /require\("\.\/appliance-server"\)/);
    assert.match(overlay, /command: \["node", "\/app\/appliance-download-server\.js"\]/);
});
