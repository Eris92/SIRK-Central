"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createCentralRuntime } = require("../src/server");
const telemetry = require("../src/portal-telemetry-store");

const PUBLIC_ORIGIN = "https://central.example.test";
const REQUESTS = Math.max(8, Math.min(100, Number(process.env.SIRK_CONCURRENCY_TEST_REQUESTS || 24)));

function temporaryDirectory() { return fs.mkdtempSync(path.join(os.tmpdir(), "sirk-protocol-concurrency-")); }
function config(dataDir) {
    const env = {
        NODE_ENV: "test",
        SIRK_AUDIT_INTEGRITY_KEY: "K".repeat(48),
        SIRK_PUBLIC_ORIGIN: PUBLIC_ORIGIN,
        SIRK_PORTAL_AUTH_RATE_LIMIT: "10000",
        SIRK_PORTAL_HEARTBEAT_RATE_LIMIT: "10000",
        SIRK_PORTAL_COMMAND_RATE_LIMIT: "10000",
        SIRK_TICKET_INGEST_RATE_LIMIT: "10000",
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
function ticket(index, timestamp) {
    return {
        ticketId: "concurrent-" + index,
        title: "Concurrent ticket " + index,
        status: "new",
        priority: "normal",
        createdAtUtc: timestamp,
        updatedAtUtc: timestamp,
        sla: { breached: false },
        sync: { state: "synchronized", lastSyncAtUtc: timestamp }
    };
}

async function harness(t) {
    const dataDir = temporaryDirectory();
    const app = createCentralRuntime(config(dataDir));
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
    const portal = app.portalRegistry.createPortal({ id: "portal-concurrency", name: "Concurrency Portal" });
    const tenant = app.organizations.createTenant({ code: "tenant-concurrency", name: "Concurrency Tenant" }, actor);
    const customer = app.organizations.createCustomer({ tenantId: tenant.id, code: "customer-concurrency", name: "Concurrency Customer" }, actor);
    const site = app.organizations.createSite({ customerId: customer.id, code: "site-concurrency", name: "Concurrency Site" }, actor);
    app.portalAssignments.assign(portal.id, { tenantId: tenant.id, customerId: customer.id, siteId: site.id }, actor, app.organizations, app.portalRegistry);
    app.ticketProjections.setPolicy(portal.id, {
        mode: "open",
        includeStatuses: [],
        includePriorities: [],
        includeDescription: false,
        includeRequester: false,
        allowCentralChanges: false
    });

    const authorization = portalAuthorization(portal.id, portal.token);
    async function request(requestPath, options = {}) {
        const response = await fetch(origin + requestPath, options);
        return { response, body: await response.json().catch(() => ({})) };
    }
    return { app, actor, portal, origin, authorization, request };
}

test("parallel signed heartbeats preserve valid final telemetry without request failures", async t => {
    const h = await harness(t);
    const timestamp = Date.now();
    const requests = Array.from({ length: REQUESTS }, (_, index) => {
        const body = JSON.stringify({
            portalVersion: "1.0.0-concurrency",
            buildCommit: "load-" + index,
            health: "ok",
            agentCount: index + 1,
            onlineAgents: index
        });
        const nonce = "nonce_concurrency_" + String(index).padStart(8, "0");
        return h.request("/api/portal/v1/heartbeat", {
            method: "POST",
            headers: {
                Authorization: h.authorization,
                "Content-Type": "application/json",
                "X-SIRK-Timestamp": String(timestamp + index),
                "X-SIRK-Nonce": nonce,
                "X-SIRK-Signature": telemetry.sign(h.portal.token, timestamp + index, nonce, body)
            },
            body
        });
    });

    const results = await Promise.all(requests);
    assert.deepEqual(new Set(results.map(item => item.response.status)), new Set([202]));
    const current = h.app.portalTelemetry.get(h.portal.id);
    assert.ok(current);
    assert.equal(current.status, "online");
    assert.equal(current.heartbeatCount, REQUESTS);
    assert.equal(current.metrics.health, "ok");
    assert.ok(Number.isFinite(current.metrics.agentCount));
    assert.ok(current.metrics.agentCount >= 1 && current.metrics.agentCount <= REQUESTS);
});

test("parallel ticket events do not lose projections", async t => {
    const h = await harness(t);
    const base = Date.now();
    const results = await Promise.all(Array.from({ length: REQUESTS }, (_, index) => {
        const timestamp = new Date(base + index).toISOString();
        return h.request("/api/portal/v1/tickets/events", {
            method: "POST",
            headers: { Authorization: h.authorization, "Content-Type": "application/json" },
            body: JSON.stringify({
                eventId: "evt-concurrent-" + index,
                type: "ticket.created",
                occurredAtUtc: timestamp,
                ticket: ticket(index, timestamp)
            })
        });
    }));

    assert.deepEqual(new Set(results.map(item => item.response.status)), new Set([202]));
    const stored = h.app.ticketProjections.list({ portalId: h.portal.id, limit: REQUESTS + 10 });
    assert.equal(stored.length, REQUESTS);
    assert.equal(new Set(stored.map(item => item.ticketId)).size, REQUESTS);
});

test("parallel command polling delivers one command only once within its lease", async t => {
    const h = await harness(t);
    const command = h.app.portalCommands.enqueue({
        portalId: h.portal.id,
        type: "diagnostics",
        payload: { scope: "runtime" },
        ttlMinutes: 10
    }, h.actor);
    const results = await Promise.all(Array.from({ length: REQUESTS }, () => h.request("/api/portal/v1/commands?limit=1", {
        headers: { Authorization: h.authorization }
    })));

    assert.deepEqual(new Set(results.map(item => item.response.status)), new Set([200]));
    const deliveries = results.flatMap(item => Array.isArray(item.body.commands) ? item.body.commands : []);
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].id, command.id);
});

test("parallel identical terminal acknowledgements are idempotent", async t => {
    const h = await harness(t);
    const command = h.app.portalCommands.enqueue({
        portalId: h.portal.id,
        type: "diagnostics",
        payload: { scope: "runtime" },
        ttlMinutes: 10
    }, h.actor);
    const delivery = h.app.portalCommands.deliver(h.portal.id, 1)[0];
    h.app.portalCommands.acknowledge(h.portal.id, command.id, {
        state: "running",
        progress: 10,
        message: "Started"
    });

    const payload = {
        state: "completed",
        progress: 100,
        result: { ok: true, digest: "same-result" },
        message: "Completed"
    };
    const results = await Promise.all(Array.from({ length: REQUESTS }, () => h.request("/api/portal/v1/commands/" + command.id + "/ack", {
        method: "POST",
        headers: { Authorization: h.authorization, "Content-Type": "application/json" },
        body: JSON.stringify(payload)
    })));

    assert.ok(delivery);
    assert.deepEqual(new Set(results.map(item => item.response.status)), new Set([200]));
    assert.equal(h.app.portalCommands.get(command.id).state, "completed");
});
