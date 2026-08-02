"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { hashSecret, hashAccessKey } = require("../src/security");
const { createCentralRuntime } = require("../src/server");

const RECIPIENT = "age1" + "q".repeat(58);
const IDENTITY = "# created: 2026-08-01T00:00:00Z\n# public key: " + RECIPIENT + "\nAGE-SECRET-KEY-1" + "Q".repeat(58) + "\n";

function cookieValue(headers, name) {
    const values = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [headers.get("set-cookie") || ""];
    for (const value of values) {
        const match = String(value).match(new RegExp("(?:^|[,;]\\s*)" + name + "=([^;,]*)"));
        if (match) return match[1];
    }
    return "";
}

async function jsonRequest(origin, route, options = {}) {
    const response = await fetch(origin + route, {
        method: options.method || "GET",
        headers: options.headers || {},
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        redirect: "manual"
    });
    const payload = await response.json();
    return { response, payload };
}

test("BreakGlass persists encrypted age identity exports it and rewraps it on password change", async t => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sirk-breakglass-age-http-"));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const password = "Correct-Horse-Battery-Staple-2026";
    const newPassword = "Correct-Horse-Battery-Staple-2027";
    const accessKey = "A".repeat(43);
    const config = {
        bindHost: "127.0.0.1", port: 0, publicOrigin: "https://central.example.test", authOrigin: "", ssoSharedSecret: "",
        adminUsername: "admin", adminPasswordHash: hashSecret(password), accessKeyHash: hashAccessKey(accessKey), dataDir,
        sessionIdleMinutes: 30, sessionAbsoluteHours: 8, trustProxy: false,
        env: { NODE_ENV: "test", SIRK_AUDIT_INTEGRITY_KEY: "K".repeat(48) }
    };
    const app = createCentralRuntime(config);
    app.generateAgeIdentity = () => ({ recipient: RECIPIENT, identity: IDENTITY });
    await new Promise((resolve, reject) => { app.server.once("error", reject); app.server.listen(0, "127.0.0.1", resolve); });
    t.after(() => app.close());
    const origin = "http://127.0.0.1:" + app.server.address().port;
    const baseHeaders = { authorization: "Bearer " + accessKey, "content-type": "application/json", "user-agent": "sirk-age-key-test" };

    async function loginWith(value) {
        const login = await jsonRequest(origin, "/api/login", { method: "POST", headers: baseHeaders, body: { username: "admin", password: value } });
        const session = cookieValue(login.response.headers, "sirk_central_session");
        const csrf = cookieValue(login.response.headers, "sirk_central_csrf");
        return { login, headers: { ...baseHeaders, cookie: "sirk_central_session=" + session + "; sirk_central_csrf=" + csrf,
            origin: config.publicOrigin, "sec-fetch-site": "same-origin", "x-sirk-csrf": csrf } };
    }

    const first = await loginWith(password);
    assert.equal(first.login.response.status, 200);
    const generated = await fetch(origin + "/api/break-glass/backup-age/identity", {
        method: "POST", headers: first.headers,
        body: JSON.stringify({ currentPassword: password, confirm: "GENERATE AGE BACKUP KEY" })
    });
    assert.equal(generated.status, 200);
    assert.equal(generated.headers.get("content-disposition"), 'attachment; filename="sirk-central-backup-key.sirkkey"');
    assert.equal(generated.headers.get("x-sirk-age-key-persisted"), "true");
    const exported = await generated.text();
    assert.match(exported, /sirk-central-encrypted-age-key/);
    assert.match(exported, /ciphertext/);
    assert.doesNotMatch(exported, /AGE-SECRET-KEY-/);

    const persisted = fs.readFileSync(path.join(dataDir, "backup-age-key.json"), "utf8");
    assert.match(persisted, new RegExp(RECIPIENT));
    assert.match(persisted, /aes-256-gcm/);
    assert.doesNotMatch(persisted, /AGE-SECRET-KEY-/);

    const exportedAgain = await fetch(origin + "/api/break-glass/backup-age/export", {
        method: "POST", headers: first.headers, body: JSON.stringify({ currentPassword: password })
    });
    assert.equal(exportedAgain.status, 200);
    assert.doesNotMatch(await exportedAgain.text(), /AGE-SECRET-KEY-/);

    const changed = await jsonRequest(origin, "/api/break-glass/password", {
        method: "POST", headers: first.headers, body: { currentPassword: password, newPassword }
    });
    assert.equal(changed.response.status, 200);
    assert.equal(changed.payload.backupKeyRewrapped, true);

    const oldLogin = await loginWith(password);
    assert.equal(oldLogin.login.response.status, 401);
    const second = await loginWith(newPassword);
    assert.equal(second.login.response.status, 200);
    const status = await jsonRequest(origin, "/api/break-glass/backup-age/status", { headers: second.headers });
    assert.equal(status.response.status, 200);
    assert.equal(status.payload.keyPersisted, true);
    assert.equal(status.payload.recipient, RECIPIENT);
});
