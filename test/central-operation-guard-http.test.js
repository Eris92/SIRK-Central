"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { hashAccessKey, hashSecret } = require("../src/security");
const { createTicketRuntime } = require("../src/server-v15");

const CSRF = "D".repeat(43);

async function post(origin, token, publicOrigin) {
    const headers = {
        "content-type": "application/json",
        "x-sirk-csrf": CSRF,
        origin: publicOrigin,
        "sec-fetch-site": "same-origin",
        cookie: "sirk_central_csrf=" + CSRF + (token ? "; sirk_central_session=" + token : "")
    };
    const response = await fetch(origin + "/api/settings/update/run", {
        method: "POST",
        headers,
        body: JSON.stringify({ confirm: "UPDATE SIRK CENTRAL" })
    });
    return { response, payload: await response.json() };
}

test("server-v15 blocks anonymous Pending and SecAdmin before updater access", async t => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sirk-operation-guard-http-"));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const config = {
        bindHost: "127.0.0.1",
        port: 0,
        publicOrigin: "https://central.example.test",
        authOrigin: "",
        ssoSharedSecret: "",
        adminUsername: "admin",
        adminPasswordHash: hashSecret("Correct-Horse-Battery-Staple-2026"),
        accessKeyHash: hashAccessKey("A".repeat(43)),
        dataDir,
        sessionIdleMinutes: 30,
        sessionAbsoluteHours: 8,
        trustProxy: false,
        env: { NODE_ENV: "test", SIRK_UPDATER_ORIGIN: "http://127.0.0.1:1", SIRK_UPDATER_TOKEN: "X".repeat(43) }
    };
    const app = createTicketRuntime(config);
    await new Promise((resolve, reject) => {
        app.server.once("error", reject);
        app.server.listen(0, "127.0.0.1", resolve);
    });
    t.after(() => new Promise(resolve => app.server.close(resolve)));
    const origin = "http://127.0.0.1:" + app.server.address().port;

    const pending = app.sessions.issue({ username: "pending", role: "Admin", source: "entra", status: "pending", builtIn: false }, {}).token;
    const secAdmin = app.sessions.issue({ username: "security", role: "SecAdmin", source: "entra", status: "active", builtIn: false }, {}).token;

    const anonymousResult = await post(origin, "", config.publicOrigin);
    assert.equal(anonymousResult.response.status, 401);
    assert.equal(anonymousResult.payload.code, "OPERATION_ROLE_REQUIRED");

    const pendingResult = await post(origin, pending, config.publicOrigin);
    assert.equal(pendingResult.response.status, 403);
    assert.equal(pendingResult.payload.code, "OPERATION_ROLE_REQUIRED");

    const secAdminResult = await post(origin, secAdmin, config.publicOrigin);
    assert.equal(secAdminResult.response.status, 403);
    assert.equal(secAdminResult.payload.code, "OPERATION_ROLE_REQUIRED");
});
