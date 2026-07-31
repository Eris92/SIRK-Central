"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const ticketStore = require("../src/ticket-projection-store");

function dir() { return fs.mkdtempSync(path.join(os.tmpdir(), "sirk-ticket-")); }
function sample(overrides = {}) {
    return Object.assign({ ticketId: "tck-100", title: "Brak dostepu do ERP", description: "Nie dziala logowanie", status: "new", priority: "high", externalSystem: "jira", externalId: "IT-42", createdAtUtc: "2026-07-31T10:00:00Z", updatedAtUtc: "2026-07-31T10:01:00Z", requester: { id: "u1", displayName: "Jan" }, sla: { breached: false }, sync: { state: "synchronized", lastSyncAtUtc: "2026-07-31T10:01:10Z" } }, overrides);
}

test("ticket projection persists, filters and ignores stale updates", () => {
    const dataDir = dir();
    const store = ticketStore.create({ dataDir, now: () => Date.parse("2026-07-31T10:02:00Z") });
    const created = store.upsert("portal-a", sample());
    assert.equal(created.portalId, "portal-a");
    assert.equal(store.list({ priority: "high" }).length, 1);
    store.upsert("portal-a", sample({ status: "in_progress", updatedAtUtc: "2026-07-31T10:03:00Z" }));
    assert.equal(store.get("portal-a", "tck-100").status, "in_progress");
    store.upsert("portal-a", sample({ status: "closed", updatedAtUtc: "2026-07-31T09:00:00Z" }));
    assert.equal(store.get("portal-a", "tck-100").status, "in_progress");
    const reloaded = ticketStore.create({ dataDir });
    assert.equal(reloaded.get("portal-a", "tck-100").externalId, "IT-42");
});

test("snapshot and events maintain summary and SLA state", () => {
    const store = ticketStore.create({ dataDir: dir() });
    const result = store.snapshot("portal-a", { cursor: "c1", tickets: [sample(), sample({ ticketId: "tck-101", title: "Awaria", priority: "critical", sla: { breached: true } })] });
    assert.equal(result.accepted, 2);
    assert.equal(store.summary().critical, 1);
    assert.equal(store.summary().slaBreached, 1);
    store.event("portal-a", { type: "ticket.closed", ticket: sample({ status: "closed", updatedAtUtc: "2026-07-31T11:00:00Z" }) });
    assert.equal(store.get("portal-a", "tck-100").status, "closed");
    assert.throws(() => store.event("portal-a", { type: "ticket.deleted", ticket: sample() }), /Unsupported/);
});

test("Central changes obey normalized fields and publication policy is persistent", () => {
    const dataDir = dir();
    const store = ticketStore.create({ dataDir });
    store.upsert("portal-a", sample());
    const actor = { identityKey: "tenant:user", username: "operator" };
    const changed = store.updateCentral("portal-a", "tck-100", { status: "accepted", centralOwner: "L2", note: "Podjeto" }, actor);
    assert.equal(changed.status, "accepted");
    assert.equal(changed.central.centralOwner, "L2");
    assert.throws(() => store.updateCentral("portal-a", "tck-100", { status: "unknown" }, actor), /Unsupported/);
    const policy = store.setPolicy("portal-a", { mode: "selected", includeStatuses: ["new", "in_progress", "invalid"], includePriorities: ["critical"], includeDescription: false, allowCentralChanges: true });
    assert.deepEqual(policy.includeStatuses, ["new", "in_progress"]);
    assert.equal(ticketStore.create({ dataDir }).getPolicy("portal-a").allowCentralChanges, true);
});

test("store rejects invalid identifiers, statuses and oversized snapshots", () => {
    const store = ticketStore.create({ dataDir: dir() });
    assert.throws(() => store.upsert("../portal", sample()), /invalid/);
    assert.throws(() => store.upsert("portal-a", sample({ status: "todo" })), /Unsupported/);
    assert.throws(() => store.snapshot("portal-a", { tickets: new Array(5001).fill(sample()) }), /too large/);
});
