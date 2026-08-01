"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const userStoreFactory = require("../src/user-store");
const { normalizeAppRoles } = require("../auth/server");

const TID = "11111111-1111-4111-8111-111111111111";
const OID = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";
const KEY = TID + ":" + OID;

function store(t) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sirk-role-test-"));
    t.after(() => fs.rmSync(dataDir, { recursive:true, force:true }));
    return userStoreFactory.create({ dataDir });
}
const breakGlass = { builtIn:true, role:"BreakGlass", username:"admin", status:"active", source:"local" };
const secAdmin = { builtIn:false, role:"SecAdmin", identityKey:TID + ":" + OTHER, username:"secadmin", status:"active", source:"entra" };

 test("Auth Broker forwards only supported unique application roles", () => {
    assert.deepEqual(normalizeAppRoles(["Auditor", "Auditor", "Unknown", "Admin"]), ["Auditor", "Admin"]);
    assert.deepEqual(normalizeAppRoles("Auditor"), []);
});

test("ordinary Entra application role activates automatically", t => {
    const users = store(t);
    const state = users.resolveEntra(KEY, { username:"user@example.com", displayName:"User" }, ["SupportL2"]);
    assert.equal(state.role, "SupportL2");
    assert.equal(state.status, "active");
    assert.equal(state.roleSource, "entra");
    assert.equal(state.requestedRole, null);
});

test("Admin application role stays pending until approved", t => {
    const users = store(t);
    const pending = users.resolveEntra(KEY, { username:"admin@example.com", displayName:"Admin candidate" }, ["Admin"]);
    assert.equal(pending.role, null);
    assert.equal(pending.status, "pending");
    assert.equal(pending.requestedRole, "Admin");
    assert.equal(users.listUsers(breakGlass)[0].canApprove, true);

    const approved = users.approveEntraRole(KEY, breakGlass);
    assert.equal(approved.role, "Admin");
    assert.equal(approved.status, "active");
    assert.equal(approved.roleSource, "entra-approved");

    const nextLogin = users.resolveEntra(KEY, { username:"admin@example.com" }, ["Admin"]);
    assert.equal(nextLogin.role, "Admin");
    assert.equal(nextLogin.status, "active");
});

test("active SecAdmin can approve another SecAdmin but not itself", t => {
    const users = store(t);
    users.resolveEntra(KEY, { username:"candidate@example.com" }, ["SecAdmin"]);
    assert.equal(users.approveEntraRole(KEY, secAdmin).role, "SecAdmin");

    const selfStore = store(t);
    const selfKey = secAdmin.identityKey;
    selfStore.resolveEntra(selfKey, { username:"self@example.com" }, ["SecAdmin"]);
    assert.throws(() => selfStore.approveEntraRole(selfKey, secAdmin), /not allowed/i);
});

test("multiple supported roles create a conflict and no permissions", t => {
    const users = store(t);
    const state = users.resolveEntra(KEY, { username:"conflict@example.com" }, ["Admin", "SecAdmin"]);
    assert.equal(state.role, null);
    assert.equal(state.status, "conflict");
    assert.deepEqual(state.claimedRoles, ["Admin", "SecAdmin"]);
});

test("removing an Entra-derived role revokes it on next sign-in", t => {
    const users = store(t);
    assert.equal(users.resolveEntra(KEY, {}, ["EngineerL3"]).role, "EngineerL3");
    const state = users.resolveEntra(KEY, {}, []);
    assert.equal(state.role, null);
    assert.equal(state.status, "pending");
});

test("Entra identities without App Roles cannot receive a manual fallback role", t => {
    const users = store(t);
    users.resolveEntra(KEY, {}, []);
    assert.throws(
        () => users.updateRole({ source:"entra", key:KEY }, "Auditor", breakGlass),
        /managed by application role claims/i
    );
});
