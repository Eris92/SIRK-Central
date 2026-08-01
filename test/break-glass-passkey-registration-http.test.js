"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { hashSecret, hashAccessKey } = require("../src/security");
const { createCentralRuntime } = require("../src/server");

function cookieValue(headers, name) {
    const values = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [headers.get("set-cookie") || ""];
    for (const value of values) {
        const match = String(value).match(new RegExp("(?:^|[,;]\\s*)" + name + "=([^;,]*)"));
        if (match) return match[1];
    }
    return "";
}

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

function registrationAuthenticatorData(rpId) {
    const data = Buffer.alloc(37);
    crypto.createHash("sha256").update(rpId, "utf8").digest().copy(data, 0);
    data[32] = 0x45;
    data.writeUInt32BE(0, 33);
    return data;
}

test("BreakGlass can register, list and revoke an ES256 passkey", async t => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sirk-passkey-registration-"));
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

    const app = createCentralRuntime(config);
    await new Promise((resolve, reject) => {
        app.server.once("error", reject);
        app.server.listen(0, "127.0.0.1", resolve);
    });
    t.after(() => app.close());
    const origin = "http://127.0.0.1:" + app.server.address().port;
    const userAgent = "sirk-registration-test";

    const bootstrap = await fetch(origin + "/csrf-bootstrap.js");
    const csrf = cookieValue(bootstrap.headers, "sirk_central_csrf");
    assert.ok(csrf);

    const login = await request(origin, "/api/login", {
        method: "POST",
        headers: {
            authorization: "Bearer " + accessKey,
            "content-type": "application/json",
            "user-agent": userAgent
        },
        body: { username: "admin", password }
    });
    assert.equal(login.response.status, 200);
    const session = cookieValue(login.response.headers, "sirk_central_session");
    assert.ok(session);

    const headers = {
        cookie: "sirk_central_session=" + session + "; sirk_central_csrf=" + csrf,
        "x-sirk-csrf": csrf,
        origin: config.publicOrigin,
        "sec-fetch-site": "same-origin",
        "content-type": "application/json",
        "user-agent": userAgent
    };

    const begin = await request(origin, "/api/break-glass/passkeys/begin-registration", {
        method: "POST",
        headers,
        body: {}
    });
    assert.equal(begin.response.status, 200);
    assert.equal(begin.payload.publicKey.rp.id, "central.example.test");
    assert.equal(begin.payload.publicKey.pubKeyCredParams[0].alg, -7);

    const pair = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const publicKey = pair.publicKey.export({ format: "der", type: "spki" }).toString("base64url");
    const credentialId = crypto.randomBytes(32).toString("base64url");
    const clientDataJSON = Buffer.from(JSON.stringify({
        type: "webauthn.create",
        challenge: begin.payload.publicKey.challenge,
        origin: config.publicOrigin,
        crossOrigin: false
    })).toString("base64url");

    const finish = await request(origin, "/api/break-glass/passkeys/finish-registration", {
        method: "POST",
        headers,
        body: {
            challengeId: begin.payload.challengeId,
            displayName: "Test YubiKey",
            credential: {
                credentialId,
                clientDataJSON,
                authenticatorData: registrationAuthenticatorData("central.example.test").toString("base64url"),
                publicKey,
                publicKeyAlgorithm: -7,
                transports: ["usb"]
            }
        }
    });
    assert.equal(finish.response.status, 200);
    assert.equal(finish.payload.passkey.credentialId, credentialId);
    assert.equal(finish.payload.passkey.displayName, "Test YubiKey");

    const listed = await request(origin, "/api/break-glass/passkeys", {
        headers: { cookie: "sirk_central_session=" + session, "user-agent": userAgent }
    });
    assert.equal(listed.response.status, 200);
    assert.equal(listed.payload.passkeys.length, 1);
    assert.equal(listed.payload.passkeys[0].credentialId, credentialId);
    assert.equal(Object.prototype.hasOwnProperty.call(listed.payload.passkeys[0], "publicKey"), false);

    const revoked = await request(origin, "/api/break-glass/passkeys/" + credentialId, {
        method: "DELETE",
        headers,
        body: {}
    });
    assert.equal(revoked.response.status, 200);

    const after = await request(origin, "/api/break-glass/passkeys", {
        headers: { cookie: "sirk_central_session=" + session, "user-agent": userAgent }
    });
    assert.equal(after.payload.passkeys[0].status, "revoked");
});
