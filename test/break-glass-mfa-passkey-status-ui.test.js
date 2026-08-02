"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");

const source = fs.readFileSync("public/break-glass-mfa.js", "utf8");

test("BreakGlass MFA UI reads the canonical .NET 10 passkey inventory", () => {
    assert.match(source, /request\("\/api\/v1\/webauthn\/credentials"\)/);
    assert.match(source, /Array\.isArray\(credentials\) \? credentials\.length : 0/);
    assert.match(source, /activePasskeys/);
    assert.match(source, /renderPasskeyStatus\(\)/);
});

test("BreakGlass MFA mutations use the antiforgery endpoint", () => {
    assert.match(source, /request\("\/api\/v1\/auth\/csrf"\)/);
    assert.match(source, /headers: await csrfHeaders\(\)/);
});

test("BreakGlass MFA UI keeps the inactive message only for zero active passkeys", () => {
    assert.match(source, /activePasskeyCount > 0/);
    assert.match(source, /text\("activePasskeys"\)/);
    assert.match(source, /text\("noPasskey"\)/);
});
