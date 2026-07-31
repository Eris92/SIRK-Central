"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const runtimeLock = require("../src/runtime-lock");

function dir() { return fs.mkdtempSync(path.join(os.tmpdir(), "sirk-runtime-lock-")); }

test("only one runtime may own a persistent data directory", () => {
    const dataDir = dir();
    const first = runtimeLock.acquire({ dataDir, instanceId: "first", heartbeatMs: 5000 });
    assert.equal(first.snapshot().instanceId, "first");

    assert.throws(
        () => runtimeLock.acquire({ dataDir, instanceId: "second", heartbeatMs: 5000 }),
        error => error && error.code === "RUNTIME_STORAGE_LOCKED" && error.owner.instanceId === "first"
    );

    assert.equal(first.release(), true);
    const second = runtimeLock.acquire({ dataDir, instanceId: "second", heartbeatMs: 5000 });
    assert.equal(second.snapshot().instanceId, "second");
    second.release();
});

test("stale runtime lock is quarantined and recovered", () => {
    const dataDir = dir();
    let timestamp = Date.parse("2026-07-31T12:00:00Z");
    const stale = runtimeLock.acquire({
        dataDir,
        instanceId: "stale",
        now: () => timestamp,
        staleMs: 30000,
        heartbeatMs: 5000
    });
    clearInterval();
    timestamp += 30001;

    const recovered = runtimeLock.acquire({
        dataDir,
        instanceId: "recovered",
        now: () => timestamp,
        staleMs: 30000,
        heartbeatMs: 5000
    });
    assert.equal(recovered.snapshot().instanceId, "recovered");
    assert.equal(stale.release(), false);
    recovered.release();
});

test("release does not remove a lock owned by another instance", () => {
    const dataDir = dir();
    const first = runtimeLock.acquire({ dataDir, instanceId: "first", heartbeatMs: 5000 });
    const owner = first.snapshot();
    owner.instanceId = "replacement";
    fs.writeFileSync(first.ownerPath, JSON.stringify(owner));

    assert.equal(first.release(), false);
    assert.equal(fs.existsSync(first.lockDir), true);
    fs.rmSync(first.lockDir, { recursive: true, force: true });
});
