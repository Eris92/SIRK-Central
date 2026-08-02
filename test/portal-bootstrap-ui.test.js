"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ui = fs.readFileSync(path.join(__dirname, "..", "public", "portal-bootstrap-ui.js"), "utf8");
const assets = fs.readFileSync(path.join(__dirname, "..", "src", "modules", "ui-assets.js"), "utf8");

assert.match(assets, /publicPath\("portal-bootstrap-ui\.js"\)/);
assert.match(ui, /\/api\/portals\/bootstrap/);
assert.match(ui, /X-SIRK-CSRF/);
assert.match(ui, /credentials:\s*"same-origin"/);
assert.match(ui, /currentBootstrap\s*=\s*body\.bootstrap/);
assert.match(ui, /downloadJson\("sirk-portal-"\s*\+\s*currentBootstrap\.portalId/);
assert.match(ui, /beforeunload/);
assert.doesNotMatch(ui, /localStorage|sessionStorage/);

console.log("portal-bootstrap-ui: OK");
