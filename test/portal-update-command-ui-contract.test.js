"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

test("Portal update command UI builds the constrained runner payload", () => {
    const root = path.join(__dirname, "..");
    const ui = fs.readFileSync(path.join(root, "public", "portal-update-command-ui.js"), "utf8");
    const assets = fs.readFileSync(path.join(root, "src", "modules", "ui-assets.js"), "utf8");
    assert.match(assets, /portal-update-command-ui\.js/);
    assert.match(ui, /applicationId:\s*"sirk-portal"/);
    assert.match(ui, /packageUrl/);
    assert.match(ui, /sha256/);
    assert.match(ui, /targetVersion/);
    assert.match(ui, /\[A-Fa-f0-9\]\{64\}/);
    assert.match(ui, /payload\.readOnly\s*=\s*update/);
});
