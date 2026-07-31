"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { hashAccessKey, hashSecret } = require("../src/security");
const { sign, verify } = require("../src/sso-ticket");
const auth = require("../auth/hardened-server");
const { createTicketRuntime } = require("../src/server-v15");

const SHARED = "S".repeat(64);
const AUTH_ORIGIN = "https://auth.example.test";
const CENTRAL_ORIGIN = "https://central.example.test";
const PROVIDER_ISSUER = "https://login.microsoftonline.com/00000000-0000-0000-0000-000000000001/v2.0";
const SID = "session-id_12345678";

function config(dataDir) {
    return {
        bindHost: "127.0.0.1",
        port: 0,
        publicOrigin: CENTRAL_ORIGIN,
        centralOrigin: CENTRAL_ORIGIN,
        authOrigin: AUTH_ORIGIN,
        ssoSharedSecret: SHARED,
        sharedSecret: SHARED,
        adminUsername: "admin",
        adminPasswordHash: hashSecret("Correct-Horse-Battery-Staple-2026"),
        accessKeyHash: hashAccessKey("A".repeat(43)),
        dataDir,
        sessionIdleMinutes: 30,
        sessionAbsoluteHours: 8,
        trustProxy: false,
        env: { NODE_ENV: "test", SIRK_CENTRAL_INTERNAL_ORIGIN: "http://central:8080" }
    };
}

function logoutTicket(jti = "logout_jti_abcdefghijklmnop") {
    const now = Math.floor(Date.now() / 1000);
    return sign({
        v: 1,
        typ: "logout",
        iss: AUTH_ORIGIN,
        aud: CENTRAL_ORIGIN,
        iat: now,
        exp: now + 60,
        jti,
        sid: SID,
        providerIssuer: PROVIDER_ISSUER
    }, SHARED);
}

test("Auth validates Microsoft front-channel issuer and internal Central origin", () => {
    const url = new URL(AUTH_ORIGIN + "/auth/entra/frontchannel-logout?sid=" + encodeURIComponent(SID) + "&iss=" + encodeURIComponent(PROVIDER_ISSUER));
    assert.deepEqual(auth.normalizeFrontchannel(url), { sid: SID, issuer: PROVIDER_ISSUER });
    assert.equal(auth.internalCentralOrigin(config("/tmp/test")), "http://central:8080");
    assert.throws(() => auth.normalizeFrontchannel(new URL(AUTH_ORIGIN + "/auth/entra/frontchannel-logout?sid=x&iss=https%3A%2F%2Fevil.example")), /invalid/i);
    assert.throws(() => auth.internalCentralOrigin({ centralOrigin: CENTRAL_ORIGIN, env: { SIRK_CENTRAL_INTERNAL_ORIGIN: "http://user:pass@central:8080" } }), /must be an HTTP/i);
});

test("Auth relay signs a typed logout ticket without sending sid in request body", async t => {
    const originalFetch = global.fetch;
    let captured;
    global.fetch = async (url, options) => {
        captured = { url, options };
        return new Response(JSON.stringify({ ok: true, revokedSessions: 2 }), { status: 200, headers: { "content-type": "application/json" } });
    };
    t.after(() => { global.fetch = originalFetch; });
    const url = new URL(AUTH_ORIGIN + "/auth/entra/frontchannel-logout?sid=" + encodeURIComponent(SID) + "&iss=" + encodeURIComponent(PROVIDER_ISSUER));
    const result = await auth.relayFrontchannelLogout(config("/tmp/test"), url);
    assert.equal(result.revokedSessions, 2);
    assert.equal(captured.url, "http://central:8080/auth/sso/frontchannel-logout");
    assert.equal(captured.options.method, "POST");
    assert.equal(captured.options.body, undefined);
    const raw = String(captured.options.headers.Authorization).replace(/^SIRK-Logout /, "");
    const ticket = verify(raw, SHARED, { issuer: AUTH_ORIGIN, audience: CENTRAL_ORIGIN, type: "logout" });
    assert.equal(ticket.sid, SID);
    assert.equal(ticket.providerIssuer, PROVIDER_ISSUER);
});

test("Central revokes every matching Entra session and rejects replay", async t => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sirk-frontchannel-"));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const cfg = config(dataDir);
    const app = createTicketRuntime(cfg);
    await new Promise((resolve, reject) => {
        app.server.once("error", reject);
        app.server.listen(0, "127.0.0.1", resolve);
    });
    t.after(() => new Promise(resolve => app.server.close(resolve)));
    const origin = "http://127.0.0.1:" + app.server.address().port;

    for (let index = 0; index < 2; index += 1) {
        app.sessions.issue({
            username: "user" + index,
            identityKey: "tenant:user" + index,
            source: "entra",
            role: "Auditor",
            status: "active",
            builtIn: false,
            entraSessionId: SID,
            entraIssuer: PROVIDER_ISSUER
        }, {});
    }
    app.sessions.issue({
        username: "other",
        identityKey: "tenant:other",
        source: "entra",
        role: "Auditor",
        status: "active",
        builtIn: false,
        entraSessionId: "different-session-id",
        entraIssuer: PROVIDER_ISSUER
    }, {});

    const ticket = logoutTicket();
    const first = await fetch(origin + "/auth/sso/frontchannel-logout", {
        method: "POST",
        headers: { Authorization: "SIRK-Logout " + ticket }
    });
    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), { ok: true, revokedSessions: 2 });
    assert.equal(app.sessions.list().length, 1);

    const replay = await fetch(origin + "/auth/sso/frontchannel-logout", {
        method: "POST",
        headers: { Authorization: "SIRK-Logout " + ticket }
    });
    assert.equal(replay.status, 409);
    assert.equal((await replay.json()).code, "SSO_LOGOUT_REPLAY");
});

test("Central rejects malformed or wrong-type logout tickets as 401", async t => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sirk-frontchannel-invalid-"));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const cfg = config(dataDir);
    const app = createTicketRuntime(cfg);
    await new Promise((resolve, reject) => {
        app.server.once("error", reject);
        app.server.listen(0, "127.0.0.1", resolve);
    });
    t.after(() => new Promise(resolve => app.server.close(resolve)));
    const origin = "http://127.0.0.1:" + app.server.address().port;
    const now = Math.floor(Date.now() / 1000);
    const login = sign({
        v: 1, typ: "login", iss: AUTH_ORIGIN, aud: CENTRAL_ORIGIN, iat: now, exp: now + 60,
        jti: "login_jti_abcdefghijklmnop", tid: "tenant", oid: "object"
    }, SHARED);
    for (const authorization of ["SIRK-Logout broken", "SIRK-Logout " + login]) {
        const response = await fetch(origin + "/auth/sso/frontchannel-logout", { method: "POST", headers: { Authorization: authorization } });
        assert.equal(response.status, 401);
        assert.equal((await response.json()).code, "SSO_LOGOUT_INVALID");
    }
});
