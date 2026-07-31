"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const userStoreFactory = require("../src/user-store");

const tenant = "00000000-0000-0000-0000-000000000001";
const adminKey = tenant + ":00000000-0000-0000-0000-000000000010";
const secAdminKey = tenant + ":00000000-0000-0000-0000-000000000011";
const reviewerKey = tenant + ":00000000-0000-0000-0000-000000000012";

function dir() { return fs.mkdtempSync(path.join(os.tmpdir(), "sirk-user-boundary-")); }

const reviewer = { username: "security", identityKey: reviewerKey, role: "SecAdmin", source: "entra", status: "active", builtIn: false };
const selfReviewer = { username: "self", identityKey: secAdminKey, role: "SecAdmin", source: "entra", status: "active", builtIn: false };
const breakGlass = { username: "admin", identityKey: "breakglass:admin", role: "BreakGlass", source: "local", status: "active", builtIn: true };

test("pending Admin Entra role can only be approved by BreakGlass", () => {
    const store = userStoreFactory.create({ dataDir: dir() });
    const pending = store.resolveEntra(adminKey, { username: "future-admin", displayName: "Future Admin" }, ["Admin"]);
    assert.equal(pending.status, "pending");
    assert.equal(pending.requestedRole, "Admin");
    assert.throws(() => store.approveEntraRole(adminKey, reviewer), /not allowed/i);
    const approved = store.approveEntraRole(adminKey, breakGlass);
    assert.equal(approved.status, "active");
    assert.equal(approved.role, "Admin");
    assert.equal(approved.approvedBy, "BreakGlass");
});

test("pending SecAdmin role requires an independent SecAdmin or BreakGlass", () => {
    const store = userStoreFactory.create({ dataDir: dir() });
    const pending = store.resolveEntra(secAdminKey, { username: "future-secadmin", displayName: "Future SecAdmin" }, ["SecAdmin"]);
    assert.equal(pending.requestedRole, "SecAdmin");
    assert.throws(() => store.approveEntraRole(secAdminKey, selfReviewer), /not allowed/i);
    const approved = store.approveEntraRole(secAdminKey, reviewer);
    assert.equal(approved.status, "active");
    assert.equal(approved.role, "SecAdmin");
    assert.equal(approved.approvedBy, reviewer.identityKey);
});

test("SecAdmin cannot create standard or Admin local accounts", () => {
    const store = userStoreFactory.create({ dataDir: dir() });
    assert.throws(() => store.createLocalUser({ username: "operator", displayName: "Operator", password: "Correct-Horse-Battery-Staple", role: "OperatorL1" }, reviewer), /not allowed/i);
    assert.throws(() => store.createLocalUser({ username: "localadmin", displayName: "Local Admin", password: "Correct-Horse-Battery-Staple", role: "Admin" }, reviewer), /not allowed/i);
    const created = store.createLocalUser({ username: "localsec", displayName: "Local SecAdmin", password: "Correct-Horse-Battery-Staple", role: "SecAdmin" }, reviewer);
    assert.equal(created.role, "SecAdmin");
});
