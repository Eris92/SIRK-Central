"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { allowedWorkspaces, isExactBreakGlass, canManageUpdates, redactSessionSecrets, validCsrfToken } = require("../src/entry");

test("workspace matrix separates Admin, SecAdmin and built-in Break-Glass", () => {
    const admin = { ok: true, source: "entra", role: "Admin", builtIn: false };
    const secAdmin = { ok: true, source: "entra", role: "SecAdmin", builtIn: false };
    const breakGlass = { ok: true, source: "local", role: "BreakGlass", builtIn: true };

    assert.deepEqual(allowedWorkspaces(admin), ["portals", "permissions", "settings", "update"]);
    assert.deepEqual(allowedWorkspaces(secAdmin), ["portals", "permissions", "security", "settings"]);
    assert.deepEqual(allowedWorkspaces(breakGlass), ["portals", "permissions", "security", "settings", "break-glass", "update"]);
    assert.equal(isExactBreakGlass(breakGlass), true);
    assert.equal(isExactBreakGlass({ ok: true, source: "entra", role: "BreakGlass", builtIn: true }), false);
    assert.equal(isExactBreakGlass({ ok: true, source: "local", role: "SecAdmin", builtIn: true }), false);
    assert.equal(canManageUpdates(admin), true);
    assert.equal(canManageUpdates(breakGlass), true);
    assert.equal(canManageUpdates(secAdmin), false);
});

test("CSRF token validation accepts only sufficiently long URL-safe values", () => {
    assert.equal(validCsrfToken("a".repeat(32)), true);
    assert.equal(validCsrfToken("A1_-".repeat(12)), true);
    assert.equal(validCsrfToken("short"), false);
    assert.equal(validCsrfToken("a".repeat(31)), false);
    assert.equal(validCsrfToken("a".repeat(129)), false);
    assert.equal(validCsrfToken("a".repeat(31) + "+"), false);
});

test("session redaction removes secrets recursively without mutating safe fields", () => {
    const input = {
        ok: true,
        sessions: [
            { id: "abc123", token: "secret", username: "admin", nested: { sessionToken: "hidden", ip: "127.0.0.1" } }
        ],
        metadata: { cookie: "private", count: 1 }
    };
    const output = redactSessionSecrets(input);

    assert.deepEqual(output, {
        ok: true,
        sessions: [
            { id: "abc123", username: "admin", nested: { ip: "127.0.0.1" } }
        ],
        metadata: { count: 1 }
    });
    assert.equal(input.sessions[0].token, "secret");
});
