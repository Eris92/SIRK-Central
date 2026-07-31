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
function enableOpenPolicy(store, overrides = {}) {
    return store.setPolicy("portal-a", Object.assign({
        mode: "open",
        includeStatuses: [],
        includePriorities: [],
        includeDescription: true,
        includeRequester: true,
        allowCentralChanges: true
    }, overrides));
}

test("ticket projection persists filters and ignores stale source updates", () => {
    const dataDir = dir();
    const store = ticketStore.create({ dataDir, now: () => Date.parse("2026-07-31T10:02:00Z") });
    const created = store.upsert("portal-a", sample(), { assignment });
    assert.equal(created.portalId, "portal-a");
    assert.equal(created.tenantId, "tenant-a");
    assert.equal(created.customerId, "customer-a");
    assert.equal(store.list({ priority: "high", customerId: "customer-a" }).length, 1);
    assert.equal(store.list({ customerId: "other" }).length, 0);
    store.upsert("portal-a", sample({ status: "in_progress", updatedAtUtc: "2026-07-31T10:03:00Z" }), { assignment });
    assert.equal(store.get("portal-a", "tck-100").status, "in_progress");
    store.upsert("portal-a", sample({ status: "closed", updatedAtUtc: "2026-07-31T09:00:00Z" }), { assignment });
    assert.equal(store.get("portal-a", "tck-100").status, "in_progress");
    const reloaded = ticketStore.create({ dataDir });
    assert.equal(reloaded.get("portal-a", "tck-100").externalId, "IT-42");
});

