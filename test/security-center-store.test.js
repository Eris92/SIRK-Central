"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const storeFactory = require("../src/security-center-store");

function withStore() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sirk-security-"));
  return { dataDir, store: storeFactory.create({ dataDir }) };
}

test("security policies are persisted and constrained", () => {
  const { store } = withStore();
  const actor = { username: "secadmin", role: "SecAdmin" };
  const result = store.updatePolicies({ sessionHours: 99, emergencyMode: true, blockNewPortalConnections: true }, actor);
  assert.equal(result.sessionHours, 24);
  assert.equal(result.emergencyMode, true);
  assert.equal(store.policies().blockNewPortalConnections, true);
  assert.equal(store.listAudit(10)[0].event, "security.policies.updated");
});

test("Break-Glass use and review are audited", () => {
  const { store } = withStore();
  const actor = { username: "admin", builtIn: true };
  store.recordBreakGlassUse("192.0.2.10", actor);
  const reviewed = store.markBreakGlassReviewed({ username: "sec", role: "SecAdmin" });
  assert.equal(store.breakGlassStatus().lastUsedIp, "192.0.2.10");
  assert.equal(reviewed.reviewedBy, "sec");
  assert.deepEqual(store.listAudit(10).map(x => x.event).slice(0, 2), ["breakglass.reviewed", "breakglass.signed_in"]);
});

test("incidents can be created and resolved", () => {
  const { store } = withStore();
  const actor = { username: "sec", role: "SecAdmin" };
  const incident = store.createIncident({ title: "Suspicious sign-in", severity: "critical", description: "test" }, actor);
  assert.equal(incident.status, "open");
  const resolved = store.updateIncident(incident.id, { status: "resolved" }, actor);
  assert.equal(resolved.status, "resolved");
  assert.equal(store.incidents()[0].severity, "critical");
});
