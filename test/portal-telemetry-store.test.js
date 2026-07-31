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
    const rawBody = JSON.stringify({
        protocolVersion: 1,
        portalVersion: "1.2.3",
        agentCount: 42,
        onlineAgents: 40,
        health: "ok",
        publicUrl: "https://portal.example.test/",
        lastBackupAtUtc: "2026-07-31T07:00:00Z"
    });
    const signature = telemetryFactory.sign(token, timestamp, nonce, rawBody);

    const accepted = store.accept({ id: "test-portal", name: "Test Portal" }, { token, timestamp, nonce, rawBody, signature });
    assert.equal(accepted.status, "online");
    assert.equal(accepted.metrics.portalVersion, "1.2.3");
    assert.equal(accepted.metrics.agentCount, 42);
    assert.equal(accepted.metrics.publicUrl, "https://portal.example.test/");
    assert.equal(accepted.metrics.lastBackupAtUtc, "2026-07-31T07:00:00.000Z");

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
    assert.throws(() => store.accept(portal, { token, timestamp: current, nonce, rawBody, signature }), error => error && error.code === "HEARTBEAT_REPLAY");
    assert.throws(() => store.accept(portal, { token, timestamp: current, nonce: "nonce_abcdef1234567890", rawBody, signature: "A".repeat(43) }), error => error && error.code === "HEARTBEAT_SIGNATURE_INVALID");
    const oldTimestamp = current - 301000;
    assert.throws(() => store.accept(portal, {
        token,
        timestamp: oldTimestamp,
        nonce: "nonce_old_1234567890ab",
        rawBody,
        signature: telemetryFactory.sign(token, oldTimestamp, "nonce_old_1234567890ab", rawBody)
    }), error => error && error.code === "HEARTBEAT_STALE");
});

test("replay cache never evicts a still-valid nonce", () => {
    const current = Date.parse("2026-07-31T08:00:00Z");
    const store = telemetryFactory.create({
        dataDir: temporaryDirectory(),
        now: () => current,
        maximumClockSkewMs: 300000,
        maxNoncesPerPortal: 100
    });
    const portal = { id: "test-portal", name: "Test Portal" };
    const token = "portal-secret-token-value";
    const rawBody = JSON.stringify({ health: "ok" });

    for (let index = 0; index < 100; index += 1) {
        const nonce = "nonce_" + String(index).padStart(16, "0");
        store.accept(portal, {
            token,
            timestamp: current,
            nonce,
            rawBody,
            signature: telemetryFactory.sign(token, current, nonce, rawBody)
        });
    }
    const overflowNonce = "nonce_overflow_123456";
    assert.throws(() => store.accept(portal, {
        token,
        timestamp: current,
        nonce: overflowNonce,
        rawBody,
        signature: telemetryFactory.sign(token, current, overflowNonce, rawBody)
    }), error => error && error.code === "HEARTBEAT_NONCE_CAPACITY" && error.statusCode === 429);

    const originalNonce = "nonce_0000000000000000";
    assert.throws(() => store.accept(portal, {
        token,
        timestamp: current,
        nonce: originalNonce,
        rawBody,
        signature: telemetryFactory.sign(token, current, originalNonce, rawBody)
    }), error => error && error.code === "HEARTBEAT_REPLAY");
});

test("telemetry normalization prevents impossible and unsafe values", () => {
    const metrics = telemetryFactory.normalizeHeartbeat({
        health: "unexpected",
        agentCount: 4,
        onlineAgents: 999,
        memoryTotalBytes: 100,
        memoryUsedBytes: 200,
        publicUrl: "http://user:pass@internal.example/",
        lastBackupAtUtc: "not-a-date",
        capabilities: ["tickets", "tickets", "commands"]
    });
    assert.equal(metrics.health, "warning");
    assert.equal(metrics.onlineAgents, 4);
    assert.equal(metrics.memoryUsedBytes, 100);
    assert.equal(metrics.publicUrl, "");
    assert.equal(metrics.lastBackupAtUtc, null);
    assert.deepEqual(metrics.capabilities, ["tickets", "commands"]);
});
