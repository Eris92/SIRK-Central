"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const rbac = require("../src/rbac");
const organizationApi = require("../src/organization-api");
const portalAssignmentApi = require("../src/portal-assignment-api");
const approvalCenter = require("../src/modules/approvals");
const portalOperations = require("../src/modules/portal-commands");
const ticketApi = require("../src/modules/tickets");

function identity(role, overrides = {}) {
    return Object.assign({
        ok: true,
        username: role.toLowerCase(),
        identityKey: "tenant:" + role.toLowerCase(),
        role,
        source: "entra",
        status: "active",
        builtIn: false
    }, overrides);
}

const identities = Object.freeze({
    anonymous: null,
    pending: identity("Admin", { username: "pending", identityKey: "tenant:pending", status: "pending" }),
    operator: identity("OperatorL1"),
    support: identity("SupportL2"),
    engineer: identity("EngineerL3"),
    auditor: identity("Auditor"),
    admin: identity("Admin"),
    secadmin: identity("SecAdmin"),
    breakglass: identity("BreakGlass", { username: "admin", identityKey: "breakglass:admin", source: "local", builtIn: true })
});

const matrix = [
    { name: "anonymous", actor: identities.anonymous, active: false, organizationRead: false, organizationManage: false, approvalRead: false, approvalSubmit: false, approvalDecide: false, operationsRead: false, operationsWrite: false, ticketsRead: false, ticketsWrite: false },
    { name: "Pending", actor: identities.pending, active: false, organizationRead: false, organizationManage: false, approvalRead: false, approvalSubmit: false, approvalDecide: false, operationsRead: false, operationsWrite: false, ticketsRead: false, ticketsWrite: false },
    { name: "OperatorL1", actor: identities.operator, active: true, organizationRead: false, organizationManage: false, approvalRead: false, approvalSubmit: true, approvalDecide: false, operationsRead: true, operationsWrite: false, ticketsRead: true, ticketsWrite: false },
    { name: "SupportL2", actor: identities.support, active: true, organizationRead: false, organizationManage: false, approvalRead: false, approvalSubmit: true, approvalDecide: false, operationsRead: true, operationsWrite: true, ticketsRead: true, ticketsWrite: true },
    { name: "EngineerL3", actor: identities.engineer, active: true, organizationRead: false, organizationManage: false, approvalRead: false, approvalSubmit: true, approvalDecide: false, operationsRead: true, operationsWrite: true, ticketsRead: true, ticketsWrite: true },
    { name: "Auditor", actor: identities.auditor, active: true, organizationRead: true, organizationManage: false, approvalRead: true, approvalSubmit: false, approvalDecide: false, operationsRead: true, operationsWrite: false, ticketsRead: true, ticketsWrite: false },
    { name: "Admin", actor: identities.admin, active: true, organizationRead: true, organizationManage: true, approvalRead: true, approvalSubmit: true, approvalDecide: false, operationsRead: true, operationsWrite: true, ticketsRead: true, ticketsWrite: true },
    { name: "SecAdmin", actor: identities.secadmin, active: true, organizationRead: true, organizationManage: false, approvalRead: true, approvalSubmit: true, approvalDecide: true, operationsRead: true, operationsWrite: false, ticketsRead: true, ticketsWrite: false },
    { name: "BreakGlass", actor: identities.breakglass, active: true, organizationRead: true, organizationManage: true, approvalRead: true, approvalSubmit: true, approvalDecide: true, operationsRead: true, operationsWrite: true, ticketsRead: true, ticketsWrite: true }
];

