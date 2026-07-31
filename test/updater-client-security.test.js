"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { updaterPathAllowed, updaterOrigin, operationsActor } = require("../src/server-v8");

function request() {
    return { headers: { cookie: "sirk_central_session=test-session" } };
}
function appWith(actor) {
    return { sessions: { get: token => token === "test-session" ? actor : null } };
}
function actor(role, status = "active", overrides = {}) {
    return Object.assign({
        username: role.toLowerCase(),
        identityKey: "tenant:" + role.toLowerCase(),
        source: "entra",
        role,
        status,
        builtIn: false
    }, overrides);
}

test("updater path allowlist accepts exact operations and encoded backup names", () => {
    for (const value of ["/status", "/run", "/backup/status", "/backup/run", "/backup/restore"]) {
        assert.equal(updaterPathAllowed(value), true, value);
    }
    assert.equal(updaterPathAllowed("/backup/sirk-central-20260731T143000%2B0200.tar.gz"), true);
    assert.equal(updaterPathAllowed("/backup/sirk-central-20260731T123000Z.tar.gz"), true);
});

test("updater path allowlist rejects traversal query fragments and arbitrary endpoints", () => {
    for (const value of [
        "", "status", "/backup/../status", "/backup/%2e%2e/status", "/backup/file.tar.gz",
        "/backup/sirk-central-20260731T143000%2B0200.tar.gz?x=1",
        "/backup/sirk-central-20260731T143000%2B0200.tar.gz#x",
        "/healthz", "//evil.example/status", "/backup/sirk-central-20260731T143000%2F0200.tar.gz"
    ]) assert.equal(updaterPathAllowed(value), false, value);
});

test("Central updater origin is restricted to the unprivileged gateway host", () => {
    assert.equal(updaterOrigin({ env: {
        SIRK_UPDATER_ORIGIN: "http://updater-gateway:8092",
        SIRK_UPDATER_ALLOWED_HOSTS: "updater-gateway"
    } }), "http://updater-gateway:8092");
    assert.throws(() => updaterOrigin({ env: {
        SIRK_UPDATER_ORIGIN: "http://updater:8090",
        SIRK_UPDATER_ALLOWED_HOSTS: "updater-gateway"
    } }), /not allowed/i);
    assert.throws(() => updaterOrigin({ env: {
        SIRK_UPDATER_ORIGIN: "http://169.254.169.254/latest",
        SIRK_UPDATER_ALLOWED_HOSTS: "updater-gateway"
    } }), /not allowed|invalid/i);
    assert.throws(() => updaterOrigin({ env: {
        SIRK_UPDATER_ORIGIN: "http://user:pass@updater-gateway:8092",
        SIRK_UPDATER_ALLOWED_HOSTS: "updater-gateway"
    } }), /not allowed/i);
    assert.throws(() => updaterOrigin({ env: {
        SIRK_UPDATER_ORIGIN: "http://evil.example:8092",
        SIRK_UPDATER_ALLOWED_HOSTS: "updater-gateway"
    } }), /not allowed/i);
});

test("only active Admin or local BreakGlass can execute updater operations", () => {
    const req = request();
    const admin = actor("Admin");
    const secAdmin = actor("SecAdmin");
    const pendingAdmin = actor("Admin", "pending");
    const breakGlass = actor("BreakGlass", "active", { username: "admin", identityKey: "breakglass:admin", source: "local", builtIn: true });

    assert.equal(operationsActor(appWith(admin), req, true), admin);
    assert.equal(operationsActor(appWith(secAdmin), req, true), null);
    assert.equal(operationsActor(appWith(secAdmin), req, false), secAdmin);
    assert.equal(operationsActor(appWith(pendingAdmin), req, false), null);
    assert.equal(operationsActor(appWith(pendingAdmin), req, true), null);
    assert.equal(operationsActor(appWith(breakGlass), req, true), breakGlass);
});
