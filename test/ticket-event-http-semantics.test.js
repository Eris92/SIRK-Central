"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createTicketRuntime } = require("../src/server-v15");

const PUBLIC_ORIGIN = "https://central.example.test";

function temporaryDirectory() { return fs.mkdtempSync(path.join(os.tmpdir(), "sirk-ticket-event-http-")); }
function config(dataDir) {
    const env = {
        NODE_ENV: "test",
        SIRK_PUBLIC_ORIGIN: PUBLIC_ORIGIN,
        SIRK_PORTAL_AUTH_RATE_LIMIT: "1000",
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
function portalAuthorization(portalId, token) {
    return "SIRK-Portal " + Buffer.from(portalId + ":" + token).toString("base64url");
}
function ticket(ticketId, updatedAtUtc, overrides = {}) {
    return Object.assign({
        ticketId,
        title: "HTTP event ticket",
        status: "new",
        priority: "normal",
        createdAtUtc: updatedAtUtc,
        updatedAtUtc,
        sla: { breached: false },
        sync: { state: "synchronized", lastSyncAtUtc: updatedAtUtc }
    }, overrides);
}

async function harness(t) {
    const dataDir = temporaryDirectory();
    const app = createTicketRuntime(config(dataDir));
    await new Promise((resolve, reject) => {
        app.server.once("error", reject);
        app.server.listen(0, "127.0.0.1", resolve);
    });
    const origin = "http://127.0.0.1:" + app.server.address().port;
    t.after(async () => {
        await new Promise(resolve => app.server.close(resolve));
        fs.rmSync(dataDir, { recursive: true, force: true });
    });

    const actor = { username: "admin", identityKey: "breakglass:admin", source: "local", role: "BreakGlass", status: "active", builtIn: true };
    const portal = app.portalRegistry.createPortal({ id: "portal-events", name: "Event Semantics Portal" });
    const tenant = app.organizations.createTenant({ code: "tenant-events", name: "Events Tenant" }, actor);
    const customer = app.organizations.createCustomer({ tenantId: tenant.id, code: "customer-events", name: "Events Customer" }, actor);
    const site = app.organizations.createSite({ customerId: customer.id, code: "site-events", name: "Events Site" }, actor);
    app.portalAssignments.assign(portal.id, { tenantId: tenant.id, customerId: customer.id, siteId: site.id }, actor, app.organizations, app.portalRegistry);
    app.ticketProjections.setPolicy(portal.id, {
        mode: "open",
        includeStatuses: [],
        includePriorities: [],
        includeDescription: false,
        includeRequester: false,
        allowCentralChanges: false
    });

    async function post(body) {
        const response = await fetch(origin + "/api/portal/v1/tickets/events", {
            method: "POST",
            headers: {
                Authorization: portalAuthorization(portal.id, portal.token),
                "Content-Type": "application/json"
            },
            body: JSON.stringify(body)
        });
        return { response, body: await response.json() };
    }
    return { app, portal, post };
}

test("single invalid event returns its precise client error instead of HTTP 207", async t => {
    const h = await harness(t);
    const result = await h.post({
        eventId: "evt-invalid-single",
        type: "ticket.deleted",
        occurredAtUtc: new Date().toISOString(),
        ticket: ticket("ticket-invalid", new Date().toISOString())
    });

    assert.equal(result.response.status, 400);
    assert.equal(result.body.ok, false);
    assert.equal(result.body.retryable, false);
    assert.match(result.body.code, /TICKET|EVENT/);
});

test("single replay conflict returns HTTP 409", async t => {
    const h = await harness(t);
    const timestamp = new Date().toISOString();
    const event = {
        eventId: "evt-replay-conflict",
        type: "ticket.created",
        occurredAtUtc: timestamp,
        ticket: ticket("ticket-replay", timestamp)
    };
    const first = await h.post(event);
    assert.equal(first.response.status, 202);

    const changed = structuredClone(event);
    changed.ticket.title = "Changed replay payload";
    const conflict = await h.post(changed);
    assert.equal(conflict.response.status, 409);
    assert.equal(conflict.body.ok, false);
    assert.equal(conflict.body.retryable, false);
    assert.equal(conflict.body.code, "TICKET_EVENT_REPLAY_CONFLICT");
});

test("explicit event batch returns HTTP 207 with per-item status and retry guidance", async t => {
    const h = await harness(t);
    const timestamp = new Date().toISOString();
    const result = await h.post({
        events: [
            {
                eventId: "evt-batch-valid",
                type: "ticket.created",
                occurredAtUtc: timestamp,
                ticket: ticket("ticket-batch-valid", timestamp)
            },
            {
                eventId: "evt-batch-invalid",
                type: "ticket.deleted",
                occurredAtUtc: timestamp,
                ticket: ticket("ticket-batch-invalid", timestamp)
            }
        ]
    });

    assert.equal(result.response.status, 207);
    assert.equal(result.body.batch, true);
    assert.equal(result.body.accepted, 1);
    assert.equal(result.body.rejected, 1);
    assert.equal(result.body.results.length, 2);
    assert.equal(result.body.results[0].status, 202);
    assert.equal(result.body.results[0].retryable, false);
    assert.equal(result.body.results[1].status, 400);
    assert.equal(result.body.results[1].retryable, false);
});

test("events property must be an array", async t => {
    const h = await harness(t);
    const result = await h.post({ events: "not-an-array" });
    assert.equal(result.response.status, 400);
    assert.equal(result.body.code, "TICKET_EVENTS_INVALID");
});
