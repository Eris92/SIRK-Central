"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

test("Portal telemetry UI is bundled and exposes Updater state", () => {
    const root = path.join(__dirname, "..");
    const ui = fs.readFileSync(path.join(root, "public", "portal-telemetry-ui.js"), "utf8");
    const assets = fs.readFileSync(path.join(root, "src", "modules", "ui-assets.js"), "utf8");
    assert.match(assets, /portal-telemetry-ui\.js/);
    assert.match(ui, /\/api\/portal-telemetry/);
    assert.match(ui, /shared Updater|SIRK Updater/);
    assert.match(ui, /updater\.status/);
    assert.match(ui, /onlineAgents/);
    assert.match(ui, /MutationObserver/);
});
