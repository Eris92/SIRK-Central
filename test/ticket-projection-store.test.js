"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const ticketStore = require("../src/ticket-projection-store");

function dir() { return fs.mkdtempSync(path.join(os.tmpdir(), "sirk-ticket-")); }
function sample(overrides = {}) {
    return Object.assign({
        ticketId: "tck-100",
        title: "Brak dostepu do ERP",
        description: "Nie dziala logowanie",
        status: "new",
        priority: "high",
        externalSystem: "jira",
        externalId: "IT-42",
        createdAtUtc: "2026-07-31T10:00:00Z",
        updatedAtUtc: "2026-07-31T10:01:00Z",
        requester: { id: "u1", displayName: "Jan" },
        sla: { breached: false },
        sync: { state: "synchronized", lastSyncAtUtc: "2026-07-31T10:01:10Z" }
    }, overrides);
}
const assignment = { tenantId: "tenant-a", customerId: "customer-a", siteId: "site-a" };
function enableOpenPolicy(store) {
    return store.setPolicy("portal-a", {
        mode: "open",
        includeStatuses: [],
        includePriorities: [],
        includeDescription: true,
        includeRequester: true,
        allowCentralChanges: true
    });
}

test("ticket projection persists, filters and ignores stale source updates", () => {
    const dataDir = dir();
    const store = ticketStore.create({ dataDir, now: () => Date.parse("2026-07-31T10:02:00Z") });
    const created = store.upsert("portal-a", sample(), { assignment });
    assert.equal(created.portalId, "portal-a");
    assert.equal(created.tenantId, "tenant-a");
    assert.equal(store.list({ priority: "high" }).length, 1);
    store.upsert("portal-a", sample({ status: "in_progress", updatedAtUtc: "2026-07-31T10:03:00Z" }), { assignment });
    assert.equal(store.get("portal-a", "tck-100").status, "in_progress");
    store.upsert("portal-a", sample({ status: "closed", updatedAtUtc: "2026-07-31T09:00:00Z" }), { assignment });
    assert.equal(store.get("portal-a", "tck-100").status, "in_progress");
    const reloaded = ticketStore.create({ dataDir });
    assert.equal(reloaded.get("portal-a", "tck-100").externalId, "IT-42");
});

test("ticket publication defaults are private and read-only", () => {
    const store = ticketStore.create({ dataDir: dir() });
    assert.deepEqual(store.getPolicy("portal-a"), {
        mode: "none",
        includeStatuses: [],
        includePriorities: [],
        includeDescription: false,
        includeRequester: false,
        allowCentralChanges: false
    });
    const result = store.snapshot("portal-a", {
        generatedAtUtc: "2026-07-31T10:02:00Z",
        cursor: "private-1",
        tickets: [sample()]
    }, { assignment });
    assert.equal(result.accepted, 0);
    assert.equal(result.skipped, 1);
    assert.equal(store.list().length, 0);
});

test("snapshot and events maintain summary, SLA and idempotency", () => {
    const store = ticketStore.create({ dataDir: dir() });
    enableOpenPolicy(store);
    const snapshot = {
        generatedAtUtc: "2026-07-31T10:02:00Z",
        cursor: "c1",
        tickets: [
            sample(),
            sample({ ticketId: "tck-101", title: "Awaria", priority: "critical", sla: { breached: true } })
        ]
    };
    const result = store.snapshot("portal-a", snapshot, { assignment });
    assert.equal(result.accepted, 2);
    assert.equal(store.summary().critical, 1);
    assert.equal(store.summary().slaBreached, 1);
    assert.equal(store.snapshot("portal-a", snapshot, { assignment }).duplicate, true);

    const event = {
        eventId: "evt-100",
        type: "ticket.closed",
        occurredAtUtc: "2026-07-31T11:00:00Z",
        ticket: sample({ status: "closed", updatedAtUtc: "2026-07-31T11:00:00Z" })
    };
    assert.equal(store.event("portal-a", event, { assignment }).accepted, true);
    assert.equal(store.get("portal-a", "tck-100").status, "closed");
    assert.equal(store.event("portal-a", event, { assignment }).duplicate, true);
    assert.throws(() => store.event("portal-a", { eventId: "evt-101", type: "ticket.deleted", ticket: sample() }, { assignment }), /Unsupported/);
});

