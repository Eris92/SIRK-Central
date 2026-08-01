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

function cborLength(major, value) {
    if (value < 24) return Buffer.from([(major << 5) | value]);
    if (value <= 0xff) return Buffer.from([(major << 5) | 24, value]);
    if (value <= 0xffff) {
        const output = Buffer.alloc(3);
        output[0] = (major << 5) | 25;
        output.writeUInt16BE(value, 1);
        return output;
    }
    const output = Buffer.alloc(5);
    output[0] = (major << 5) | 26;
    output.writeUInt32BE(value, 1);
    return output;
}

function cbor(value) {
    if (Number.isInteger(value)) return cborLength(value >= 0 ? 0 : 1, value >= 0 ? value : -1 - value);
    if (Buffer.isBuffer(value)) return Buffer.concat([cborLength(2, value.length), value]);
    if (typeof value === "string") {
        const data = Buffer.from(value, "utf8");
        return Buffer.concat([cborLength(3, data.length), data]);
    }
    if (value instanceof Map) {
        const values = [];
        for (const [key, item] of value.entries()) values.push(cbor(key), cbor(item));
        return Buffer.concat([cborLength(5, value.size), ...values]);
    }
    throw new TypeError("Unsupported CBOR test value.");
}

function registrationAttestationObject(rpId, credentialId, jwk) {
    const credentialBytes = Buffer.from(credentialId, "base64url");
    const rpHash = crypto.createHash("sha256").update(rpId, "utf8").digest();
    const fixed = Buffer.alloc(23);
    fixed[0] = 0x45;
    fixed.writeUInt32BE(0, 1);
    fixed.writeUInt16BE(credentialBytes.length, 21);
    const coseKey = cbor(new Map([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, Buffer.from(jwk.x, "base64url")],
        [-3, Buffer.from(jwk.y, "base64url")]
    ]));
    const authData = Buffer.concat([rpHash, fixed, credentialBytes, coseKey]);
    return cbor(new Map([
        ["fmt", "none"],
        ["attStmt", new Map()],
        ["authData", authData]
    ])).toString("base64url");
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
    const jwk = pair.publicKey.export({ format: "jwk" });
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
                attestationObject: registrationAttestationObject("central.example.test", credentialId, jwk),
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

    const blocked = await request(origin, "/api/break-glass/passkeys/" + credentialId, {
        method: "DELETE",
        headers,
        body: {}
    });
    assert.equal(blocked.response.status, 409);
    assert.equal(blocked.payload.code, "MFA_CONTINUITY_REQUIRED");

    const actor = app.sessions.get(session, true);
    app.recoveryCodes.generate(actor, 5);

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
