"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const userStore = require("../src/user-store");
const rbac = require("../src/rbac");

function temporaryStore() {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sirk-users-"));
    return { dataDir, store: userStore.create({ dataDir }) };
}

const breakGlass = { builtIn: true, role: "BreakGlass", status: "active", source: "local", username: "admin" };
const secAdmin = { builtIn: false, role: "SecAdmin", status: "active", source: "entra", identityKey: "tenant:secadmin" };
const admin = { builtIn: false, role: "Admin", status: "active", source: "entra", identityKey: "tenant:admin" };

test("account accepts exactly one supported role", () => {
    for (const role of rbac.ASSIGNABLE_ROLES) assert.equal(rbac.normalizeRole(role), role);
    assert.throws(() => rbac.normalizeRole(["Admin", "SecAdmin"]), /Unsupported role/);
    assert.throws(() => rbac.normalizeRole("Admin,SecAdmin"), /Unsupported role/);
});

test("Admin cannot create or promote a SecAdmin", () => {
    const { store } = temporaryStore();
    assert.throws(() => store.createLocalUser({
        username: "security.admin",
        password: "Correct-Horse-Battery-123",
        role: "SecAdmin"
    }, admin), /not allowed/);
});

test("SecAdmin and Break-Glass can create SecAdmin accounts", () => {
    for (const actor of [secAdmin, breakGlass]) {
        const { store } = temporaryStore();
        const created = store.createLocalUser({
            username: "security.admin",
            password: "Correct-Horse-Battery-123",
            role: "SecAdmin"
        }, actor);
        assert.equal(created.role, "SecAdmin");
        assert.equal(store.listUsers()[0].role, "SecAdmin");
    }
});

test("new privileged Entra identities require an App Role claim and approval", () => {
    const { store } = temporaryStore();
    const identityKey = "11111111-1111-1111-1111-111111111111:22222222-2222-2222-2222-222222222222";
    const pending = store.resolveEntra(identityKey, { username: "admin@example.test", displayName: "Test Admin" }, ["SecAdmin"]);
    assert.equal(pending.status, "pending");
    assert.equal(pending.role, null);
    assert.equal(pending.requestedRole, "SecAdmin");
    assert.equal(store.approveEntraRole(identityKey, breakGlass).role, "SecAdmin");
    assert.equal(store.resolveEntra(identityKey, {}, ["SecAdmin"]).role, "SecAdmin");
    assert.throws(() => store.updateRole({ source: "entra", key: identityKey }, "Auditor", breakGlass), /managed by application role claims/i);
});

test("support-line permissions are cumulative by operational level", () => {
    assert.equal(rbac.hasPermission({ role: "OperatorL1" }, "operations.l1"), true);
    assert.equal(rbac.hasPermission({ role: "OperatorL1" }, "operations.l2"), false);
    assert.equal(rbac.hasPermission({ role: "SupportL2" }, "operations.l2"), true);
    assert.equal(rbac.hasPermission({ role: "EngineerL3" }, "operations.l3"), true);
    assert.deepEqual(rbac.permissionsFor(null, false), []);
});
