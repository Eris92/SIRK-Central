"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const approvalStore = require("../src/approval-store");
const { canDecide, executeApproved } = require("../src/server-v13");

function temporaryDirectory() { return fs.mkdtempSync(path.join(os.tmpdir(), "sirk-approval-")); }

const requester = { username: "requester", identityKey: "tenant:user-a", role: "Admin", builtIn: false };
const secAdmin = { username: "security", identityKey: "tenant:user-b", role: "SecAdmin", builtIn: false };
const breakGlass = { username: "admin", role: "BreakGlass", builtIn: true };

test("approval store enforces independent reviewers and persists execution", () => {
    const store = approvalStore.create({ dataDir: temporaryDirectory(), randomId: () => "apr-test" });
    const request = store.submit({
        type: "role.assignment",
        title: "Grant Admin",
        reason: "Production administration",
        requiredApprovals: 1,
        payload: { identityKey: "00000000-0000-0000-0000-000000000001:00000000-0000-0000-0000-000000000002", role: "Admin" }
    }, requester);
    assert.equal(request.state, "pending");
    assert.throws(() => store.decide(request.id, "approve", requester, "self"), /own request/i);
    const approved = store.decide(request.id, "approve", secAdmin, "approved");
    assert.equal(approved.state, "approved");
    const execution = store.markExecution(request.id, { state: "completed", change: { role: "Admin" } });
    assert.equal(execution.state, "completed");
    assert.equal(store.get(request.id).execution.change.role, "Admin");
    assert.deepEqual(store.markExecution(request.id, { state: "failed" }), execution);
});

test("privileged decisions require SecAdmin or BreakGlass and never the requester", () => {
    const request = { requestedBy: requester.identityKey, payload: { role: "Admin" } };
    assert.equal(canDecide(requester, request), false);
    assert.equal(canDecide({ username: "auditor", role: "Auditor" }, request), false);
    assert.equal(canDecide(secAdmin, request), true);
    assert.equal(canDecide(breakGlass, request), true);
});

test("approved role request executes exactly through user store", () => {
    const calls = [];
    const app = {
        userStore: { updateRole(identity, role, actor) { calls.push({ identity, role, actor }); return { source: identity.source, key: identity.key, role }; } },
        approvals: { markExecution(id, execution) { return Object.assign({ approvalId: id }, execution); } }
    };
    const request = {
        id: "apr-role", type: "role.assignment", state: "approved", requestedBy: requester.identityKey,
        payload: { identityKey: "00000000-0000-0000-0000-000000000001:00000000-0000-0000-0000-000000000002", role: "Admin" }
    };
    const execution = executeApproved(app, request, secAdmin);
    assert.equal(execution.state, "completed");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].identity.source, "entra");
    assert.equal(calls[0].role, "Admin");
});
