"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const storeFactory = require("../src/portal-command-store");

function dataDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), "sirk-command-cancel-"));
}

function actor(name = "admin") {
    return { identityKey: "local:" + name, username: name };
}

test("queued command is cancelled immediately and is never delivered", () => {
    let timestamp = Date.parse("2026-07-31T12:00:00Z");
    const store = storeFactory.create({ dataDir: dataDir(), now: () => timestamp, randomId: () => "cmd-queued" });
    const command = store.enqueue({ portalId: "portal-a", type: "backup" }, actor());
    const cancelled = store.cancel(command.id, actor("operator"));

    assert.equal(cancelled.state, "cancelled");
    assert.equal(cancelled.cancelledBy, "local:operator");
    assert.deepEqual(store.deliver("portal-a"), []);
});

test("delivered command uses cooperative cancellation and Portal acknowledges cancelled", () => {
    let timestamp = Date.parse("2026-07-31T12:00:00Z");
    const store = storeFactory.create({
        dataDir: dataDir(),
        now: () => timestamp,
        randomId: () => "cmd-cooperative",
        cancellationLeaseMs: 5000
    });
    const command = store.enqueue({ portalId: "portal-a", type: "sync" }, actor());
    assert.equal(store.deliver("portal-a")[0].state, "delivered");

    const requested = store.cancel(command.id, actor("operator"));
    assert.equal(requested.state, "cancel_requested");
    assert.equal(requested.cancelRequestedBy, "local:operator");

    const control = store.deliver("portal-a");
    assert.equal(control.length, 1);
    assert.equal(control[0].id, command.id);
    assert.equal(control[0].state, "cancel_requested");
    assert.equal(control[0].control, "cancel");

    assert.deepEqual(store.deliver("portal-a"), []);
    timestamp += 5001;
    assert.equal(store.deliver("portal-a")[0].control, "cancel");

    const runningRace = store.acknowledge("portal-a", command.id, { state: "running", progress: 55, message: "Stopping" });
    assert.equal(runningRace.state, "cancel_requested");
    assert.equal(runningRace.progress, 55);

    const cancelled = store.acknowledge("portal-a", command.id, { state: "cancelled", progress: 55, result: { stopped: true } });
    assert.equal(cancelled.state, "cancelled");
    assert.equal(cancelled.result.stopped, true);
    assert.equal(store.acknowledge("portal-a", command.id, { state: "cancelled" }).state, "cancelled");
});

test("completion or failure may win a cancellation race", () => {
    let sequence = 0;
    const ids = ["cmd-complete-race", "cmd-fail-race"];
    const store = storeFactory.create({ dataDir: dataDir(), randomId: () => ids[sequence++] });

    const completed = store.enqueue({ portalId: "portal-a", type: "backup" }, actor());
    store.deliver("portal-a");
    store.cancel(completed.id, actor());
    assert.equal(store.acknowledge("portal-a", completed.id, { state: "completed", progress: 100 }).state, "completed");

    const failed = store.enqueue({ portalId: "portal-a", type: "backup" }, actor());
    store.deliver("portal-a");
    store.cancel(failed.id, actor());
    assert.equal(store.acknowledge("portal-a", failed.id, { state: "failed", message: "Cannot stop safely" }).state, "failed");
});

test("Portal cannot self-cancel and terminal commands reject Central cancellation", () => {
    const store = storeFactory.create({ dataDir: dataDir(), randomId: () => "cmd-guard" });
    const command = store.enqueue({ portalId: "portal-a", type: "backup" }, actor());
    store.deliver("portal-a");

    assert.throws(
        () => store.acknowledge("portal-a", command.id, { state: "cancelled" }),
        error => error && error.code === "COMMAND_CANCEL_NOT_REQUESTED" && error.statusCode === 409
    );
    store.acknowledge("portal-a", command.id, { state: "completed", progress: 100 });
    assert.throws(
        () => store.cancel(command.id, actor()),
        error => error && error.code === "COMMAND_CANCEL_INVALID" && error.statusCode === 409
    );
});

test("summary treats cancellation requests as active", () => {
    const store = storeFactory.create({ dataDir: dataDir(), randomId: () => "cmd-summary" });
    const command = store.enqueue({ portalId: "portal-a", type: "sync" }, actor());
    store.deliver("portal-a");
    store.cancel(command.id, actor());

    const summary = store.summary({ portalId: "portal-a" });
    assert.equal(summary.counts.cancel_requested, 1);
    assert.equal(summary.active, 1);
});
