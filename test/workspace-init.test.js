"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("protected workspace initializer maps all guarded paths", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "public", "workspace-init.js"), "utf8");
  assert.match(source, /"\/admin": "accessButton"/);
  assert.match(source, /"\/security": "securityButton"/);
  assert.match(source, /"\/settings": "settingsButton"/);
  assert.match(source, /"\/break-glass": "breakGlassButton"/);
  assert.match(source, /button\.click\(\)/);
});
