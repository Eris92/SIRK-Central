"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");

const source = fs.readFileSync("public/break-glass-mfa.js", "utf8");

test("BreakGlass MFA UI reads the actual passkey inventory", () => {
    assert.match(source, /request\("\/api\/break-glass\/passkeys"\)/);
    assert.match(source, /passkeyResult\.passkeys\.filter\(item => item\.status === "active"\)\.length/);
    assert.match(source, /activePasskeys/);
    assert.match(source, /renderPasskeyStatus\(\)/);
});

test("BreakGlass MFA UI keeps the inactive message only for zero active passkeys", () => {
    assert.match(source, /activePasskeyCount > 0/);
    assert.match(source, /text\("activePasskeys"\)/);
    assert.match(source, /text\("noPasskey"\)/);
});
