"use strict";

const crypto = require("node:crypto");

const origin = String(process.env.SIRK_SIMULATOR_ORIGIN || "").replace(/\/+$/, "");
const portalId = String(process.env.SIRK_SIMULATOR_PORTAL_ID || "");
const portalToken = String(process.env.SIRK_SIMULATOR_PORTAL_TOKEN || "");
if (!origin || !portalId || !portalToken) {
    process.stderr.write("Set SIRK_SIMULATOR_ORIGIN, SIRK_SIMULATOR_PORTAL_ID and SIRK_SIMULATOR_PORTAL_TOKEN.\n");
    process.exit(2);
}

const authorization = "SIRK-Portal " + Buffer.from(portalId + ":" + portalToken).toString("base64url");
async function rawRequest(path, options = {}) {
    const method = options.method || "GET";
    const response = await fetch(origin + path, Object.assign({}, options, {
        headers: Object.assign({ Authorization: authorization, "Content-Type": "application/json" }, options.headers || {})
    }));
    const body = await response.json().catch(() => ({}));
    return { method, response, body };
}
async function request(path, options = {}) {
    const result = await rawRequest(path, options);
    if (!result.response.ok) {
        throw new Error(result.method + " " + path + " failed: " + result.response.status + " " + JSON.stringify(result.body));
    }
    return result.body;
}
async function expectStatus(path, status, options = {}) {
    const result = await rawRequest(path, options);
    if (result.response.status !== status) {
        throw new Error(result.method + " " + path + " expected " + status + " but received " + result.response.status + " " + JSON.stringify(result.body));
    }
    return result.body;
}
function signedHeartbeat(payload) {
    const rawBody = JSON.stringify(payload);
    const timestamp = String(Date.now());
    const nonce = crypto.randomBytes(18).toString("base64url");
    const signature = crypto.createHmac("sha256", portalToken)
        .update(timestamp + "\n" + nonce + "\n" + rawBody)
        .digest("base64url");
    return { rawBody, headers: { "X-SIRK-Timestamp": timestamp, "X-SIRK-Nonce": nonce, "X-SIRK-Signature": signature } };
}

async function main() {
    const heartbeat = signedHeartbeat({
        portalVersion: "simulator-1.1",
        buildCommit: "simulator",
        platform: process.platform,
        hostname: "sirk-portal-simulator",
        health: "ok",
        agentCount: 8,
        onlineAgents: 7,
        cpuPercent: 11,
        memoryUsedBytes: 320 * 1024 * 1024,
        memoryTotalBytes: 1024 * 1024 * 1024,
        lastBackupAtUtc: new Date().toISOString(),
        lastBackupStatus: "ok",
        capabilities: ["tickets", "commands", "heartbeat"]
    });
    await request("/api/portal/v1/heartbeat", { method: "POST", headers: heartbeat.headers, body: heartbeat.rawBody });
    const replay = await expectStatus("/api/portal/v1/heartbeat", 409, { method: "POST", headers: heartbeat.headers, body: heartbeat.rawBody });
    if (replay.code !== "HEARTBEAT_REPLAY") throw new Error("Heartbeat replay was not rejected with HEARTBEAT_REPLAY.");

    const config = await request("/api/portal/v1/config");
    const policy = await request("/api/portal/v1/ticket-policy");
    if (!config.portalId || !policy.assignment || policy.portalId !== portalId) {
        throw new Error("Portal assignment was not returned by the Central protocol.");
    }
    if (policy.policy.mode === "none") {
        throw new Error("Ticket publication policy is 'none'. Configure a test policy before running the simulator.");
    }

    const now = new Date().toISOString();
    const snapshotBody = {
        generatedAtUtc: now,
        cursor: "sim-" + Date.now(),
        full: false,
        tickets: [{
            ticketId: "sim-100",
            title: "Testowe zgloszenie Portalu",
            description: "Automatyczny test protokolu Central-Portal.",
            status: "new",
            priority: "high",
            category: "test",
            externalSystem: "local",
            source: "portal",
            requester: { id: "sim-user", displayName: "Portal Simulator" },
            createdAtUtc: now,
            updatedAtUtc: now,
            sla: { breached: false },
            sync: { state: "synchronized", lastSyncAtUtc: now }
        }]
    };
    const snapshot = await request("/api/portal/v1/tickets/snapshot", { method: "POST", body: JSON.stringify(snapshotBody) });
    if (snapshot.accepted !== 1) throw new Error("Snapshot did not accept exactly one ticket: " + JSON.stringify(snapshot));
    const duplicateSnapshot = await request("/api/portal/v1/tickets/snapshot", { method: "POST", body: JSON.stringify(snapshotBody) });
    if (duplicateSnapshot.duplicate !== true) throw new Error("Duplicate snapshot was not detected.");

    const eventBody = {
        events: [{
            eventId: "evt-sim-" + Date.now(),
            type: "ticket.status_changed",
            occurredAtUtc: new Date(Date.now() + 1000).toISOString(),
            ticket: {
                ticketId: "sim-100",
                title: "Testowe zgloszenie Portalu",
                description: "Automatyczny test protokolu Central-Portal.",
                status: "in_progress",
                priority: "high",
                category: "test",
                externalSystem: "local",
                source: "portal",
                createdAtUtc: now,
                updatedAtUtc: new Date(Date.now() + 1000).toISOString(),
                sla: { breached: false },
                sync: { state: "synchronized", lastSyncAtUtc: now }
            }
        }]
    };
    const events = await request("/api/portal/v1/tickets/events", { method: "POST", body: JSON.stringify(eventBody) });
    if (events.accepted !== 1) throw new Error("Ticket event was not accepted: " + JSON.stringify(events));
    const duplicateEvents = await request("/api/portal/v1/tickets/events", { method: "POST", body: JSON.stringify(eventBody) });
    if (duplicateEvents.duplicates !== 1) throw new Error("Duplicate ticket event was not detected.");

    const commands = await request("/api/portal/v1/commands?limit=20");
    for (const command of commands.commands || []) {
        await request("/api/portal/v1/commands/" + encodeURIComponent(command.id) + "/ack", {
            method: "POST",
            body: JSON.stringify({ state: "running", progress: 50, message: "Portal simulator executing" })
        });
        await request("/api/portal/v1/commands/" + encodeURIComponent(command.id) + "/ack", {
            method: "POST",
            body: JSON.stringify({ state: "completed", progress: 100, message: "Portal simulator completed", result: { simulator: true } })
        });
    }

    process.stdout.write(JSON.stringify({
        ok: true,
        portalId,
        config,
        policy,
        heartbeatReplayRejected: true,
        snapshot,
        duplicateSnapshot,
        events,
        duplicateEvents,
        commandsAcknowledged: (commands.commands || []).length
    }, null, 2) + "\n");
}

main().catch(error => {
    process.stderr.write(error.stack + "\n");
    process.exit(1);
});
