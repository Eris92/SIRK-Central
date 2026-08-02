"use strict";

const assert = require("node:assert/strict");
const { bootstrapBundle, publicOrigin, canManage } = require("../src/modules/portal-bootstrap");

assert.equal(publicOrigin({ publicOrigin: "https://central.sirkportal.com/", env: {} }), "https://central.sirkportal.com");
assert.throws(
    () => publicOrigin({ publicOrigin: "http://central.example", env: {} }),
    /public origin is not configured/i
);

const bundle = bootstrapBundle(
    { publicOrigin: "https://central.sirkportal.com", env: {} },
    {
        id: "portal-test",
        name: "Portal Test",
        token: "12345678901234567890123456789012",
        createdAtUtc: "2026-08-02T00:00:00.000Z"
    }
);

assert.deepEqual(bundle, {
    schemaVersion: 1,
    centralUrl: "https://central.sirkportal.com",
    tunnelUrl: "wss://central.sirkportal.com/tunnel",
    configUrl: "https://central.sirkportal.com/api/portal/v1/config",
    heartbeatUrl: "https://central.sirkportal.com/api/portal/v1/heartbeat",
    portalId: "portal-test",
    portalName: "Portal Test",
    portalToken: "12345678901234567890123456789012",
    createdAtUtc: "2026-08-02T00:00:00.000Z"
});

assert.equal(canManage({ builtIn: true, source: "local", role: "BreakGlass" }), true);
assert.equal(canManage({ builtIn: false, source: "entra", role: "Admin", status: "active" }), true);
assert.equal(canManage({ builtIn: false, source: "entra", role: "SecAdmin", status: "active" }), false);
assert.equal(canManage(null), false);

console.log("portal-bootstrap: OK");
