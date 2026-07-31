"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const sessionStore = require("../src/session-store");

function temporaryDirectory() {
    return fs.mkdtempSync(path.join(os.tmpdir(), "sirk-session-store-"));
}

test("session store persists only token hashes and restores active sessions", () => {
    const dataDir = temporaryDirectory();
    let timestamp = 1_700_000_000_000;
    const options = {
        dataDir,
        idleMinutes: 30,
        absoluteHours: 8,
        now: () => timestamp,
        randomToken: () => "A".repeat(43)
    };

    const first = sessionStore.create(options);
    const issued = first.issue({ username: "admin", source: "local", builtIn: true }, { ip: "127.0.0.1", userAgent: "test" });
    const persisted = fs.readFileSync(path.join(dataDir, "sessions.json"), "utf8");

    assert.equal(persisted.includes(issued.token), false);
    assert.equal(persisted.includes("tokenHash"), true);
    assert.equal(first.get(issued.token, false).username, "admin");

    const second = sessionStore.create(options);
    assert.equal(second.get(issued.token, false).username, "admin");
});

test("session store enforces idle and absolute expiration", () => {
    const dataDir = temporaryDirectory();
    let timestamp = 1_700_000_000_000;
    let sequence = 0;
    const store = sessionStore.create({
        dataDir,
        idleMinutes: 5,
        absoluteHours: 1,
        now: () => timestamp,
        randomToken: () => String(++sequence).padStart(43, "A")
    });

    const idleSession = store.issue({ username: "idle" }, {}).token;
    timestamp += 4 * 60_000;
    assert.equal(store.get(idleSession).username, "idle");
    timestamp += 4 * 60_000;
    assert.equal(store.get(idleSession, false).username, "idle");
    timestamp += 6 * 60_000;
    assert.equal(store.get(idleSession), null);

    timestamp = 1_700_000_000_000;
    const absoluteSession = store.issue({ username: "absolute" }, {}).token;
    for (let index = 0; index < 14; index += 1) {
        timestamp += 4 * 60_000;
        assert.equal(store.get(absoluteSession).username, "absolute");
    }
    timestamp += 5 * 60_000;
    assert.equal(store.get(absoluteSession), null);
});

test("session revocation uses public ids and supports identity-wide invalidation", () => {
    const dataDir = temporaryDirectory();
    let sequence = 0;
    const store = sessionStore.create({
        dataDir,
        randomToken: () => String(++sequence).padStart(43, "B")
    });

    const first = store.issue({ username: "one", identityKey: "tenant:user", builtIn: false }, {}).record;
    store.issue({ username: "two", identityKey: "tenant:user", builtIn: false }, {});
    store.issue({ username: "break", source: "local", builtIn: true }, {});

    assert.equal(store.revokeById(first.id), true);
    assert.equal(store.list().length, 2);
    assert.equal(store.revokeWhere(record => record.identityKey === "tenant:user"), 1);
    assert.equal(store.revokeWhere(record => record.builtIn === true), 1);
    assert.deepEqual(store.list(), []);
});
