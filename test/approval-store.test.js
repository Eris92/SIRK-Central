"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const approvalStore = require("../src/approval-store");

test("approval center enforces separation of duties and multi-approval", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sirk-approval-"));
    let now = Date.parse("2026-07-30T16:00:00Z");
    let counter = 0;
    const store = approvalStore.create({ dataDir: dir, now: () => now, randomId: () => "apr-" + (++counter) });
    const request = store.submit({
        type: "operation.high-risk",
        title: "Restart production connector",
        reason: "Required after configuration change",
        requiredApprovals: 2,
        payload: { portalId: "portal-1" }
    }, { identityKey: "entra:requester" });

    assert.equal(request.state, "pending");
    assert.throws(() => store.decide(request.id, "approve", { identityKey: "entra:requester" }), /own request/);
    assert.equal(store.decide(request.id, "approve", { identityKey: "entra:reviewer-1" }).state, "pending");
    const completed = store.decide(request.id, "approve", { identityKey: "entra:reviewer-2" });
    assert.equal(completed.state, "approved");
    assert.equal(completed.decisions.length, 2);

    const reopened = approvalStore.create({ dataDir: dir, now: () => now });
    assert.equal(reopened.get(request.id).state, "approved");
});

test("approval requests expire and requester may cancel only pending requests", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sirk-approval-expire-"));
    let now = Date.parse("2026-07-30T16:00:00Z");
    const store = approvalStore.create({ dataDir: dir, now: () => now, randomId: () => "apr-expire" });
    const request = store.submit({ type: "tenant.activation", title: "Activate tenant", reason: "Onboarding complete", ttlMinutes: 5 }, { username: "admin" });
    assert.throws(() => store.cancel(request.id, { username: "other" }), /Only the requester/);
    now += 6 * 60000;
    assert.equal(store.get(request.id).state, "expired");
    assert.throws(() => store.cancel(request.id, { username: "admin" }), /no longer pending/);
});
