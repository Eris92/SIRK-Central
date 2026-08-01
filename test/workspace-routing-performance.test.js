"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "..", "public", "workspace-routing.js"), "utf8");

test("workspace routing observes only dashboard visibility", () => {
    assert.match(source, /const dashboard = document\.getElementById\("dashboardView"\)/);
    assert.match(source, /observer\.observe\(dashboard, \{ attributes: true, attributeFilter: \["hidden"\] \}\)/);
    assert.doesNotMatch(source, /observer\.observe\(document\.documentElement/);
    assert.doesNotMatch(source, /subtree:\s*true/);
    assert.doesNotMatch(source, /childList:\s*true/);
});

test("workspace routing deduplicates identity refreshes", () => {
    assert.match(source, /if \(identityRefresh\) return identityRefresh/);
    assert.match(source, /identityRefresh = \(async function \(\)/);
    assert.match(source, /identityRefresh = null/);
});
