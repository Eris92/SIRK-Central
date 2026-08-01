"use strict";

const { json, parseCookies, readBody, csrfAccepted } = require("../http/transport");

const { identityActive } = require("../rbac");

const { VERSION } = require("../version");
const DEFERRED_APPROVAL_TYPES = new Set([
    "tenant.activation",
    "portal.enrollment",
    "operation.high-risk",
    "credential.use"
]);

function currentToken(req) { return parseCookies(req).sirk_central_session || ""; }
function actorFor(app, req) {
    const token = currentToken(req);
    return token && app.sessions ? app.sessions.get(token, true) : null;
}
function actorKey(actor) { return String(actor && (actor.identityKey || actor.username) || ""); }
function canRead(actor) {
    return Boolean(identityActive(actor) && (actor.builtIn === true || ["Admin", "SecAdmin", "Auditor"].includes(actor.role)));
}
function canSubmit(actor) {
    return Boolean(identityActive(actor) && (actor.builtIn === true || ["Admin", "SecAdmin", "OperatorL1", "SupportL2", "EngineerL3"].includes(actor.role)));
}
function canDecide(actor, request) {
    if (!identityActive(actor) || actorKey(actor) === String(request && request.requestedBy || "")) return false;
    const type = String(request && request.type || "");
    const targetRole = String(request && request.payload && request.payload.role || "");
    if (type === "role.assignment" && targetRole === "BreakGlass") return false;
    if (actor.builtIn === true) return true;
    if (actor.role !== "SecAdmin") return false;
    if (type === "role.assignment") return targetRole === "SecAdmin";
    return true;
}
function audit(app, action, actor, req, details, result = "success") {
    if (!app.auditStore || typeof app.auditStore.append !== "function") return;
    app.auditStore.append({
        action,
        category: "access",
        result,
        actor,
        request: {
            ip: String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim(),
            userAgent: String(req.headers["user-agent"] || ""),
            method: req.method,
            path: req.url
        },
        target: details && details.approvalId || "",
        details
    });
}
function executeApproved(app, request, actor) {
    if (!request || request.state !== "approved") return { executed: false, state: "not-approved" };
    if (request.execution && request.execution.state === "completed") return request.execution;

    if (DEFERRED_APPROVAL_TYPES.has(request.type)) {
        return {
            executed: false,
            state: "authorized",
            approvalId: request.id,
            authorizationType: request.type,
            authorizedAtUtc: request.finishedAtUtc || new Date().toISOString(),
            authorizedBy: actorKey(actor)
        };
    }

    if (request.type !== "role.assignment") throw new Error("Unsupported executable approval type.");
    if (!canDecide(actor, request)) throw new Error("Actor is not permitted to execute this role approval.");
    if (!app.userStore || typeof app.userStore.updateRole !== "function") throw new Error("User role store is unavailable.");

    const identityKey = String(request.payload && request.payload.identityKey || request.scope && request.scope.identityKey || "");
    const role = String(request.payload && request.payload.role || "");
    if (!identityKey || !role) throw new Error("Role approval payload is incomplete.");

    const result = {
        executed: true,
        state: "completed",
        executedAtUtc: new Date().toISOString(),
        executedBy: actorKey(actor),
        change: app.userStore.updateRole({ source: "entra", key: identityKey }, role, actor)
    };
    if (app.approvals && typeof app.approvals.markExecution === "function") return app.approvals.markExecution(request.id, result);
    return result;
}

function registerApprovals(app, config) {

    const handler = async (req, res) => {
        try {
            const url = new URL(req.url, "http://central.local");
            if (!url.pathname.startsWith("/api/approval-center")) return false;
            const actor = actorFor(app, req);
            if (!actor) return json(res, 401, { ok: false, error: "Authentication required." });
            if (!app.approvals) return json(res, 503, { ok: false, error: "Approval store is unavailable." });

            if (req.method === "GET" && url.pathname === "/api/approval-center") {
                if (!canRead(actor)) return json(res, 403, { ok: false, error: "Permission denied." });
                const requests = app.approvals.list({
                    state: url.searchParams.get("state") || undefined,
                    type: url.searchParams.get("type") || undefined
                });
                return json(res, 200, { ok: true, requests, generatedAtUtc: new Date().toISOString() });
            }

            if (req.method === "POST" && url.pathname === "/api/approval-center") {
                if (!canSubmit(actor)) return json(res, 403, { ok: false, error: "Permission denied." });
                if (!csrfAccepted(req, config)) return json(res, 403, { ok: false, error: "CSRF validation failed." });
                const body = await readBody(req);
                const request = app.approvals.submit(body, actor);
                audit(app, "approval.submitted", actor, req, { approvalId: request.id, type: request.type, requiredApprovals: request.requiredApprovals });
                return json(res, 201, { ok: true, request });
            }

            const match = url.pathname.match(/^\/api\/approval-center\/(apr-[a-z0-9_-]+)\/(approve|reject|cancel)$/);
            if (req.method === "POST" && match) {
                if (!identityActive(actor)) return json(res, 403, { ok: false, error: "Permission denied." });
                if (!csrfAccepted(req, config)) return json(res, 403, { ok: false, error: "CSRF validation failed." });
                const existing = app.approvals.get(match[1]);
                if (!existing) return json(res, 404, { ok: false, error: "Approval request not found." });
                const action = match[2];
                const body = await readBody(req, 16384);
                let request;
                if (action === "cancel") {
                    request = app.approvals.cancel(match[1], actor);
                } else {
                    if (!canDecide(actor, existing)) return json(res, 403, { ok: false, error: "Approval decision is not permitted for this role and request type." });
                    request = app.approvals.decide(match[1], action, actor, body.comment);
                }
                let execution = null;
                if (request.state === "approved") {
                    try { execution = executeApproved(app, request, actor); }
                    catch (error) {
                        if (typeof app.approvals.markExecution === "function") {
                            execution = app.approvals.markExecution(request.id, {
                                executed: true,
                                state: "failed",
                                error: String(error.message || error),
                                executedAtUtc: new Date().toISOString(),
                                executedBy: actorKey(actor)
                            });
                        }
                        audit(app, "approval.execution_failed", actor, req, { approvalId: request.id, type: request.type, error: String(error.message || error) }, "failure");
                        return json(res, 409, { ok: false, request: app.approvals.get(request.id), error: "Approval was recorded, but execution failed." });
                    }
                }
                audit(app, "approval." + action, actor, req, { approvalId: request.id, type: request.type, state: request.state, execution });
                return json(res, 200, { ok: true, request: app.approvals.get(request.id), execution });
            }

            return json(res, 404, { ok: false, error: "Not found." });
        } catch (error) {
            const status = Number.isInteger(error.statusCode) ? error.statusCode : 500;
            const message = status >= 500 ? "Internal server error." : error.message || "Request failed.";
            if (!res.headersSent) return json(res, status, { ok: false, code: error.code || (status >= 500 ? "INTERNAL_ERROR" : "REQUEST_REJECTED"), error: message });
            res.destroy(error);
        }
    };
    app.server.requestTimeout = 30000;
    app.server.headersTimeout = 15000;
    app.server.keepAliveTimeout = 5000;
    app.router.prepend(handler);
    Object.assign(app, { version: VERSION });
    return app
}

module.exports = { registerApprovals, VERSION, DEFERRED_APPROVAL_TYPES, canRead, canSubmit, canDecide, executeApproved };
