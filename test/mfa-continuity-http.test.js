"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { generateKeyPairSync } = require("node:crypto");
const { hashSecret, hashAccessKey } = require("../src/security");
const { createCentralRuntime } = require("../src/server");
const createContinuityApp = config => createCentralRuntime(config, { through: "continuity" });

async function request(origin, route, options = {}) {
    const response = await fetch(origin + route, {
        method: options.method || "GET",
        headers: options.headers || {},
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        redirect: "manual"
    });
    const payload = await response.json();
    return { response, payload };
}

test("HTTP API never removes the final BreakGlass MFA recovery method", async t => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sirk-mfa-continuity-"));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

    const password = "Correct-Horse-Battery-Staple-2026";
    const accessKey = "C".repeat(43);
    const config = {
        bindHost: "127.0.0.1",
        port: 0,
        publicOrigin: "https://central.example.test",
        authOrigin: "",
        ssoSharedSecret: "",
        adminUsername: "admin",
        adminPasswordHash: hashSecret(password),
        accessKeyHash: hashAccessKey(accessKey),
        sessionIdleMinutes: 30,
        sessionAbsoluteHours: 8,
        trustProxy: false,
        dataDir,
        env: { NODE_ENV: "test", SIRK_RUNTIME_LOCK_DISABLED: "true", SIRK_AUDIT_INTEGRITY_KEY: "K".repeat(48) }
    };

    const app = createContinuityApp(config);
    await new Promise((resolve, reject) => {
        app.server.once("error", reject);
        app.server.listen(0, "127.0.0.1", resolve);
    });
    t.after(() => new Promise(resolve => app.server.close(resolve)));
    const origin = "http://127.0.0.1:" + app.server.address().port;
    const userAgent = "sirk-continuity-test";

    const identity = {
        username: "admin",
        displayName: "admin",
        identityKey: "breakglass:admin",
        source: "local",
        role: "BreakGlass",
        builtIn: true,
        status: "active"
    };
    const issued = app.sessions.issue(identity, { ip: "127.0.0.1", userAgent });
    const session = issued.token;
    const csrf = "T".repeat(43);

    const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const publicKey = pair.publicKey.export({ format: "der", type: "spki" }).toString("base64url");
    const credentialId = "credential-active-0001";
    app.passkeys.register({ credentialId, publicKey, counter: 0, displayName: "Test YubiKey", transports: ["usb"] }, identity);

    const headers = {
        cookie: "sirk_central_session=" + session + "; sirk_central_csrf=" + csrf,
        "x-sirk-csrf": csrf,
        origin: config.publicOrigin,
        "sec-fetch-site": "same-origin",
        "user-agent": userAgent
    };

    const blockedPasskey = await request(origin, "/api/break-glass/passkeys/" + credentialId, { method: "DELETE", headers });
    assert.equal(blockedPasskey.response.status, 409);
    assert.equal(blockedPasskey.payload.code, "MFA_CONTINUITY_REQUIRED");
    assert.equal(app.passkeys.activeCount(identity), 1);

    app.recoveryCodes.generate(identity, 5);
    const allowedPasskey = await request(origin, "/api/break-glass/passkeys/" + credentialId, { method: "DELETE", headers });
    assert.equal(allowedPasskey.response.status, 200);
    assert.equal(app.passkeys.activeCount(identity), 0);

    const blockedRecovery = await request(origin, "/api/break-glass/mfa/recovery-codes", { method: "DELETE", headers });
    assert.equal(blockedRecovery.response.status, 409);
    assert.equal(blockedRecovery.payload.code, "MFA_CONTINUITY_REQUIRED");
    assert.equal(app.recoveryCodes.status(identity).remaining, 5);

    const continuity = await request(origin, "/api/break-glass/mfa/continuity", {
        headers: { cookie: "sirk_central_session=" + session, "user-agent": userAgent }
    });
    assert.equal(continuity.response.status, 200);
    assert.equal(continuity.payload.continuity.hasPasskey, false);
    assert.equal(continuity.payload.continuity.hasRecovery, true);
});
