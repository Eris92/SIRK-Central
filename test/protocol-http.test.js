"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createTicketRuntime } = require("../src/server-v15");
const telemetry = require("../src/portal-telemetry-store");

const PUBLIC_ORIGIN = "https://central.example.test";
const CSRF = "abcdefghijklmnopqrstuvwxyzABCDEFGH123456789";

function temporaryDirectory() {
    return fs.mkdtempSync(path.join(os.tmpdir(), "sirk-http-v15-"));
}

function config(dataDir) {
    const env = {
        NODE_ENV: "test",
        SIRK_PUBLIC_ORIGIN: PUBLIC_ORIGIN,
        SIRK_PORTAL_HEARTBEAT_RATE_LIMIT: "3",
        SIRK_PORTAL_HEARTBEAT_RATE_WINDOW_MS: "60000",
        SIRK_PORTAL_AUTH_RATE_LIMIT: "1000",
        SIRK_PORTAL_COMMAND_RATE_LIMIT: "1000",
        SIRK_TICKET_INGEST_RATE_LIMIT: "1000",
        SIRK_UPDATER_TOKEN: "U".repeat(64),
        SIRK_UPDATER_ORIGIN: "http://updater:8090",
        SIRK_UPDATER_ALLOWED_HOSTS: "updater"
    };
    return {
        bindHost: "127.0.0.1",
        port: 0,
        publicOrigin: PUBLIC_ORIGIN,
        authOrigin: "",
        ssoSharedSecret: "",
        adminUsername: "admin",
        adminPasswordHash: "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        accessKeyHash: "sha256$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        dataDir,
        sessionIdleMinutes: 30,
        sessionAbsoluteHours: 8,
        trustProxy: false,
        env
    };
}

function identity(role, suffix, overrides = {}) {
    return Object.assign({
        ok: true,
        username: role.toLowerCase() + suffix,
        displayName: role + " " + suffix,
        identityKey: "tenant:" + role.toLowerCase() + suffix,
        source: "entra",
        role,
        status: "active",
        builtIn: false
    }, overrides);
}

function sessionCookies(token) {
    return "sirk_central_session=" + token + "; sirk_central_csrf=" + CSRF;
}

function portalAuthorization(portalId, token) {
    return "SIRK-Portal " + Buffer.from(portalId + ":" + token).toString("base64url");
}

function heartbeatEnvelope(token, body, nonce, timestamp = Date.now()) {
    const rawBody = JSON.stringify(body);
    return {
        rawBody,
        headers: {
            "Content-Type": "application/json",
            "X-SIRK-Timestamp": String(timestamp),
            "X-SIRK-Nonce": nonce,
            "X-SIRK-Signature": telemetry.sign(token, timestamp, nonce, rawBody)
        }
    };
}

