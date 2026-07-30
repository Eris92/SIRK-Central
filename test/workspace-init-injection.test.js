"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("workspace authorization is loaded before application scripts", () => {
  const entry = fs.readFileSync(path.join(__dirname, "..", "src", "entry.js"), "utf8");
  const index = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  const routing = fs.readFileSync(path.join(__dirname, "..", "public", "workspace-routing.js"), "utf8");

  assert.match(entry, /workspace-bootstrap\.js/);
  assert.match(entry, /window\.__SIRK_WORKSPACE_BOOTSTRAP=/);
  assert.match(entry, /const workspace = WORKSPACES\[url\.pathname\]/);

  const bootstrapPosition = index.indexOf('/workspace-bootstrap.js');
  const appPosition = index.indexOf('/app.js');
  assert.ok(bootstrapPosition >= 0, "workspace bootstrap script is present");
  assert.ok(appPosition > bootstrapPosition, "workspace bootstrap loads before app.js");

  assert.match(routing, /document\.addEventListener\("click"/);
  assert.match(routing, /window\.location\.assign\(route\)/);
  assert.match(routing, /isWorkspaceOpen/);
});
