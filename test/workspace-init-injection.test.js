"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("entry injects initializer only for protected workspace responses", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "entry.js"), "utf8");
  assert.match(source, /workspace-init\.js/);
  assert.match(source, /html\.replace\("<\/body>"/);
  assert.match(source, /const workspace = WORKSPACES\[url\.pathname\]/);
});
