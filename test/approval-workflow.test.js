"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const approvalStore = require("../src/approval-store");
const { canDecide, executeApproved } = require("../src/modules/approvals");
const { approvedOperation } = require("../src/modules/portal-commands");

function temporaryDirectory() { return fs.mkdtempSync(path.join(os.tmpdir(), "sirk-approval-")); }

const requester = { username: "requester", identityKey: "tenant:user-a", role: "Admin", source: "entra", status: "active", builtIn: false };
const secAdmin = { username: "security", identityKey: "tenant:user-b", role: "SecAdmin", source: "entra", status: "active", builtIn: false };
const breakGlass = { username: "admin", identityKey: "breakglass:admin", role: "BreakGlass", source: "local", status: "active", builtIn: true };

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
    const approved = store.decide(request.id, "approve", breakGlass, "approved");
    assert.equal(approved.state, "approved");
    const execution = store.markExecution(request.id, { state: "completed", change: { role: "Admin" } });
    assert.equal(execution.state, "completed");
    assert.equal(store.get(request.id).execution.change.role, "Admin");
    assert.deepEqual(store.markExecution(request.id, { state: "failed" }), execution);
});

test("privileged role decisions preserve Admin and SecAdmin separation", () => {
    const adminRequest = { type: "role.assignment", requestedBy: requester.identityKey, payload: { role: "Admin" } };
    const secAdminRequest = { type: "role.assignment", requestedBy: requester.identityKey, payload: { role: "SecAdmin" } };
    const operationRequest = { type: "operation.high-risk", requestedBy: requester.identityKey, payload: { operation: "restart" } };
    assert.equal(canDecide(requester, adminRequest), false);
    assert.equal(canDecide({ username: "auditor", role: "Auditor", source: "entra", status: "active" }, adminRequest), false);
    assert.equal(canDecide(secAdmin, adminRequest), false);
    assert.equal(canDecide(breakGlass, adminRequest), true);
    assert.equal(canDecide(secAdmin, secAdminRequest), true);
    assert.equal(canDecide(secAdmin, operationRequest), true);
    assert.equal(canDecide(secAdmin, Object.assign({}, secAdminRequest, { requestedBy: secAdmin.identityKey })), false);
});

test("approved Admin role request executes only through BreakGlass", () => {
    const calls = [];
    const app = {
        userStore: { updateRole(identity, role, actor) { calls.push({ identity, role, actor }); return { source: identity.source, key: identity.key, role }; } },
        approvals: { markExecution(id, execution) { return Object.assign({ approvalId: id }, execution); } }
    };
    const request = {
        id: "apr-role", type: "role.assignment", state: "approved", requestedBy: requester.identityKey,
        payload: { identityKey: "00000000-0000-0000-0000-000000000001:00000000-0000-0000-0000-000000000002", role: "Admin" }
    };
    assert.throws(() => executeApproved(app, request, secAdmin), /not permitted/i);
    const execution = executeApproved(app, request, breakGlass);
    assert.equal(execution.state, "completed");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].identity.source, "entra");
    assert.equal(calls[0].role, "Admin");
});

test("high-risk approval remains unused until the command subsystem consumes it", () => {
    const store = approvalStore.create({ dataDir: temporaryDirectory(), randomId: () => "apr-high-risk" });
    const submitted = store.submit({
        type: "operation.high-risk",
        title: "Restart Portal",
        reason: "Controlled maintenance",
        payload: { portalId: "portal-one", operation: "restart" },
        scope: { portalId: "portal-one" }
    }, requester);
    const approved = store.decide(submitted.id, "approve", secAdmin, "approved");
    const authorization = executeApproved({ approvals: store }, approved, secAdmin);

    assert.equal(authorization.executed, false);
    assert.equal(authorization.state, "authorized");
    assert.equal(store.get(submitted.id).execution, null);

    const match = approvedOperation({ approvals: store }, submitted.id, "portal-one", "restart");
    assert.ok(match);
    assert.equal(match.required, true);

    store.markExecution(submitted.id, { state: "completed", commandId: "cmd-one" });
    assert.equal(approvedOperation({ approvals: store }, submitted.id, "portal-one", "restart"), null);
});
