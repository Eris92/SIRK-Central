"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const guard = require("../src/audit-integrity-guard");

function app(result) {
    return { auditStore: { verify() { return result; } } };
}

function req(method) { return { method }; }

test("ordinary read requests avoid full audit verification", () => {
    let calls = 0;
    const target = { auditStore: { verify() { calls += 1; return { ok: true }; } } };
    const decision = guard.evaluate(target, req("GET"), "/api/tickets");
    assert.equal(decision.handled, false);
    assert.equal(decision.integrity, null);
    assert.equal(calls, 0);
});

test("readiness fails closed when audit integrity is unavailable or damaged", () => {
    for (const result of [null, { ok: false, reason: "event-hash-mismatch" }]) {
        const decision = guard.evaluate(result ? app(result) : {}, req("GET"), "/readyz");
        assert.equal(decision.handled, true);
        assert.equal(decision.status, 503);
        assert.equal(decision.body.code, "AUDIT_INTEGRITY_FAILED");
        assert.equal(decision.body.checks.auditIntegrity, false);
    }
});

test("mutations are blocked before state changes while logout remains available", () => {
    const damaged = app({ ok: false, reason: "event-hash-mismatch" });
    for (const [method, route] of [
        ["POST", "/api/portal/v1/tickets/snapshot"],
        ["PATCH", "/api/tickets/portal/ticket"],
        ["POST", "/auth/sso/frontchannel-logout"]
    ]) {
        const decision = guard.evaluate(damaged, req(method), route);
        assert.equal(decision.handled, true, method + " " + route);
        assert.equal(decision.status, 503);
    }
    assert.equal(guard.evaluate(damaged, req("POST"), "/api/logout").handled, false);
});

test("healthy audit trail permits readiness and mutations", () => {
    const healthy = app({ ok: true, count: 10, algorithm: "hmac-sha256" });
    assert.equal(guard.evaluate(healthy, req("GET"), "/readyz").handled, false);
    assert.equal(guard.evaluate(healthy, req("POST"), "/api/settings/backup/run").handled, false);
});
