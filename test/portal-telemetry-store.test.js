"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const telemetryFactory = require("../src/portal-telemetry-store");

function temporaryDirectory() {
    return fs.mkdtempSync(path.join(os.tmpdir(), "sirk-telemetry-"));
}

test("signed heartbeat is accepted, persisted and reported online", () => {
    let current = Date.parse("2026-07-31T08:00:00Z");
    const dataDir = temporaryDirectory();
    const store = telemetryFactory.create({ dataDir, now: () => current, onlineAfterMs: 180000 });
    const token = "portal-secret-token-value";
    const timestamp = current;
    const nonce = "nonce_1234567890abcdef";
    const rawBody = JSON.stringify({ portalVersion: "1.2.3", agentCount: 42, onlineAgents: 40, health: "ok" });
    const signature = telemetryFactory.sign(token, timestamp, nonce, rawBody);

    const accepted = store.accept({ id: "test-portal", name: "Test Portal" }, { token, timestamp, nonce, rawBody, signature });
    assert.equal(accepted.status, "online");
    assert.equal(accepted.metrics.portalVersion, "1.2.3");
    assert.equal(accepted.metrics.agentCount, 42);

    const reloaded = telemetryFactory.create({ dataDir, now: () => current, onlineAfterMs: 180000 });
    assert.equal(reloaded.get("test-portal").heartbeatCount, 1);
    current += 181000;
    assert.equal(reloaded.get("test-portal").status, "offline");
});

test("heartbeat rejects stale timestamps, bad signatures and nonce replay", () => {
    const current = Date.parse("2026-07-31T08:00:00Z");
    const store = telemetryFactory.create({ dataDir: temporaryDirectory(), now: () => current, maximumClockSkewMs: 300000 });
    const portal = { id: "test-portal", name: "Test Portal" };
    const token = "portal-secret-token-value";
    const rawBody = JSON.stringify({ health: "ok" });
    const nonce = "nonce_1234567890abcdef";
    const signature = telemetryFactory.sign(token, current, nonce, rawBody);

    store.accept(portal, { token, timestamp: current, nonce, rawBody, signature });
    assert.throws(() => store.accept(portal, { token, timestamp: current, nonce, rawBody, signature }), /already used/);
    assert.throws(() => store.accept(portal, { token, timestamp: current, nonce: "nonce_abcdef1234567890", rawBody, signature: "A".repeat(43) }), /signature is invalid/);
    const oldTimestamp = current - 301000;
    assert.throws(() => store.accept(portal, {
        token,
        timestamp: oldTimestamp,
        nonce: "nonce_old_1234567890ab",
        rawBody,
        signature: telemetryFactory.sign(token, oldTimestamp, "nonce_old_1234567890ab", rawBody)
    }), /outside the accepted window/);
});