test("full snapshots cannot close tickets newer than the snapshot", () => {
    const store = ticketStore.create({ dataDir: dir() });
    enableOpenPolicy(store);
    store.snapshot("portal-a", {
        generatedAtUtc: "2026-07-31T11:00:00Z",
        cursor: "newer",
        tickets: [sample({ updatedAtUtc: "2026-07-31T10:59:00Z" })]
    }, { assignment });
    store.event("portal-a", {
        eventId: "evt-newer",
        type: "ticket.status_changed",
        occurredAtUtc: "2026-07-31T11:10:00Z",
        ticket: sample({ status: "in_progress", updatedAtUtc: "2026-07-31T11:10:00Z" })
    }, { assignment });

    assert.throws(() => store.snapshot("portal-a", {
        generatedAtUtc: "2026-07-31T10:30:00Z",
        cursor: "older",
        full: true,
        tickets: []
    }, { assignment }), error => error && error.code === "TICKET_SNAPSHOT_STALE");
    assert.equal(store.get("portal-a", "tck-100").status, "in_progress");
});

test("Portal scope is canonical and Portal cannot overwrite Central metadata", () => {
    const store = ticketStore.create({ dataDir: dir() });
    const created = store.upsert("portal-a", sample({
        tenantId: "tenant-a",
        customerId: "customer-a",
        siteId: "site-a",
        central: { lastChangedBy: "attacker", centralOwner: "root" }
    }), { assignment });
    assert.deepEqual(created.central, {});
    assert.throws(() => store.upsert("portal-a", sample({ tenantId: "tenant-b" }), { assignment }), error => error && error.code === "TICKET_SCOPE_MISMATCH");
});

test("Central changes preserve source ordering and publication policy is strict", () => {
    const dataDir = dir();
    const store = ticketStore.create({ dataDir });
    store.upsert("portal-a", sample(), { assignment });
    const actor = { identityKey: "tenant:user", username: "operator" };
    const changed = store.updateCentral("portal-a", "tck-100", { status: "accepted", centralOwner: "L2", note: "Podjeto" }, actor);
    assert.equal(changed.status, "accepted");
    assert.equal(changed.central.centralOwner, "L2");
    assert.equal(changed.sourceUpdatedAtUtc, "2026-07-31T10:01:00.000Z");
    assert.throws(() => store.updateCentral("portal-a", "tck-100", { status: "unknown" }, actor), /Unsupported/);
    assert.throws(() => store.updateCentral("portal-a", "tck-100", { ignored: true }, actor), error => error && error.code === "TICKET_CHANGE_EMPTY");

    assert.throws(() => store.setPolicy("portal-a", {
        mode: "selected",
        includeStatuses: ["new", "invalid"],
        includePriorities: ["critical"]
    }), error => error && error.code === "TICKET_POLICY_INVALID");

    const policy = store.setPolicy("portal-a", {
        mode: "selected",
        includeStatuses: ["new", "in_progress"],
        includePriorities: ["critical"],
        includeDescription: false,
        includeRequester: false,
        allowCentralChanges: true
    });
    assert.deepEqual(policy.includeStatuses, ["new", "in_progress"]);
    assert.equal(ticketStore.create({ dataDir }).getPolicy("portal-a").allowCentralChanges, true);
});

test("store rejects invalid identifiers, missing event IDs, statuses and oversized snapshots", () => {
    const store = ticketStore.create({ dataDir: dir() });
    enableOpenPolicy(store);
    assert.throws(() => store.upsert("../portal", sample()), /invalid/);
    assert.throws(() => store.upsert("portal-a", sample({ status: "todo" })), /Unsupported/);
    assert.throws(() => store.event("portal-a", { type: "ticket.updated", ticket: sample() }, { assignment }), /Event ID is invalid/);
    assert.throws(() => store.snapshot("portal-a", { tickets: new Array(5001).fill(sample()) }, { assignment }), /too large/);
});
