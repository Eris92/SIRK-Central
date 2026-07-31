"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const transactionStore = require("../src/login-transaction-store");

function tempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), "sirk-login-transaction-"));
}

const identity = {
    username: "admin",
    identityKey: "breakglass:admin",
    source: "local",
    role: "BreakGlass",
    builtIn: true
};

test("MFA login transaction survives restart and is one-time", () => {
    const dir = tempDir();
    let timestamp = 1_000_000;
    const context = { ip: "192.0.2.10", userAgent: "test-browser" };
    const first = transactionStore.create({ dataDir: dir, now: () => timestamp });
    const issued = first.issue(identity, context);

    const persisted = fs.readFileSync(first.filePath, "utf8");
    assert.equal(persisted.includes(issued.token), false);

    const restarted = transactionStore.create({ dataDir: dir, now: () => timestamp });
    const consumed = restarted.consume(issued.token, context);
    assert.equal(consumed.identityKey, identity.identityKey);
    assert.equal(restarted.consume(issued.token, context), null);
});

test("MFA login transaction is bound to IP and user agent", () => {
    const dir = tempDir();
    const store = transactionStore.create({ dataDir: dir });
    const issued = store.issue(identity, { ip: "192.0.2.20", userAgent: "expected" });

    assert.equal(store.consume(issued.token, { ip: "192.0.2.21", userAgent: "expected" }), null);
});

test("MFA login transaction expires", () => {
    const dir = tempDir();
    let timestamp = 2_000_000;
    const store = transactionStore.create({ dataDir: dir, now: () => timestamp, lifetimeMs: 60_000 });
    const context = { ip: "192.0.2.30", userAgent: "browser" };
    const issued = store.issue(identity, context);
    timestamp += 60_001;
    assert.equal(store.consume(issued.token, context), null);
});
