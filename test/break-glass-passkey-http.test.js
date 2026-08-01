"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { hashSecret, hashAccessKey } = require("../src/security");
const { createCentralRuntime } = require("../src/server");
const createFinalApp = config => createCentralRuntime(config, { through: "passkey-management" });

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

function clientData(challenge, origin) {
    return Buffer.from(JSON.stringify({ type: "webauthn.get", challenge, origin, crossOrigin: false })).toString("base64url");
}

function authenticatorData(rpId, counter) {
    const data = Buffer.alloc(37);
    crypto.createHash("sha256").update(rpId, "utf8").digest().copy(data, 0);
    data[32] = 0x05;
    data.writeUInt32BE(counter, 33);
    return data;
}

test("BreakGlass passkey assertion issues a session and rejects replay", async t => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sirk-passkey-http-"));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

    const password = "Correct-Horse-Battery-Staple-2026";
    const accessKey = "B".repeat(43);
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

    const app = createFinalApp(config);
    await new Promise((resolve, reject) => {
        app.server.once("error", reject);
        app.server.listen(0, "127.0.0.1", resolve);
    });
    t.after(() => new Promise(resolve => app.server.close(resolve)));
    const origin = "http://127.0.0.1:" + app.server.address().port;
    const userAgent = "sirk-passkey-test";
    const baseHeaders = {
        authorization: "Bearer " + accessKey,
        "content-type": "application/json",
        "user-agent": userAgent
    };

    const bootstrap = await fetch(origin + "/csrf-bootstrap.js");
    assert.equal(bootstrap.status, 200);
    const csrf = cookieValue(bootstrap.headers, "sirk_central_csrf");
    assert.ok(csrf);

    const firstLogin = await request(origin, "/api/login", {
        method: "POST",
        headers: baseHeaders,
        body: { username: "admin", password }
    });
    assert.equal(firstLogin.response.status, 200);
    const initialSession = cookieValue(firstLogin.response.headers, "sirk_central_session");
    assert.ok(initialSession);

    const identity = {
        username: "admin",
        displayName: "admin",
        identityKey: "breakglass:admin",
        source: "local",
        role: "BreakGlass",
        builtIn: true,
        status: "active"
    };
    const pair = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const publicKey = pair.publicKey.export({ format: "der", type: "spki" }).toString("base64url");
    const credentialId = crypto.randomBytes(32).toString("base64url");
    app.passkeys.register({ credentialId, publicKey, counter: 0, transports: ["usb"], displayName: "Test YubiKey" }, identity);

    const pending = await request(origin, "/api/login", {
        method: "POST",
        headers: baseHeaders,
        body: { username: "admin", password }
    });
    assert.equal(pending.response.status, 202);
    assert.deepEqual(pending.payload.methods, ["passkey"]);
    assert.equal(pending.payload.preferredMethod, "passkey");
    assert.ok(pending.payload.transactionToken);
    assert.equal(cookieValue(pending.response.headers, "sirk_central_session"), "");

    const mfaHeaders = {
        ...baseHeaders,
        cookie: "sirk_central_csrf=" + csrf,
        "x-sirk-csrf": csrf,
        origin: config.publicOrigin,
        "sec-fetch-site": "same-origin"
    };

    const rejected = await request(origin, "/api/login/mfa/passkey/begin", {
        method: "POST",
        headers: baseHeaders,
        body: { transactionToken: pending.payload.transactionToken }
    });
    assert.equal(rejected.response.status, 403);

    const begin = await request(origin, "/api/login/mfa/passkey/begin", {
        method: "POST",
        headers: mfaHeaders,
        body: { transactionToken: pending.payload.transactionToken }
    });
    assert.equal(begin.response.status, 200);
    assert.equal(begin.payload.publicKey.allowCredentials[0].id, credentialId);

    const encodedClient = clientData(begin.payload.publicKey.challenge, config.publicOrigin);
    const authData = authenticatorData("central.example.test", 1);
    const signed = Buffer.concat([
        authData,
        crypto.createHash("sha256").update(Buffer.from(encodedClient, "base64url")).digest()
    ]);
    const signature = crypto.sign("sha256", signed, pair.privateKey).toString("base64url");

    const finish = await request(origin, "/api/login/mfa/passkey/finish", {
        method: "POST",
        headers: mfaHeaders,
        body: {
            transactionToken: pending.payload.transactionToken,
            challengeId: begin.payload.challengeId,
            credential: {
                credentialId,
                clientDataJSON: encodedClient,
                authenticatorData: authData.toString("base64url"),
                signature
            }
        }
    });
    assert.equal(finish.response.status, 200);
    assert.equal(finish.payload.method, "passkey");
    const session = cookieValue(finish.response.headers, "sirk_central_session");
    assert.ok(session);

    const current = await request(origin, "/api/session", {
        headers: { cookie: "sirk_central_session=" + session, "user-agent": userAgent }
    });
    assert.equal(current.response.status, 200);
    assert.equal(current.payload.role, "BreakGlass");

    const replay = await request(origin, "/api/login/mfa/passkey/finish", {
        method: "POST",
        headers: mfaHeaders,
        body: {
            transactionToken: pending.payload.transactionToken,
            challengeId: begin.payload.challengeId,
            credential: { credentialId, clientDataJSON: encodedClient, authenticatorData: authData.toString("base64url"), signature }
        }
    });
    assert.notEqual(replay.response.status, 200);
});
