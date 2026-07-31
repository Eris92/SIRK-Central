"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const replayStore = require("../src/sso-replay-store");

function dir() { return fs.mkdtempSync(path.join(os.tmpdir(), "sirk-sso-replay-")); }

test("SSO JTI remains single-use after process restart", () => {
    const dataDir = dir();
    let timestamp = 1_700_000_000_000;
    const first = replayStore.create({ dataDir, now: () => timestamp });
    assert.equal(first.consume("jti_abcdefghijklmnopqrstuvwxyz", timestamp + 60_000), true);
    const second = replayStore.create({ dataDir, now: () => timestamp });
    assert.equal(second.consume("jti_abcdefghijklmnopqrstuvwxyz", timestamp + 60_000), false);
});

test("expired replay entries are removed before capacity checks", () => {
    const dataDir = dir();
    let timestamp = 1_700_000_000_000;
    const store = replayStore.create({ dataDir, now: () => timestamp, maxEntries: 100 });
    for (let index = 0; index < 100; index += 1) {
        assert.equal(store.consume("jti_" + String(index).padStart(20, "a"), timestamp + 1_000), true);
    }
    timestamp += 2_000;
    assert.equal(store.consume("jti_new_abcdefghijklmnop", timestamp + 60_000), true);
    assert.equal(Object.keys(store.list()).length, 1);
});

test("replay store rejects invalid identifiers and expiry windows", () => {
    const timestamp = 1_700_000_000_000;
    const store = replayStore.create({ dataDir: dir(), now: () => timestamp });
    assert.throws(() => store.consume("short", timestamp + 60_000), /JTI is invalid/i);
    assert.throws(() => store.consume("jti_abcdefghijklmnopqrstuvwxyz", timestamp - 1), /expiry is invalid/i);
    assert.throws(() => store.consume("jti_abcdefghijklmnopqrstuvwxyz", timestamp + 10 * 60_000), /expiry is invalid/i);
});
