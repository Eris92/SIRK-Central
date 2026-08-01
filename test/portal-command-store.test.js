"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const commandStore = require("../src/portal-command-store");
const { approvedOperation } = require("../src/modules/portal-commands");

function temporaryDirectory() { return fs.mkdtempSync(path.join(os.tmpdir(), "sirk-command-")); }
const actor = { username: "engineer", identityKey: "tenant:engineer", role: "EngineerL3" };

test("portal command lifecycle is persistent and idempotent", () => {
    let timestamp = Date.parse("2026-07-31T10:00:00Z");
    const dataDir = temporaryDirectory();
    const store = commandStore.create({ dataDir, now: () => timestamp, randomId: () => "cmd-test" });
    const queued = store.enqueue({ portalId: "tenant-site", type: "backup", payload: { mode: "full" } }, actor);
    assert.equal(queued.state, "queued");
    assert.equal(store.summary().counts.queued, 1);
    const delivered = store.deliver("tenant-site");
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].state, "delivered");
    const running = store.acknowledge("tenant-site", queued.id, { state: "running", progress: 30, message: "working" });
    assert.equal(running.progress, 30);
    const completed = store.acknowledge("tenant-site", queued.id, { state: "completed", result: { archive: "ok" } });
    assert.equal(completed.state, "completed");
    assert.equal(completed.progress, 100);
    assert.equal(store.acknowledge("tenant-site", queued.id, { state: "completed" }).state, "completed");
    assert.throws(() => store.acknowledge("tenant-site", queued.id, { state: "failed" }), /different terminal state/i);
    const reloaded = commandStore.create({ dataDir, now: () => timestamp });
    assert.equal(reloaded.get(queued.id).state, "completed");
});

test("command acknowledgement is rejected before delivery", () => {
    const store = commandStore.create({ dataDir: temporaryDirectory(), randomId: () => "cmd-order" });
    const queued = store.enqueue({ portalId: "tenant-site", type: "backup" }, actor);
    assert.throws(
        () => store.acknowledge("tenant-site", queued.id, { state: "running" }),
        error => error && error.code === "COMMAND_ACK_OUT_OF_ORDER" && error.statusCode === 409
    );
});

test("delivered commands are redelivered only after the delivery lease", () => {
    let timestamp = Date.parse("2026-07-31T10:00:00Z");
    const store = commandStore.create({
        dataDir: temporaryDirectory(),
        now: () => timestamp,
        randomId: () => "cmd-lease",
        deliveryLeaseMs: 60000
    });
    store.enqueue({ portalId: "tenant-site", type: "backup" }, actor);
    assert.equal(store.deliver("tenant-site").length, 1);
    assert.equal(store.deliver("tenant-site").length, 0);
    timestamp += 60001;
    const redelivered = store.deliver("tenant-site");
    assert.equal(redelivered.length, 1);
    assert.equal(redelivered[0].attempts, 2);
});

test("command payload redacts secrets and rejects prototype keys", () => {
    const store = commandStore.create({ dataDir: temporaryDirectory(), randomId: () => "cmd-redact" });
    const payload = JSON.parse('{"token":"secret","nested":{"password":"hidden","value":1},"__proto__":{"polluted":true}}');
    const command = store.enqueue({ portalId: "tenant-site", type: "sync", payload }, actor);
    assert.equal(command.payload.token, "[redacted]");
    assert.equal(command.payload.nested.password, "[redacted]");
    assert.equal(Object.prototype.polluted, undefined);
    assert.equal(Object.hasOwn(command.payload, "__proto__"), false);
    assert.throws(() => store.enqueue({ portalId: "tenant-site", type: "shell" }, actor), /Unsupported/);
});

test("expired and failed commands can be retried while active commands can be cancelled", () => {
    let timestamp = Date.parse("2026-07-31T10:00:00Z");
    let counter = 0;
    const store = commandStore.create({ dataDir: temporaryDirectory(), now: () => timestamp, randomId: () => "cmd-" + (++counter) });
    const queued = store.enqueue({ portalId: "tenant-site", type: "reconnect", ttlMinutes: 5 }, actor);
    assert.equal(store.cancel(queued.id, actor).state, "cancelled");
    const retried = store.retry(queued.id, actor, { ttlMinutes: 5 });
    assert.equal(retried.state, "queued");
    timestamp += 6 * 60 * 1000;
    store.expire();
    assert.equal(store.get(retried.id).state, "expired");
    assert.equal(store.retry(retried.id, actor).state, "queued");
});

test("retry never inherits the approval from a previous high-risk command", () => {
    let counter = 0;
    const store = commandStore.create({ dataDir: temporaryDirectory(), randomId: () => "cmd-risk-" + (++counter) });
    const source = store.enqueue({ portalId: "tenant-site", type: "restart", approvalId: "apr-old" }, actor);
    store.cancel(source.id, actor);

    const withoutApproval = store.retry(source.id, actor);
    assert.equal(withoutApproval.approvalId, "");
    store.cancel(withoutApproval.id, actor);

    const withFreshApproval = store.retry(withoutApproval.id, actor, { approvalId: "apr-new" });
    assert.equal(withFreshApproval.approvalId, "apr-new");
});

test("high-risk approval is exact-scope and single-use", () => {
    let request = {
        id: "apr-high-risk",
        type: "operation.high-risk",
        state: "approved",
        scope: { portalId: "tenant-site" },
        payload: { operation: "restart" },
        execution: null
    };
    const app = { approvals: { get: id => id === request.id ? structuredClone(request) : null } };
    assert.ok(approvedOperation(app, request.id, "tenant-site", "restart"));
    assert.equal(approvedOperation(app, request.id, "other-site", "restart"), null);
    assert.equal(approvedOperation(app, request.id, "tenant-site", "update"), null);
    request.execution = { state: "completed", commandId: "cmd-used" };
    assert.equal(approvedOperation(app, request.id, "tenant-site", "restart"), null);
});
