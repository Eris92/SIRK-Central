"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { hashAccessKey, hashSecret } = require("../src/security");
const telemetry = require("../src/portal-telemetry-store");
const { createTicketRuntime } = require("../src/server-v15");

const CSRF = "C".repeat(43);
const TENANT_ID = "00000000-0000-0000-0000-000000000001";

function roleIdentity(role, index, overrides = {}) {
    const oid = "00000000-0000-0000-0000-" + String(index).padStart(12, "0");
    return Object.assign({
        username: role.toLowerCase(),
        displayName: role,
        identityKey: TENANT_ID + ":" + oid,
        tenantId: TENANT_ID,
        objectId: oid,
        source: "entra",
        role,
        status: "active",
        builtIn: false
    }, overrides);
}

function headers(token, config, extra = {}) {
    return Object.assign({
        cookie: "sirk_central_session=" + token + "; sirk_central_csrf=" + CSRF,
        "x-sirk-csrf": CSRF,
        origin: config.publicOrigin,
        "sec-fetch-site": "same-origin",
        "content-type": "application/json",
        "user-agent": "sirk-http-matrix"
    }, extra);
}

async function request(origin, route, options = {}) {
    const response = await fetch(origin + route, {
        method: options.method || "GET",
        headers: options.headers || {},
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        redirect: "manual"
    });
    const payload = await response.json().catch(() => ({}));
    return { response, payload };
}

function portalAuthorization(id, token) {
    return "SIRK-Portal " + Buffer.from(id + ":" + token).toString("base64url");
}

async function fixture(t) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sirk-http-matrix-"));
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
        env: {
            NODE_ENV: "test",
            SIRK_PORTAL_AUTH_RATE_LIMIT: "10000",
            SIRK_TICKET_INGEST_RATE_LIMIT: "10000",
            SIRK_PORTAL_COMMAND_RATE_LIMIT: "10000",
            SIRK_PORTAL_HEARTBEAT_RATE_LIMIT: "10000"
        }
    };
    const app = createTicketRuntime(config);
    await new Promise((resolve, reject) => {
        app.server.once("error", reject);
        app.server.listen(0, "127.0.0.1", resolve);
    });
    t.after(() => new Promise(resolve => app.server.close(resolve)));
    const origin = "http://127.0.0.1:" + app.server.address().port;

    const identities = {
        Pending: roleIdentity("Admin", 1, { username: "pending", status: "pending" }),
        OperatorL1: roleIdentity("OperatorL1", 2),
        SupportL2: roleIdentity("SupportL2", 3),
        EngineerL3: roleIdentity("EngineerL3", 4),
        Auditor: roleIdentity("Auditor", 5),
        Admin: roleIdentity("Admin", 6),
        SecAdmin: roleIdentity("SecAdmin", 7),
        BreakGlass: {
            username: "admin",
            displayName: "admin",
            identityKey: "breakglass:admin",
            source: "local",
            role: "BreakGlass",
            status: "active",
            builtIn: true
        }
    };
    const sessions = {};
    for (const [name, identity] of Object.entries(identities)) {
        sessions[name] = app.sessions.issue(identity, { ip: "127.0.0.1", userAgent: "sirk-http-matrix" }).token;
    }

    const portal = app.portalRegistry.createPortal({ id: "matrix-portal", name: "Matrix Portal" });
    const admin = identities.Admin;
    const tenant = app.organizations.createTenant({ code: "matrix", name: "Matrix Tenant" }, admin);
    const customer = app.organizations.createCustomer({ tenantId: tenant.id, code: "customer", name: "Matrix Customer" }, admin);
    const site = app.organizations.createSite({ customerId: customer.id, code: "site", name: "Matrix Site" }, admin);
    app.portalAssignments.assign(portal.id, { tenantId: tenant.id, customerId: customer.id, siteId: site.id }, admin, app.organizations, app.portalRegistry);
    app.accessStore.saveTeam({
        id: "matrix-team",
        name: "Matrix Team",
        members: Object.values(identities).filter(item => !item.builtIn).map(item => "entra:" + item.identityKey.toLowerCase()),
        portalIds: [portal.id],
        profile: { "portal.view": "allow" }
    });

    return { app, config, origin, identities, sessions, portal };
}

