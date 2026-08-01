"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { hashSecret, hashAccessKey } = require("../src/security");
const { createCentralRuntime } = require("../src/server");

const RECIPIENT = "age1" + "q".repeat(58);
const IDENTITY = "# created: 2026-08-01T00:00:00Z\n# public key: " + RECIPIENT + "\nAGE-SECRET-KEY-1QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ\n";

function cookieValue(headers, name) {
    const values = typeof headers.getSetCookie === "function"
        ? headers.getSetCookie()
        : [headers.get("set-cookie") || ""];
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

test("BreakGlass generates and downloads an age identity while persisting only its public recipient", async t => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sirk-breakglass-age-http-"));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

    const password = "Correct-Horse-Battery-Staple-2026";
    const accessKey = "A".repeat(43);
    const config = {
        bindHost: "127.0.0.1",
        port: 0,
        publicOrigin: "https://central.example.test",
        authOrigin: "",
        ssoSharedSecret: "",
        adminUsername: "admin",
        adminPasswordHash: hashSecret(password),
        accessKeyHash: hashAccessKey(accessKey),
        dataDir,
        sessionIdleMinutes: 30,
        sessionAbsoluteHours: 8,
        trustProxy: false,
        env: { NODE_ENV: "test", SIRK_AUDIT_INTEGRITY_KEY: "K".repeat(48) }
    };

    const app = createCentralRuntime(config);
    app.generateAgeIdentity = () => ({ recipient: RECIPIENT, identity: IDENTITY });
    await new Promise((resolve, reject) => {
        app.server.once("error", reject);
        app.server.listen(0, "127.0.0.1", resolve);
    });
    t.after(() => app.close());
    const origin = "http://127.0.0.1:" + app.server.address().port;
    const baseHeaders = {
        authorization: "Bearer " + accessKey,
        "content-type": "application/json",
        "user-agent": "sirk-age-key-test"
    };

    const login = await jsonRequest(origin, "/api/login", {
        method: "POST",
        headers: baseHeaders,
        body: { username: "admin", password }
    });
    assert.equal(login.response.status, 200);
    const session = cookieValue(login.response.headers, "sirk_central_session");
    const csrf = cookieValue(login.response.headers, "sirk_central_csrf");
    assert.ok(session);
    assert.ok(csrf);

    const sessionHeaders = {
        ...baseHeaders,
        cookie: "sirk_central_session=" + session + "; sirk_central_csrf=" + csrf,
        origin: config.publicOrigin,
        "sec-fetch-site": "same-origin"
    };

    const initial = await jsonRequest(origin, "/api/break-glass/backup-age/status", { headers: sessionHeaders });
    assert.equal(initial.response.status, 200);
    assert.equal(initial.payload.configured, false);

    const withoutCsrf = await jsonRequest(origin, "/api/break-glass/backup-age/identity", {
        method: "POST",
        headers: { ...baseHeaders, cookie: "sirk_central_session=" + session, origin: config.publicOrigin },
        body: { currentPassword: password, confirm: "GENERATE AGE BACKUP KEY" }
    });
    assert.equal(withoutCsrf.response.status, 403);
    assert.equal(withoutCsrf.payload.error, "CSRF validation failed.");

    const wrongPassword = await jsonRequest(origin, "/api/break-glass/backup-age/identity", {
        method: "POST",
        headers: { ...sessionHeaders, "x-sirk-csrf": csrf },
        body: { currentPassword: "wrong-password", confirm: "GENERATE AGE BACKUP KEY" }
    });
    assert.equal(wrongPassword.response.status, 401);
    assert.equal(wrongPassword.payload.error, "Current password is invalid.");

    const generated = await fetch(origin + "/api/break-glass/backup-age/identity", {
        method: "POST",
        headers: { ...sessionHeaders, "x-sirk-csrf": csrf },
        body: JSON.stringify({ currentPassword: password, confirm: "GENERATE AGE BACKUP KEY" })
    });
    assert.equal(generated.status, 200);
    assert.equal(generated.headers.get("cache-control").includes("no-store"), true);
    assert.equal(generated.headers.get("content-disposition"), 'attachment; filename="sirk-central-backup.agekey"');
    assert.equal(generated.headers.get("x-sirk-age-recipient"), RECIPIENT);
    assert.equal(generated.headers.get("x-sirk-age-key-shown-once"), "true");
    assert.equal(await generated.text(), IDENTITY);

    const persisted = fs.readFileSync(path.join(dataDir, "backup-age-recipient.json"), "utf8");
    assert.match(persisted, new RegExp(RECIPIENT));
    assert.doesNotMatch(persisted, /AGE-SECRET-KEY-/);

    const status = await jsonRequest(origin, "/api/break-glass/backup-age/status", { headers: sessionHeaders });
    assert.equal(status.response.status, 200);
    assert.equal(status.payload.configured, true);
    assert.equal(status.payload.source, "break-glass-ui");
    assert.equal(status.payload.recipient, RECIPIENT);
});
