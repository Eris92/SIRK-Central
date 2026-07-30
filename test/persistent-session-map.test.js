"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PersistentSessionMap, hashToken } = require("../src/persistent-session-map");

test("persistent session map stores only token hashes and survives restart", () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sirk-session-map-"));
    const token = "secret-session-token-1234567890";
    const store = new PersistentSessionMap({ dataDir, idleMinutes: 30, absoluteHours: 8 });

    store.set(token, {
        username: "admin",
        role: "BreakGlass",
        builtIn: true,
        createdAt: Date.now(),
        lastSeenAt: Date.now(),
        expiresAt: Date.now() + 3600000
    });

    const persisted = fs.readFileSync(path.join(dataDir, "sessions.json"), "utf8");
    assert.equal(persisted.includes(token), false);
    assert.equal(persisted.includes(hashToken(token)), true);
    assert.equal(store.get(token).username, "admin");

    const restarted = new PersistentSessionMap({ dataDir, idleMinutes: 30, absoluteHours: 8 });
    assert.equal(restarted.get(token).role, "BreakGlass");
    assert.equal(Array.from(restarted.entries())[0][0].length, 16);
});

test("persistent session map can revoke by public id and predicate", () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sirk-session-map-"));
    const store = new PersistentSessionMap({ dataDir });
    store.set("token-a", { username: "a", role: "BreakGlass", builtIn: true, expiresAt: Date.now() + 3600000 });
    store.set("token-b", { username: "b", role: "Admin", builtIn: false, expiresAt: Date.now() + 3600000 });

    const id = Array.from(store.entries()).find(([, value]) => value.username === "b")[0];
    assert.equal(store.delete(id), true);
    assert.equal(store.get("token-b"), undefined);
    assert.equal(store.revokeWhere(value => value.builtIn === true), 1);
    assert.equal(store.size, 0);
});