test("HTTP RBAC matrix covers tickets approvals and Portal operations", async t => {
    const fx = await fixture(t);
    const rows = [
        ["anonymous", null, 401, 401, 401],
        ["Pending", fx.sessions.Pending, 403, 403, 403],
        ["OperatorL1", fx.sessions.OperatorL1, 200, 201, 403],
        ["SupportL2", fx.sessions.SupportL2, 200, 201, 201],
        ["EngineerL3", fx.sessions.EngineerL3, 200, 201, 201],
        ["Auditor", fx.sessions.Auditor, 200, 403, 403],
        ["Admin", fx.sessions.Admin, 200, 201, 201],
        ["SecAdmin", fx.sessions.SecAdmin, 200, 201, 403],
        ["BreakGlass", fx.sessions.BreakGlass, 200, 201, 201]
    ];

    for (const [name, token, ticketStatus, approvalStatus, operationStatus] of rows) {
        const requestHeaders = token ? headers(token, fx.config) : {};
        const tickets = await request(fx.origin, "/api/tickets", { headers: requestHeaders });
        assert.equal(tickets.response.status, ticketStatus, name + " ticket read");

        const approval = await request(fx.origin, "/api/approval-center", {
            method: "POST",
            headers: requestHeaders,
            body: { type: "credential.use", title: "HTTP matrix " + name, reason: "RBAC matrix verification", requiredApprovals: 1 }
        });
        assert.equal(approval.response.status, approvalStatus, name + " approval submit");

        const operation = await request(fx.origin, "/api/portal-operations", {
            method: "POST",
            headers: requestHeaders,
            body: { portalId: fx.portal.id, type: "backup", payload: { mode: "full" } }
        });
        assert.equal(operation.response.status, operationStatus, name + " operation write");
    }
});

test("HTTP ticket policy write matrix and CSRF/Origin enforcement", async t => {
    const fx = await fixture(t);
    const expected = {
        Pending: 403,
        OperatorL1: 403,
        SupportL2: 200,
        EngineerL3: 200,
        Auditor: 403,
        Admin: 200,
        SecAdmin: 403,
        BreakGlass: 200
    };
    for (const [name, status] of Object.entries(expected)) {
        const result = await request(fx.origin, "/api/tickets/policy/" + fx.portal.id, {
            method: "PUT",
            headers: headers(fx.sessions[name], fx.config),
            body: { mode: "none", includeDescription: false, includeRequester: false, allowCentralChanges: false }
        });
        assert.equal(result.response.status, status, name + " ticket policy write");
    }

    const missingCsrf = await request(fx.origin, "/api/tickets/policy/" + fx.portal.id, {
        method: "PUT",
        headers: { cookie: "sirk_central_session=" + fx.sessions.Admin, origin: fx.config.publicOrigin, "content-type": "application/json" },
        body: { mode: "none" }
    });
    assert.equal(missingCsrf.response.status, 403);

    const foreignOrigin = await request(fx.origin, "/api/tickets/policy/" + fx.portal.id, {
        method: "PUT",
        headers: headers(fx.sessions.Admin, fx.config, { origin: "https://evil.example", "sec-fetch-site": "cross-site" }),
        body: { mode: "none" }
    });
    assert.equal(foreignOrigin.response.status, 403);
});

test("Portal HTTP protocol rejects replay and isolates command acknowledgements", async t => {
    const fx = await fixture(t);
    const authorization = portalAuthorization(fx.portal.id, fx.portal.token);
    const rawBody = JSON.stringify({ portalVersion: "matrix-1", health: "ok", agentCount: 2, onlineAgents: 2 });
    const timestamp = Date.now();
    const nonce = crypto.randomBytes(18).toString("base64url");
    const signature = telemetry.sign(fx.portal.token, timestamp, nonce, rawBody);
    const heartbeatHeaders = {
        authorization,
        "content-type": "application/json",
        "x-sirk-timestamp": String(timestamp),
        "x-sirk-nonce": nonce,
        "x-sirk-signature": signature
    };
    const accepted = await fetch(fx.origin + "/api/portal/v1/heartbeat", { method: "POST", headers: heartbeatHeaders, body: rawBody });
    assert.equal(accepted.status, 202);
    const replay = await fetch(fx.origin + "/api/portal/v1/heartbeat", { method: "POST", headers: heartbeatHeaders, body: rawBody });
    assert.equal(replay.status, 409);

    const queued = fx.app.portalCommands.enqueue({ portalId: fx.portal.id, type: "backup", payload: {} }, fx.identities.Admin);
    const poll = await request(fx.origin, "/api/portal/v1/commands?limit=20", { headers: { authorization } });
    assert.equal(poll.response.status, 200);
    assert.equal(poll.payload.commands.some(item => item.id === queued.id), true);

    const other = fx.app.portalRegistry.createPortal({ id: "other-portal", name: "Other Portal" });
    const wrongAck = await request(fx.origin, "/api/portal/v1/commands/" + queued.id + "/ack", {
        method: "POST",
        headers: { authorization: portalAuthorization(other.id, other.token), "content-type": "application/json" },
        body: { state: "completed", progress: 100 }
    });
    assert.notEqual(wrongAck.response.status, 200);
    assert.equal(fx.app.portalCommands.get(queued.id).state, "delivered");

    const running = await request(fx.origin, "/api/portal/v1/commands/" + queued.id + "/ack", {
        method: "POST",
        headers: { authorization, "content-type": "application/json" },
        body: { state: "running", progress: 50 }
    });
    assert.equal(running.response.status, 200);
    const completed = await request(fx.origin, "/api/portal/v1/commands/" + queued.id + "/ack", {
        method: "POST",
        headers: { authorization, "content-type": "application/json" },
        body: { state: "completed", progress: 100, result: { ok: true } }
    });
    assert.equal(completed.response.status, 200);
    assert.equal(completed.payload.command.state, "completed");
});
