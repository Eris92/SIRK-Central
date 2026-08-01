"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { allowedWorkspaces, isExactBreakGlass } = require("../src/modules/workspace-authorization");

test("workspace authorization is a named flat-runtime module", () => {
  const index = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  const routing = fs.readFileSync(path.join(__dirname, "..", "public", "workspace-routing.js"), "utf8");
  const server = fs.readFileSync(path.join(__dirname, "..", "src", "server.js"), "utf8");

  const bootstrapPosition = index.indexOf('/workspace-bootstrap.js');
  const appPosition = index.indexOf('/app.js');
  assert.ok(bootstrapPosition >= 0, "workspace bootstrap script is present");
  assert.ok(appPosition > bootstrapPosition, "workspace bootstrap loads before app.js");
  assert.match(server, /registerWorkspaceAuthorization/);
  assert.match(routing, /window\.__SIRK_WORKSPACE_BOOTSTRAP/);

  const admin = { status: "active", source: "entra", role: "Admin", builtIn: false };
  const secAdmin = { status: "active", source: "entra", role: "SecAdmin", builtIn: false };
  const breakGlass = { status: "active", source: "local", role: "BreakGlass", builtIn: true };
  assert.deepEqual(allowedWorkspaces(admin), ["portals", "permissions", "settings", "update"]);
  assert.deepEqual(allowedWorkspaces(secAdmin), ["portals", "permissions", "security", "settings"]);
  assert.equal(isExactBreakGlass(breakGlass), true);
});
