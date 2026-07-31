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
async function request(path, options = {}) {
    const response = await fetch(origin + path, Object.assign({}, options, { headers: Object.assign({ Authorization: authorization, "Content-Type": "application/json" }, options.headers || {}) }));
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(options.method + " " + path + " failed: " + response.status + " " + JSON.stringify(body));
    return body;
}
function signedHeartbeat(payload) {
    const rawBody = JSON.stringify(payload);
    const timestamp = String(Date.now());
    const nonce = crypto.randomBytes(18).toString("base64url");
    const signature = crypto.createHmac("sha256", portalToken).update(timestamp + "\n" + nonce + "\n" + rawBody).digest("base64url");
    return { rawBody, headers: { "X-SIRK-Timestamp": timestamp, "X-SIRK-Nonce": nonce, "X-SIRK-Signature": signature } };
}
async function main() {
    const heartbeat = signedHeartbeat({ protocolVersion: 1, portalVersion: "simulator-1.0", commit: "simulator", health: "ok", agentCount: 8, onlineAgents: 7, resources: { cpuPercent: 11, memoryMb: 320 }, backup: { status: "ok", lastSuccessAtUtc: new Date().toISOString() }, update: {} });
    await request("/api/portal/v1/heartbeat", { method: "POST", headers: heartbeat.headers, body: heartbeat.rawBody });
    const config = await request("/api/portal/v1/config", { method: "GET" });
    const policy = await request("/api/portal/v1/ticket-policy", { method: "GET" });
    const now = new Date().toISOString();
    const snapshot = await request("/api/portal/v1/tickets/snapshot", { method: "POST", body: JSON.stringify({ cursor: "sim-1", full: false, tickets: [{ ticketId: "sim-100", title: "Testowe zgloszenie Portalu", description: "Automatyczny test protokolu Central-Portal.", status: "new", priority: "high", category: "test", externalSystem: "local", source: "portal", requester: { id: "sim-user", displayName: "Portal Simulator" }, createdAtUtc: now, updatedAtUtc: now, sla: { breached: false }, sync: { state: "synchronized", lastSyncAtUtc: now } }] }) });
    const events = await request("/api/portal/v1/tickets/events", { method: "POST", body: JSON.stringify({ events: [{ type: "ticket.status_changed", ticket: { ticketId: "sim-100", title: "Testowe zgloszenie Portalu", description: "Automatyczny test protokolu Central-Portal.", status: "in_progress", priority: "high", category: "test", externalSystem: "local", source: "portal", createdAtUtc: now, updatedAtUtc: new Date(Date.now() + 1000).toISOString(), sla: { breached: false }, sync: { state: "synchronized", lastSyncAtUtc: now } } }] }) });
    const commands = await request("/api/portal/v1/commands?limit=20", { method: "GET" });
    for (const command of commands.commands || []) {
        await request("/api/portal/v1/commands/" + encodeURIComponent(command.id) + "/ack", { method: "POST", body: JSON.stringify({ state: "running", progress: 50, message: "Portal simulator executing" }) });
        await request("/api/portal/v1/commands/" + encodeURIComponent(command.id) + "/ack", { method: "POST", body: JSON.stringify({ state: "completed", progress: 100, message: "Portal simulator completed", result: { simulator: true } }) });
    }
    process.stdout.write(JSON.stringify({ ok: true, portalId, config, policy, snapshot, events, commandsAcknowledged: (commands.commands || []).length }, null, 2) + "\n");
}
main().catch(error => { process.stderr.write(error.stack + "\n"); process.exit(1); });
