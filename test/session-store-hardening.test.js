"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const sessionStore = require("../src/session-store");

function dir() { return fs.mkdtempSync(path.join(os.tmpdir(), "sirk-session-hardening-")); }

test("session touch persistence is throttled to prevent write amplification", () => {
    const dataDir = dir();
    let timestamp = 1_700_000_000_000;
    const store = sessionStore.create({ dataDir, now: () => timestamp, touchPersistIntervalMs: 60_000, randomToken: () => "A".repeat(43) });
    const token = store.issue({ username: "user", identityKey: "tenant:user" }, {}).token;
    const file = path.join(dataDir, "sessions.json");
    const initial = JSON.parse(fs.readFileSync(file, "utf8"));
    timestamp += 10_000;
    store.get(token, true);
    const throttled = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(throttled.sessions[sessionStore.tokenHash(token)].lastSeenAt, initial.sessions[sessionStore.tokenHash(token)].lastSeenAt);
    timestamp += 60_000;
    store.get(token, true);
    const persisted = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(persisted.sessions[sessionStore.tokenHash(token)].lastSeenAt, timestamp);
});

test("session store evicts oldest sessions per identity", () => {
    let sequence = 0;
    const store = sessionStore.create({ dataDir: dir(), maxSessionsPerIdentity: 2, randomToken: () => String(++sequence).padStart(43, "B") });
    store.issue({ username: "user", identityKey: "tenant:user" }, {});
    store.issue({ username: "user", identityKey: "tenant:user" }, {});
    store.issue({ username: "user", identityKey: "tenant:user" }, {});
    assert.equal(store.list().length, 2);
});

test("session store rejects invalid or repeatedly colliding tokens", () => {
    const invalid = sessionStore.create({ dataDir: dir(), randomToken: () => "short" });
    assert.throws(() => invalid.issue({ username: "user" }, {}), /invalid token/i);

    const token = "C".repeat(43);
    const collision = sessionStore.create({ dataDir: dir(), maxSessionsPerIdentity: 10, randomToken: () => token });
    collision.issue({ username: "one", identityKey: "one" }, {});
    assert.throws(() => collision.issue({ username: "two", identityKey: "two" }, {}), /unique session token/i);
});