async function startHarness(t) {
    const dataDir = temporaryDirectory();
    const app = createTicketRuntime(config(dataDir));
    await new Promise((resolve, reject) => {
        app.server.once("error", reject);
        app.server.listen(0, "127.0.0.1", resolve);
    });
    const address = app.server.address();
    const origin = "http://127.0.0.1:" + address.port;
    t.after(async () => {
        await new Promise(resolve => app.server.close(resolve));
        fs.rmSync(dataDir, { recursive: true, force: true });
    });

    const admin = identity("Admin", "-requester");
    const secAdmin = identity("SecAdmin", "-approver");
    const pending = identity("Admin", "-pending", { status: "pending" });
    const breakGlass = identity("BreakGlass", "", {
        username: "admin",
        displayName: "BreakGlass",
        identityKey: "breakglass:admin",
        source: "local",
        role: "BreakGlass",
        builtIn: true
    });
    const sessions = {
        admin: app.sessions.issue(admin, { ip: "127.0.0.1", userAgent: "node-test" }).token,
        secAdmin: app.sessions.issue(secAdmin, { ip: "127.0.0.1", userAgent: "node-test" }).token,
        pending: app.sessions.issue(pending, { ip: "127.0.0.1", userAgent: "node-test" }).token,
        breakGlass: app.sessions.issue(breakGlass, { ip: "127.0.0.1", userAgent: "node-test" }).token
    };

    const portal = app.portalRegistry.createPortal({ id: "portal-http", name: "HTTP Test Portal" });
    const tenant = app.organizations.createTenant({ code: "tenant-http", name: "HTTP Tenant" }, breakGlass);
    const customer = app.organizations.createCustomer({ tenantId: tenant.id, code: "customer-http", name: "HTTP Customer" }, breakGlass);
    const site = app.organizations.createSite({ customerId: customer.id, code: "site-http", name: "HTTP Site" }, breakGlass);
    app.portalAssignments.assign(portal.id, {
        tenantId: tenant.id,
        customerId: customer.id,
        siteId: site.id
    }, breakGlass, app.organizations, app.portalRegistry);

    async function request(requestPath, options = {}) {
        const response = await fetch(origin + requestPath, options);
        const body = await response.json().catch(() => ({}));
        return { response, body };
    }
    function sessionHeaders(token, extra = {}) {
        return Object.assign({
            Cookie: sessionCookies(token),
            Origin: PUBLIC_ORIGIN,
            "Sec-Fetch-Site": "same-origin",
            "X-SIRK-CSRF": CSRF,
            "Content-Type": "application/json"
        }, extra);
    }
    function portalHeaders(extra = {}) {
        return Object.assign({ Authorization: portalAuthorization(portal.id, portal.token) }, extra);
    }

    return { app, origin, portal, tenant, customer, site, sessions, request, sessionHeaders, portalHeaders };
}

