"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { canRead, canManage } = require("../src/organization-api");

test("organization API separates read and management roles", () => {
    const admin = { ok: true, role: "Admin", builtIn: false };
    const secAdmin = { ok: true, role: "SecAdmin", builtIn: false };
    const auditor = { ok: true, role: "Auditor", builtIn: false };
    const operator = { ok: true, role: "OperatorL1", builtIn: false };
    const breakGlass = { ok: true, role: "BreakGlass", builtIn: true };

    assert.equal(canRead(admin), true);
    assert.equal(canRead(secAdmin), true);
    assert.equal(canRead(auditor), true);
    assert.equal(canRead(operator), false);
    assert.equal(canRead(breakGlass), true);

    assert.equal(canManage(admin), true);
    assert.equal(canManage(secAdmin), false);
    assert.equal(canManage(auditor), false);
    assert.equal(canManage(operator), false);
    assert.equal(canManage(breakGlass), true);
});
