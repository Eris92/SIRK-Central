"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { allowedWorkspaces, isExactBreakGlass } = require("../src/entry");

test("workspace matrix separates Admin, SecAdmin and built-in Break-Glass", () => {
    const admin = { ok: true, source: "entra", role: "Admin", builtIn: false };
    const secAdmin = { ok: true, source: "entra", role: "SecAdmin", builtIn: false };
    const breakGlass = { ok: true, source: "local", role: "BreakGlass", builtIn: true };

    assert.deepEqual(allowedWorkspaces(admin), ["portals", "admin", "settings"]);
    assert.deepEqual(allowedWorkspaces(secAdmin), ["portals", "security", "settings"]);
    assert.deepEqual(allowedWorkspaces(breakGlass), ["portals", "admin", "security", "settings", "break-glass"]);
    assert.equal(isExactBreakGlass(breakGlass), true);
    assert.equal(isExactBreakGlass({ ok: true, source: "entra", role: "BreakGlass", builtIn: true }), false);
    assert.equal(isExactBreakGlass({ ok: true, source: "local", role: "SecAdmin", builtIn: true }), false);
});
