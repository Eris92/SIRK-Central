"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const transaction = require("../updater/restore-transaction");

function harness(overrides = {}) {
    const calls = [];
    const statuses = [];
    let tick = 0;
    return {
        calls,
        statuses,
        options: Object.assign({
            backupName: "target.tar.gz",
            safetyBackupName: "safety.tar.gz",
            targetArchive: "/target",
            safetyArchive: "/safety",
            now: () => "2026-07-31T12:00:0" + tick++ + "Z",
            writeStatus: value => statuses.push(value),
            stopServices: () => calls.push("stop"),
            startServices: () => calls.push("start"),
            waitHealthy: () => calls.push("healthy"),
            replaceData: archive => calls.push("replace:" + archive)
        }, overrides)
    };
}

test("restore completes only after services become healthy", () => {
    const item = harness();
    const result = transaction.run(item.options);
    assert.equal(result.state, "completed");
    assert.deepEqual(item.calls, ["stop", "replace:/target", "start", "healthy"]);
    assert.equal(item.statuses.at(-1).running, false);
});

test("failed target extraction restores safety backup automatically", () => {
    const item = harness({
        replaceData: archive => {
            item.calls.push("replace:" + archive);
            if (archive === "/target") throw new Error("target damaged");
        }
    });
    const result = transaction.run(item.options);
    assert.equal(result.state, "rolled_back");
    assert.deepEqual(item.calls, ["stop", "replace:/target", "replace:/safety", "start", "healthy"]);
    assert.match(result.error, /target damaged/);
});

test("failed health check rolls back target data", () => {
    let healthChecks = 0;
    const item = harness({
        waitHealthy: () => {
            item.calls.push("healthy");
            healthChecks += 1;
            if (healthChecks === 1) throw new Error("central unhealthy");
        }
    });
    const result = transaction.run(item.options);
    assert.equal(result.state, "rolled_back");
    assert.deepEqual(item.calls, ["stop", "replace:/target", "start", "healthy", "stop", "replace:/safety", "start", "healthy"]);
});

test("rollback failure is retained as a blocking state", () => {
    const item = harness({
        replaceData: archive => {
            item.calls.push("replace:" + archive);
            throw new Error(archive === "/target" ? "target error" : "safety error");
        }
    });
    const result = transaction.run(item.options);
    assert.equal(result.state, "rollback_failed");
    assert.match(result.error, /target error/);
    assert.match(result.rollbackError, /safety error/);
});
