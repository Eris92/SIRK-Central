"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const organizationApi = require("../src/organization-api");
const approvalApi = require("../src/approval-api");
const portalAssignmentApi = require("../src/portal-assignment-api");

const identities = {
    anonymous: null,
    auditor: { ok: true, role: "Auditor", builtIn: false },
    operator: { ok: true, role: "OperatorL1", builtIn: false },
    admin: { ok: true, role: "Admin", builtIn: false },
    secadmin: { ok: true, role: "SecAdmin", builtIn: false },
    breakglass: { ok: true, role: "BreakGlass", source: "local", builtIn: true }
};

test("organization authorization separates read and management", () => {
    assert.equal(organizationApi.canRead(identities.auditor), true);
    assert.equal(organizationApi.canRead(identities.operator), false);
    assert.equal(organizationApi.canManage(identities.admin), true);
    assert.equal(organizationApi.canManage(identities.secadmin), false);
    assert.equal(organizationApi.canManage(identities.breakglass), true);
    assert.equal(organizationApi.canManage(identities.anonymous), false);
});

test("approval authorization separates submission from decision", () => {
    assert.equal(approvalApi.canRead(identities.auditor), true);
    assert.equal(approvalApi.canSubmit(identities.operator), true);
    assert.equal(approvalApi.canSubmit(identities.auditor), false);
    assert.equal(approvalApi.canDecide(identities.admin), false);
    assert.equal(approvalApi.canDecide(identities.secadmin), true);
    assert.equal(approvalApi.canDecide(identities.breakglass), true);
});

test("Portal assignment authorization is Admin-managed and security-readable", () => {
    assert.equal(portalAssignmentApi.canRead(identities.auditor), true);
    assert.equal(portalAssignmentApi.canRead(identities.secadmin), true);
    assert.equal(portalAssignmentApi.canRead(identities.operator), false);
    assert.equal(portalAssignmentApi.canManage(identities.admin), true);
    assert.equal(portalAssignmentApi.canManage(identities.secadmin), false);
    assert.equal(portalAssignmentApi.canManage(identities.breakglass), true);
});
