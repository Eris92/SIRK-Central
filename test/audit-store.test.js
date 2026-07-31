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

test("audit store persists chained events and redacts secrets", () => {
    const dataDir = temporaryDirectory();
    let timestamp = Date.parse("2026-07-31T08:00:00Z");
    const store = auditStoreFactory.create({ dataDir, now: () => timestamp });
    store.append({
        action: "identity_provider.updated",
        category: "identity",
        result: "success",
        actor: { username: "admin", role: "BreakGlass" },
        request: { ip: "127.0.0.1", userAgent: "test", method: "PUT", path: "/api/settings/identity-provider" },
        details: { tenant: "tenant", clientSecret: "must-not-persist", nested: { accessToken: "hidden" } }
    });
    timestamp += 1000;
    store.append({ action: "backup.created", category: "operations", result: "success", target: "backup.tar.gz" });

    const raw = fs.readFileSync(store.filePath, "utf8");
    assert.equal(raw.includes("must-not-persist"), false);
    assert.equal(raw.includes("hidden"), false);
    assert.equal(raw.includes("[redacted]"), true);
    assert.deepEqual(store.verify().ok, true);

    const reopened = auditStoreFactory.create({ dataDir, now: () => timestamp });
    const events = reopened.list({ limit: 10 });
    assert.equal(events.length, 2);
    assert.equal(events[0].action, "backup.created");
    assert.equal(events[1].actor.username, "admin");
});

test("audit store detects tampering", () => {
    const dataDir = temporaryDirectory();
    const store = auditStoreFactory.create({ dataDir });
    store.append({ action: "session.logout", category: "authentication", result: "success" });
    const state = JSON.parse(fs.readFileSync(store.filePath, "utf8"));
    state.events[0].action = "tampered";
    fs.writeFileSync(store.filePath, JSON.stringify(state));

    const reopened = auditStoreFactory.create({ dataDir });
    const verification = reopened.verify();
    assert.equal(verification.ok, false);
    assert.equal(verification.reason, "event-hash-mismatch");
});

test("audit filters by category result and query", () => {
    const dataDir = temporaryDirectory();
    const store = auditStoreFactory.create({ dataDir });
    store.append({ action: "backup.created", category: "operations", result: "success", actor: { username: "admin" } });
    store.append({ action: "update.run", category: "operations", result: "denied", actor: { username: "auditor" } });
    store.append({ action: "session.logout", category: "authentication", result: "success", actor: { username: "admin" } });

    assert.equal(store.list({ category: "operations" }).length, 2);
    assert.equal(store.list({ result: "denied" }).length, 1);
    assert.equal(store.list({ query: "auditor" })[0].action, "update.run");
});