test("complete RBAC matrix is consistent across organization approvals operations and tickets", () => {
    const independentRequest = { type: "role.assignment", requestedBy: "tenant:requester", payload: { role: "SecAdmin" } };
    for (const row of matrix) {
        assert.equal(rbac.identityActive(row.actor), row.active, row.name + " active");
        assert.equal(organizationApi.canRead(row.actor), row.organizationRead, row.name + " organization read");
        assert.equal(organizationApi.canManage(row.actor), row.organizationManage, row.name + " organization manage");
        assert.equal(portalAssignmentApi.canRead(row.actor), row.organizationRead, row.name + " assignment read");
        assert.equal(portalAssignmentApi.canManage(row.actor), row.organizationManage, row.name + " assignment manage");
        assert.equal(approvalCenter.canRead(row.actor), row.approvalRead, row.name + " approval center read");
        assert.equal(approvalCenter.canSubmit(row.actor), row.approvalSubmit, row.name + " approval center submit");
        assert.equal(approvalCenter.canDecide(row.actor, independentRequest), row.approvalDecide, row.name + " approval center decide");
        assert.equal(portalOperations.canRead(row.actor), row.operationsRead, row.name + " operations read");
        assert.equal(portalOperations.canWrite(row.actor), row.operationsWrite, row.name + " operations write");
        assert.equal(ticketApi.canRead(row.actor), row.ticketsRead, row.name + " tickets read");
        assert.equal(ticketApi.canWrite(row.actor), row.ticketsWrite, row.name + " tickets write");
    }
});

test("non-active identities are denied regardless of retained role", () => {
    for (const status of ["pending", "conflict", "disabled"]) {
        for (const role of ["OperatorL1", "SupportL2", "EngineerL3", "Auditor", "Admin", "SecAdmin"]) {
            const actor = identity(role, { status });
            assert.equal(rbac.identityActive(actor), false, status + " " + role);
            assert.equal(rbac.hasPermission(actor, "portals.read"), false, status + " " + role + " permissions");
            assert.equal(approvalCenter.canSubmit(actor), false, status + " " + role + " submit");
            assert.equal(portalOperations.canRead(actor), false, status + " " + role + " operations");
            assert.equal(ticketApi.canRead(actor), false, status + " " + role + " tickets");
        }
    }
});

test("SecAdmin decisions are independent and limited to SecAdmin role requests", () => {
    const selfRequest = { type: "role.assignment", requestedBy: identities.secadmin.identityKey, payload: { role: "SecAdmin" } };
    const adminRequest = { type: "role.assignment", requestedBy: "tenant:other", payload: { role: "Admin" } };
    const secAdminRequest = { type: "role.assignment", requestedBy: "tenant:other", payload: { role: "SecAdmin" } };
    assert.equal(approvalCenter.canDecide(identities.secadmin, selfRequest), false);
    assert.equal(approvalCenter.canDecide(identities.secadmin, adminRequest), false);
    assert.equal(approvalCenter.canDecide(identities.secadmin, secAdminRequest), true);
    assert.equal(approvalCenter.canDecide(identities.breakglass, adminRequest), true);
    assert.equal(rbac.identityActive(identity("BreakGlass", { builtIn: true, source: "entra" })), false);
    assert.equal(rbac.identityActive(identity("Admin", { builtIn: true, source: "local" })), false);
});

test("Admin and SecAdmin separation of duties remains explicit", () => {
    assert.equal(rbac.hasPermission(identities.admin, "settings.manage"), true);
    assert.equal(rbac.hasPermission(identities.admin, "security.manage"), false);
    assert.equal(rbac.hasPermission(identities.secadmin, "security.manage"), true);
    assert.equal(rbac.hasPermission(identities.secadmin, "settings.manage"), false);
    assert.equal(rbac.canAssignRole(identities.admin, "Admin", "Auditor"), true);
    assert.equal(rbac.canAssignRole(identities.admin, "SecAdmin", "Auditor"), false);
    assert.equal(rbac.canAssignRole(identities.secadmin, "Admin", "Auditor"), false);
    assert.equal(rbac.canAssignRole(identities.secadmin, "SecAdmin", "Auditor"), true);
    assert.equal(rbac.canAssignRole(identities.secadmin, "SecAdmin", "Admin"), false);
    assert.equal(portalOperations.canWrite(identities.admin), true);
    assert.equal(portalOperations.canWrite(identities.secadmin), false);
    assert.equal(ticketApi.canWrite(identities.admin), true);
    assert.equal(ticketApi.canWrite(identities.secadmin), false);
});