test("same source timestamp with different content is rejected", () => {
    const store = ticketStore.create({ dataDir: dir() });
    store.upsert("portal-a", sample(), { assignment });
    assert.throws(
        () => store.upsert("portal-a", sample({ title: "Changed title" }), { assignment }),
        error => error && error.code === "TICKET_VERSION_CONFLICT" && error.statusCode === 409
    );
    assert.equal(store.upsert("portal-a", sample(), { assignment }).title, "Brak dostepu do ERP");
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

test("snapshot and events maintain summary SLA and strict idempotency", () => {
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
    assert.throws(() => store.snapshot("portal-a", Object.assign({}, snapshot, {
        tickets: [sample({ title: "Changed replay" })]
    }), { assignment }), error => error && error.code === "TICKET_SNAPSHOT_REPLAY_CONFLICT");

    const event = {
        eventId: "evt-100",
        type: "ticket.closed",
        occurredAtUtc: "2026-07-31T11:00:00Z",
        ticket: sample({ status: "closed", updatedAtUtc: "2026-07-31T11:00:00Z" })
    };
    const closed = store.event("portal-a", event, { assignment });
    assert.equal(closed.accepted, true);
    assert.equal(closed.removed, true);
    assert.equal(store.get("portal-a", "tck-100"), null);
    assert.equal(store.event("portal-a", event, { assignment }).duplicate, true);
    assert.throws(() => store.event("portal-a", Object.assign({}, event, {
        ticket: sample({ status: "cancelled", updatedAtUtc: "2026-07-31T11:00:00Z" })
    }), { assignment }), error => error && error.code === "TICKET_EVENT_REPLAY_CONFLICT");
    assert.throws(() => store.event("portal-a", { eventId: "evt-101", type: "ticket.deleted", ticket: sample() }, { assignment }), /Unsupported/);
});

test("full snapshots are transactional and remove absent projections", () => {
    const store = ticketStore.create({ dataDir: dir() });
    enableOpenPolicy(store);
    store.snapshot("portal-a", {
        generatedAtUtc: "2026-07-31T11:00:00Z",
        cursor: "full-1",
        full: true,
        tickets: [sample(), sample({ ticketId: "tck-101", title: "Other" })]
    }, { assignment });
    assert.equal(store.list().length, 2);
    const next = store.snapshot("portal-a", {
        generatedAtUtc: "2026-07-31T11:30:00Z",
        cursor: "full-2",
        full: true,
        tickets: [sample({ updatedAtUtc: "2026-07-31T11:20:00Z" })]
    }, { assignment });
    assert.equal(next.removed, 1);
    assert.equal(store.get("portal-a", "tck-101"), null);

    assert.throws(() => store.snapshot("portal-a", {
        generatedAtUtc: "2026-07-31T10:30:00Z",
        cursor: "older",
        full: true,
        tickets: []
    }, { assignment }), error => error && error.code === "TICKET_SNAPSHOT_STALE");
    assert.equal(store.get("portal-a", "tck-100").status, "new");
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

test("policy tightening purges or redacts already published projections", () => {
    const store = ticketStore.create({ dataDir: dir() });
    enableOpenPolicy(store);
    store.snapshot("portal-a", {
        generatedAtUtc: "2026-07-31T10:02:00Z",
        cursor: "policy-1",
        tickets: [sample(), sample({ ticketId: "tck-101", priority: "critical", title: "Critical" })]
    }, { assignment });

    const critical = store.setPolicy("portal-a", {
        mode: "critical",
        includeDescription: false,
        includeRequester: false,
        allowCentralChanges: false
    });
    assert.equal(critical.purgedProjections, 1);
    assert.ok(critical.redactedProjections >= 2);
    assert.equal(store.get("portal-a", "tck-100"), null);
    const remaining = store.get("portal-a", "tck-101");
    assert.equal(remaining.description, "");
    assert.equal(remaining.requester, null);

    const none = store.setPolicy("portal-a", { mode: "none" });
    assert.equal(none.purgedProjections, 1);
    assert.equal(store.list().length, 0);
});

test("Central changes preserve source ordering and publication policy is strict", () => {
    const dataDir = dir();
    const store = ticketStore.create({ dataDir });
    store.upsert("portal-a", sample(), { assignment });
    const actor = { identityKey: "tenant:user", username: "operator" };
    const changed = store.updateCentral("portal-a", "tck-100", { status: "accepted", centralOwner: "L2", note: "Podjeto" }, actor);
    assert.equal(changed.status, "accepted");
    assert.equal(changed.central.centralOwner, "L2");
    assert.equal(changed.central.requestedStatus, "accepted");
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
        includeStatuses: ["accepted", "in_progress"],
        includePriorities: ["high"],
        includeDescription: false,
        includeRequester: false,
        allowCentralChanges: true
    });
    assert.deepEqual(policy.includeStatuses, ["accepted", "in_progress"]);
    assert.equal(ticketStore.create({ dataDir }).getPolicy("portal-a").allowCentralChanges, true);
});

test("capacity is fail-closed and never evicts existing tickets", () => {
    const store = ticketStore.create({ dataDir: dir(), maxTickets: 100 });
    for (let index = 0; index < 100; index += 1) {
        store.upsert("portal-a", sample({
            ticketId: "tck-" + String(index).padStart(3, "0"),
            title: "Ticket " + index,
            updatedAtUtc: new Date(Date.parse("2026-07-31T10:01:00Z") + index * 1000).toISOString()
        }), { assignment });
    }
    assert.equal(store.list({ limit: 1000 }).length, 100);
    assert.throws(() => store.upsert("portal-a", sample({ ticketId: "tck-overflow", title: "Overflow" }), { assignment }), error => error && error.code === "TICKET_CAPACITY_REACHED" && error.statusCode === 507);
    assert.equal(store.list({ limit: 1000 }).length, 100);
});

test("store rejects invalid identifiers missing cursors event IDs statuses and oversized snapshots", () => {
    const store = ticketStore.create({ dataDir: dir() });
    enableOpenPolicy(store);
    assert.throws(() => store.upsert("../portal", sample()), /invalid/);
    assert.throws(() => store.upsert("portal-a", sample({ status: "todo" })), /Unsupported/);
    assert.throws(() => store.event("portal-a", { type: "ticket.updated", ticket: sample() }, { assignment }), /Event ID is invalid/);
    assert.throws(() => store.snapshot("portal-a", { generatedAtUtc: "2026-07-31T10:00:00Z", tickets: [] }, { assignment }), /Required ticket field/);
    assert.throws(() => store.snapshot("portal-a", { cursor: "large", tickets: new Array(5001).fill(sample()) }, { assignment }), /too large/);
});
