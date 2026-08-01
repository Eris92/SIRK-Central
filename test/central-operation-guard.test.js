"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const guard = require("../src/central-operation-guard");

const active = role => ({ username: role.toLowerCase(), role, source: "entra", status: "active", builtIn: false });
const breakGlass = { username: "admin", role: "BreakGlass", source: "local", status: "active", builtIn: true };

test("destructive Central routes are recognized without covering read-only routes", () => {
    for (const [method, route] of [
        ["POST", "/api/settings/update/run"],
        ["POST", "/api/settings/update/rollback"],
        ["POST", "/api/settings/backup/run"],
        ["POST", "/api/settings/backup/restore"],
        ["PUT", "/api/settings/backup/policy"],
        ["DELETE", "/api/settings/backup/sirk-central-20260731T120000Z.tar.gz"]
    ]) assert.equal(guard.isSensitiveWrite(method, route), true, method + " " + route);
    assert.equal(guard.isSensitiveWrite("GET", "/api/settings/backup/status"), false);
    assert.equal(guard.isSensitiveWrite("GET", "/api/settings/backup/file/download"), false);
});

test("only active Admin and local BreakGlass may execute destructive Central operations", () => {
    assert.equal(guard.canExecute(active("Admin")), true);
    assert.equal(guard.canExecute(breakGlass), true);
    for (const role of ["SecAdmin", "Auditor", "OperatorL1", "SupportL2", "EngineerL3"]) {
        assert.equal(guard.canExecute(active(role)), false, role);
    }
    assert.equal(guard.canExecute({ username: "pending", role: "Admin", source: "entra", status: "pending", builtIn: false }), false);
});

test("guard returns deterministic HTTP decisions", () => {
    assert.deepEqual(guard.evaluate(null, "POST", "/api/settings/update/run"), { handled: true, allowed: false, status: 401, error: "Authentication required." });
    assert.equal(guard.evaluate(active("SecAdmin"), "POST", "/api/settings/backup/restore").status, 403);
    assert.equal(guard.evaluate(active("Admin"), "POST", "/api/settings/backup/restore").handled, false);
    assert.equal(guard.evaluate(active("SecAdmin"), "GET", "/api/settings/backup/status").handled, false);
});