test("canonical v15 HTTP protocol enforces authentication replay CSRF RBAC and idempotency", async t => {
    const h = await startHarness(t);

    await t.test("anonymous and Pending sessions cannot read ticket projections", async () => {
        const anonymous = await h.request("/api/tickets");
        assert.equal(anonymous.response.status, 401);
        const pending = await h.request("/api/tickets", { headers: h.sessionHeaders(h.sessions.pending) });
        assert.equal(pending.response.status, 403);
    });

    await t.test("signed heartbeat accepts valid telemetry rejects replay and rate limits", async () => {
        const body = { portalVersion: "1.0.0-test", buildCommit: "http", health: "ok", agentCount: 3, onlineAgents: 2 };
        const first = heartbeatEnvelope(h.portal.token, body, "nonce_http_00000001");
        const accepted = await h.request("/api/portal/v1/heartbeat", {
            method: "POST",
            headers: h.portalHeaders(first.headers),
            body: first.rawBody
        });
        assert.equal(accepted.response.status, 202);
        assert.equal(accepted.body.ok, true);

        const replay = await h.request("/api/portal/v1/heartbeat", {
            method: "POST",
            headers: h.portalHeaders(first.headers),
            body: first.rawBody
        });
        assert.equal(replay.response.status, 409);
        assert.equal(replay.body.code, "HEARTBEAT_REPLAY");

        const second = heartbeatEnvelope(h.portal.token, body, "nonce_http_00000002");
        assert.equal((await h.request("/api/portal/v1/heartbeat", { method: "POST", headers: h.portalHeaders(second.headers), body: second.rawBody })).response.status, 202);
        const third = heartbeatEnvelope(h.portal.token, body, "nonce_http_00000003");
        const limited = await h.request("/api/portal/v1/heartbeat", { method: "POST", headers: h.portalHeaders(third.headers), body: third.rawBody });
        assert.equal(limited.response.status, 429);
        assert.equal(limited.body.code, "RATE_LIMITED");
        assert.ok(Number(limited.response.headers.get("retry-after")) >= 1);
    });

    await t.test("ticket policy requires CSRF and Portal snapshot/event replay is deterministic", async () => {
        const policyPath = "/api/tickets/policy/" + h.portal.id;
        const missingCsrf = await h.request(policyPath, {
            method: "PUT",
            headers: { Cookie: "sirk_central_session=" + h.sessions.breakGlass, "Content-Type": "application/json" },
            body: JSON.stringify({ mode: "open" })
        });
        assert.equal(missingCsrf.response.status, 403);

        const policy = await h.request(policyPath, {
            method: "PUT",
            headers: h.sessionHeaders(h.sessions.breakGlass),
            body: JSON.stringify({
                mode: "open",
                includeStatuses: [],
                includePriorities: [],
                includeDescription: false,
                includeRequester: false,
                allowCentralChanges: true
            })
        });
        assert.equal(policy.response.status, 200);
        assert.equal(policy.body.policy.mode, "open");

        const generatedAtUtc = new Date().toISOString();
        const snapshotBody = {
            generatedAtUtc,
            cursor: "http-cursor-1",
            full: true,
            tickets: [{
                ticketId: "http-100",
                title: "HTTP ticket",
                description: "must be redacted",
                status: "new",
                priority: "high",
                requester: { id: "user-1", displayName: "Requester" },
                createdAtUtc: generatedAtUtc,
                updatedAtUtc: generatedAtUtc,
                sla: { breached: false },
                sync: { state: "synchronized", lastSyncAtUtc: generatedAtUtc }
            }]
        };
        const snapshotOptions = {
            method: "POST",
            headers: h.portalHeaders({ "Content-Type": "application/json" }),
            body: JSON.stringify(snapshotBody)
        };
        const snapshot = await h.request("/api/portal/v1/tickets/snapshot", snapshotOptions);
        assert.equal(snapshot.response.status, 202);
        assert.equal(snapshot.body.accepted, 1);
        const duplicate = await h.request("/api/portal/v1/tickets/snapshot", snapshotOptions);
        assert.equal(duplicate.response.status, 202);
        assert.equal(duplicate.body.duplicate, true);

        const conflictBody = structuredClone(snapshotBody);
        conflictBody.tickets[0].title = "different replay";
        const conflict = await h.request("/api/portal/v1/tickets/snapshot", {
            method: "POST",
            headers: h.portalHeaders({ "Content-Type": "application/json" }),
            body: JSON.stringify(conflictBody)
        });
        assert.equal(conflict.response.status, 409);
        assert.equal(conflict.body.code, "TICKET_SNAPSHOT_REPLAY_CONFLICT");

        const list = await h.request("/api/tickets", { headers: h.sessionHeaders(h.sessions.breakGlass) });
        assert.equal(list.response.status, 200);
        assert.equal(list.body.tickets.length, 1);
        assert.equal(list.body.tickets[0].description, "");
        assert.equal(list.body.tickets[0].requester, null);
        assert.equal(list.body.tickets[0].tenantId, h.tenant.id);
        assert.equal(list.body.tickets[0].customerId, h.customer.id);
        assert.equal(list.body.tickets[0].siteId, h.site.id);

        const eventBody = {
            eventId: "evt-http-100",
            type: "ticket.status_changed",
            occurredAtUtc: new Date(Date.now() + 1000).toISOString(),
            ticket: Object.assign({}, snapshotBody.tickets[0], {
                status: "in_progress",
                updatedAtUtc: new Date(Date.now() + 1000).toISOString()
            })
        };
        const event = await h.request("/api/portal/v1/tickets/events", {
            method: "POST",
            headers: h.portalHeaders({ "Content-Type": "application/json" }),
            body: JSON.stringify(eventBody)
        });
        assert.equal(event.response.status, 202);
        assert.equal(event.body.accepted, 1);
        const duplicateEvent = await h.request("/api/portal/v1/tickets/events", {
            method: "POST",
            headers: h.portalHeaders({ "Content-Type": "application/json" }),
            body: JSON.stringify(eventBody)
        });
        assert.equal(duplicateEvent.response.status, 202);
        assert.equal(duplicateEvent.body.duplicates, 1);
    });

    await t.test("approval center enforces independent decision and high-risk command is single-use", async () => {
        const requestApproval = await h.request("/api/approval-center", {
            method: "POST",
            headers: h.sessionHeaders(h.sessions.admin),
            body: JSON.stringify({
                type: "operation.high-risk",
                title: "Restart HTTP Portal",
                reason: "HTTP regression test",
                requiredApprovals: 1,
                ttlMinutes: 60,
                scope: { portalId: h.portal.id },
                payload: { portalId: h.portal.id, operation: "restart" }
            })
        });
        assert.equal(requestApproval.response.status, 201);
        const approvalId = requestApproval.body.request.id;

        const selfApproval = await h.request("/api/approval-center/" + approvalId + "/approve", {
            method: "POST",
            headers: h.sessionHeaders(h.sessions.admin),
            body: JSON.stringify({ comment: "self" })
        });
        assert.equal(selfApproval.response.status, 403);

        const approved = await h.request("/api/approval-center/" + approvalId + "/approve", {
            method: "POST",
            headers: h.sessionHeaders(h.sessions.secAdmin),
            body: JSON.stringify({ comment: "independent approval" })
        });
        assert.equal(approved.response.status, 200);
        assert.equal(approved.body.request.state, "approved");
        assert.equal(approved.body.execution.state, "authorized");

        const queued = await h.request("/api/portal-operations", {
            method: "POST",
            headers: h.sessionHeaders(h.sessions.breakGlass),
            body: JSON.stringify({ portalId: h.portal.id, type: "restart", approvalId, payload: { reason: "test" } })
        });
        assert.equal(queued.response.status, 201);
        assert.equal(queued.body.command.approvalId, approvalId);

        const reused = await h.request("/api/portal-operations", {
            method: "POST",
            headers: h.sessionHeaders(h.sessions.breakGlass),
            body: JSON.stringify({ portalId: h.portal.id, type: "restart", approvalId })
        });
        assert.equal(reused.response.status, 409);
        assert.equal(reused.body.code, "APPROVAL_REQUIRED");
    });

    await t.test("Portal command poll and acknowledgements enforce ordering and idempotency", async () => {
        const queued = await h.request("/api/portal-operations", {
            method: "POST",
            headers: h.sessionHeaders(h.sessions.breakGlass),
            body: JSON.stringify({ portalId: h.portal.id, type: "backup", payload: { mode: "full", token: "secret-value" } })
        });
        assert.equal(queued.response.status, 201);
        assert.equal(queued.body.command.payload.token, "[redacted]");
        const commandId = queued.body.command.id;

        const premature = await h.request("/api/portal/v1/commands/" + commandId + "/ack", {
            method: "POST",
            headers: h.portalHeaders({ "Content-Type": "application/json" }),
            body: JSON.stringify({ state: "running" })
        });
        assert.equal(premature.response.status, 409);
        assert.equal(premature.body.code, "COMMAND_ACK_OUT_OF_ORDER");

        const poll = await h.request("/api/portal/v1/commands?limit=20", { headers: h.portalHeaders() });
        assert.equal(poll.response.status, 200);
        assert.ok(poll.body.commands.some(item => item.id === commandId));

        const running = await h.request("/api/portal/v1/commands/" + commandId + "/ack", {
            method: "POST",
            headers: h.portalHeaders({ "Content-Type": "application/json" }),
            body: JSON.stringify({ state: "running", progress: 50 })
        });
        assert.equal(running.response.status, 200);
        assert.equal(running.body.command.state, "running");

        const completedOptions = {
            method: "POST",
            headers: h.portalHeaders({ "Content-Type": "application/json" }),
            body: JSON.stringify({ state: "completed", progress: 100, result: { token: "secret-result", ok: true } })
        };
        const completed = await h.request("/api/portal/v1/commands/" + commandId + "/ack", completedOptions);
        assert.equal(completed.response.status, 200);
        assert.equal(completed.body.command.result.token, "[redacted]");
        const repeated = await h.request("/api/portal/v1/commands/" + commandId + "/ack", completedOptions);
        assert.equal(repeated.response.status, 200);
        assert.equal(repeated.body.command.state, "completed");
    });
});
