"use strict";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function integrity(app) {
    if (!app || !app.auditStore || typeof app.auditStore.verify !== "function") {
        return { ok: false, reason: "audit-store-unavailable" };
    }
    try {
        const result = app.auditStore.verify();
        return result && result.ok === true ? result : Object.assign({ ok: false, reason: "audit-integrity-failed" }, result || {});
    } catch (_) {
        return { ok: false, reason: "audit-verification-error" };
    }
}

function mutatingRequest(req, pathname) {
    const method = String(req && req.method || "GET").toUpperCase();
    const route = String(pathname || "");
    if (SAFE_METHODS.has(method)) return false;
    if (route === "/api/logout") return false;
    return route.startsWith("/api/") || route.startsWith("/auth/sso/");
}

function evaluate(app, req, pathname) {
    const readiness = pathname === "/readyz";
    const mutation = mutatingRequest(req, pathname);
    if (!readiness && !mutation) return { handled: false, status: 0, body: null, integrity: null };

    const result = integrity(app);
    if (readiness && !result.ok) {
        return { handled: true, status: 503, body: { ok: false, code: "AUDIT_INTEGRITY_FAILED", error: "Audit trail integrity verification failed.", checks: { auditIntegrity: false }, integrity: result } };
    }
    if (mutation && !result.ok) {
        return { handled: true, status: 503, body: { ok: false, code: "AUDIT_INTEGRITY_FAILED", error: "Mutating operations are disabled until audit trail integrity is restored." } };
    }
    return { handled: false, status: 0, body: null, integrity: result };
}

module.exports = { integrity, mutatingRequest, evaluate };
