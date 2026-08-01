"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const auditStoreFactory = require("../src/audit-store");

function temporaryDirectory() {
    return fs.mkdtempSync(path.join(os.tmpdir(), "sirk-audit-"));
}

test("audit store persists chained events redacts secrets and strips query strings", () => {
    const dataDir = temporaryDirectory();
    let timestamp = Date.parse("2026-07-31T08:00:00Z");
    const store = auditStoreFactory.create({ dataDir, now: () => timestamp, integrityKey: "K".repeat(64) });
    store.append({
        action: "identity_provider.updated",
        category: "identity",
        result: "success",
        actor: { username: "admin", role: "BreakGlass" },
        request: { ip: "127.0.0.1", userAgent: "test", method: "PUT", path: "/api/settings/identity-provider?ticket=must-not-persist" },
        details: { tenant: "tenant", clientSecret: "must-not-persist", nested: { accessToken: "hidden", recoveryCode: "one-time" } }
    });
    timestamp += 1000;
    store.append({ action: "backup.created", category: "operations", result: "success", target: "backup.tar.gz" });

    const raw = fs.readFileSync(store.filePath, "utf8");
    assert.equal(raw.includes("must-not-persist"), false);
    assert.equal(raw.includes("hidden"), false);
    assert.equal(raw.includes("one-time"), false);
    assert.equal(raw.includes("[redacted]"), true);
    assert.equal(store.verify().ok, true);
    assert.equal(store.verify().algorithm, "hmac-sha256");

    const reopened = auditStoreFactory.create({ dataDir, now: () => timestamp, integrityKey: "K".repeat(64) });
    const events = reopened.list({ limit: 10 });
    assert.equal(events.length, 2);
    assert.equal(events[0].action, "backup.created");
    assert.equal(events[1].actor.username, "admin");
    assert.equal(events[1].request.path, "/api/settings/identity-provider");
});

test("audit store detects tampering and refuses to append to a damaged chain", () => {
    const dataDir = temporaryDirectory();
    const store = auditStoreFactory.create({ dataDir, integrityKey: "K".repeat(64) });
    store.append({ action: "session.logout", category: "authentication", result: "success" });
    const state = JSON.parse(fs.readFileSync(store.filePath, "utf8"));
    state.events[0].action = "tampered";
    fs.writeFileSync(store.filePath, JSON.stringify(state));

    const reopened = auditStoreFactory.create({ dataDir, integrityKey: "K".repeat(64) });
    const verification = reopened.verify();
    assert.equal(verification.ok, false);
    assert.equal(verification.reason, "event-hash-mismatch");
    assert.throws(() => reopened.append({ action: "cover-up" }), /integrity verification failed/i);
});

test("audit HMAC key rotation or loss is detected", () => {
    const dataDir = temporaryDirectory();
    const store = auditStoreFactory.create({ dataDir, integrityKey: "A".repeat(64) });
    store.append({ action: "security.event", result: "success" });
    assert.equal(auditStoreFactory.create({ dataDir, integrityKey: "A".repeat(64) }).verify().ok, true);
    const wrong = auditStoreFactory.create({ dataDir, integrityKey: "B".repeat(64) }).verify();
    assert.equal(wrong.ok, false);
    assert.equal(wrong.reason, "event-hash-mismatch");
    assert.throws(
        () => auditStoreFactory.create({ dataDir, integrityKey: "" }),
        /SIRK_AUDIT_INTEGRITY_KEY is required/
    );
});

test("audit retention preserves a verifiable anchor chain", () => {
    const dataDir = temporaryDirectory();
    const store = auditStoreFactory.create({ dataDir, maxEvents: 100, integrityKey: "R".repeat(64) });
    for (let index = 0; index < 125; index += 1) {
        store.append({ action: "event." + index, category: "test", result: "info" });
    }
    const verification = store.verify();
    assert.equal(verification.ok, true);
    assert.equal(verification.count, 100);
    assert.notEqual(verification.anchorHash, "");
    assert.equal(store.list({ limit: 500 }).at(-1).action, "event.25");
    const persisted = JSON.parse(fs.readFileSync(store.filePath, "utf8"));
    assert.equal(persisted.events[0].previousHash, persisted.anchorHash);
});

test("legacy audit schema is rejected without automatic migration", () => {
    const dataDir = temporaryDirectory();
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, "audit-events.json"), JSON.stringify({
        version: 1,
        algorithm: "sha256",
        anchorHash: "",
        events: []
    }));
    const store = auditStoreFactory.create({ dataDir, integrityKey: "M".repeat(64) });
    const verification = store.verify();
    assert.equal(verification.ok, false);
    assert.equal(verification.reason, "unsupported-schema");
    assert.throws(() => store.append({ action: "must-not-migrate" }), /integrity verification failed/i);
});

test("audit filters by category result and query", () => {
    const dataDir = temporaryDirectory();
    const store = auditStoreFactory.create({ dataDir, integrityKey: "F".repeat(64) });
    store.append({ action: "backup.created", category: "operations", result: "success", actor: { username: "admin" } });
    store.append({ action: "update.run", category: "operations", result: "denied", actor: { username: "auditor" } });
    store.append({ action: "session.logout", category: "authentication", result: "success", actor: { username: "admin" } });

    assert.equal(store.list({ category: "operations" }).length, 2);
    assert.equal(store.list({ result: "denied" }).length, 1);
    assert.equal(store.list({ query: "auditor" })[0].action, "update.run");
});
