"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");

const source = fs.readFileSync("public/access-url-cleanup.js", "utf8");

test("BreakGlass login maps a hidden 404 to clear access-link guidance", () => {
    assert.match(source, /url\.pathname === "\/api\/login" && response\.status === 404/);
    assert.match(source, /Link dostępu Break-Glass jest nieprawidłowy albo wygasł/);
    assert.match(source, /The Break-Glass access link is invalid or has expired/);
    assert.match(source, /setTimeout\(showAccessRejected, 0\)/);
});

test("Access bearer remains limited to the bootstrap routes", () => {
    assert.match(source, /new Set\(\["\/api\/access", "\/api\/login"\]\)/);
    assert.match(source, /headers\.delete\("Authorization"\)/);
});
