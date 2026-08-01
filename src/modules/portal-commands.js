"use strict";

const { json, parseCookies, readBody, csrfAccepted, requestIp } = require("../http/transport");

const commandStoreFactory = require("../portal-command-store");
const rateLimiterFactory = require("../request-rate-limiter");
const { identityActive } = require("../rbac");

const { VERSION } = require("../version");
const HIGH_RISK = new Set(["update", "restart", "diagnostics"]);

function actorFor(app, req) {
    const token = parseCookies(req).sirk_central_session || "";
    return token && app.sessions ? app.sessions.get(token, true) : null;
}
function canRead(actor) {
    return Boolean(identityActive(actor) && (actor.builtIn === true || ["Admin", "SecAdmin", "Auditor", "OperatorL1", "SupportL2", "EngineerL3"].includes(actor.role)));
}
function canWrite(actor) {
    return Boolean(identityActive(actor) && (actor.builtIn === true || ["Admin", "SupportL2", "EngineerL3"].includes(actor.role)));
}
function portalCredential(req) {
    const authorization = String(req.headers.authorization || "");
    if (authorization.length > 8192) return null;
    const match = authorization.match(/^SIRK-Portal ([A-Za-z0-9_-]{8,8192})$/);
    if (!match) return null;
    try {
        const decoded = Buffer.from(match[1], "base64url").toString("utf8");
        const index = decoded.indexOf(":");
        if (index < 1 || index > 128 || decoded.length - index - 1 < 16) return null;
        return { id: decoded.slice(0, index), token: decoded.slice(index + 1) };
    } catch (_) { return null; }
}
function authenticatePortal(app, req) {
    const credential = portalCredential(req);
    if (!credential || !app.portalRegistry || typeof app.portalRegistry.authenticate !== "function") return null;
    return app.portalRegistry.authenticate(credential.id, credential.token);
}
function consumeOrReject(res, limiter, key) {
    const result = limiter.consume(key);
    if (result.allowed) return true;
    json(res, 429, { ok: false, code: "RATE_LIMITED", error: "Too many requests." }, { "Retry-After": String(result.retryAfterSeconds) });
    return false;
}
function portalAllowed(app, actor, portalId) {
    if (!identityActive(actor)) return false;
    if (actor.builtIn === true) return true;
    if (!app.accessStore || typeof app.accessStore.effective !== "function") return false;
    try { return app.accessStore.effective(actor, portalId).allowed === true; }
    catch (_) { return false; }
}
function visiblePortalIds(app, actor) {
    const registry = app.portalRegistry && typeof app.portalRegistry.list === "function" ? app.portalRegistry.list() : [];
    return registry.filter(portal => portalAllowed(app, actor, portal.id)).map(portal => portal.id);
}
function audit(app, action, actor, req, details, result = "success", category = "operations", config = {}) {
    if (!app.auditStore || typeof app.auditStore.append !== "function") return;
    app.auditStore.append({
        action,
        category,
        result,
        actor,
        request: {
            ip: requestIp(req, config),
            userAgent: String(req.headers["user-agent"] || ""),
            method: req.method,
            path: req.url
        },
        target: details && (details.commandId || details.portalId) || "",
        details
    });
}
function approvedOperation(app, approvalId, portalId, type) {
    if (!HIGH_RISK.has(type)) return null;
    if (!approvalId || !app.approvals || typeof app.approvals.get !== "function") return null;
    const request = app.approvals.get(approvalId);
    if (!request || request.state !== "approved" || request.execution) return null;
    if (request.type !== "operation.high-risk") return null;
    const approvedPortal = String(request.scope && request.scope.portalId || request.payload && request.payload.portalId || "").toLowerCase();
    const approvedType = String(request.payload && (request.payload.operation || request.payload.type) || "");
    if (!approvedPortal || !approvedType || approvedPortal !== portalId || approvedType !== type) return null;
    return { required: true, request };
}
function approvalAccepted(app, approvalId, portalId, type) {
    return !HIGH_RISK.has(type) || Boolean(approvedOperation(app, approvalId, portalId, type));
}
function consumeApproval(app, approvalId, command, actor, commands) {
    if (!approvalId || !app.approvals || typeof app.approvals.markExecution !== "function") return;
    try {
        app.approvals.markExecution(approvalId, {
            state: "completed",
            action: "portal.command.queued",
            portalId: command.portalId,
            commandType: command.type,
            commandId: command.id,
            executedBy: actor.identityKey || actor.username || "system"
        });
    } catch (error) {
        try { commands.cancel(command.id, { username: "approval-rollback", identityKey: "system:approval-rollback" }); }
        catch (_) { /* best effort */ }
        throw error;
    }
}
function validateFilter(filter, commands) {
    if (filter.portalId && !/^[a-z0-9][a-z0-9-]{2,62}$/.test(filter.portalId)) throw Object.assign(new Error("Portal ID is invalid."), { statusCode: 400 });
    if (filter.state && !commands.STATES.includes(filter.state)) throw Object.assign(new Error("Command state filter is invalid."), { statusCode: 400 });
    if (filter.type && !commands.TYPES.includes(filter.type)) throw Object.assign(new Error("Command type filter is invalid."), { statusCode: 400 });
}

function registerPortalCommands(app, config) {
    const commands = commandStoreFactory.create({
        dataDir: config.dataDir,
        maxCommands: Number(config.env.SIRK_PORTAL_COMMAND_MAX || 10000),
        maxActivePerPortal: Number(config.env.SIRK_PORTAL_COMMAND_MAX_ACTIVE || 50),
        deliveryLeaseMs: Number(config.env.SIRK_PORTAL_COMMAND_DELIVERY_LEASE_MS || 60000)
    });
    const preAuthLimiter = rateLimiterFactory.create({
        limit: Number(config.env.SIRK_PORTAL_AUTH_RATE_LIMIT || 120),
        windowMs: Number(config.env.SIRK_PORTAL_AUTH_RATE_WINDOW_MS || 60000),
        maxEntries: Number(config.env.SIRK_PORTAL_RATE_LIMIT_MAX_KEYS || 20000)
    });
    const portalLimiter = rateLimiterFactory.create({
        limit: Number(config.env.SIRK_PORTAL_COMMAND_RATE_LIMIT || 180),
        windowMs: Number(config.env.SIRK_PORTAL_COMMAND_RATE_WINDOW_MS || 60000),
        maxEntries: Number(config.env.SIRK_PORTAL_RATE_LIMIT_MAX_KEYS || 20000)
    });

    const handler = async (req, res) => {
        try {
            const url = new URL(req.url, "http://central.local");

            if (req.method === "GET" && url.pathname === "/api/portal/v1/commands") {
                if (!consumeOrReject(res, preAuthLimiter, "commands:ip:" + requestIp(req, config))) return;
                const portal = authenticatePortal(app, req);
                if (!portal) return json(res, 404, { ok: false, error: "Not found." });
                if (!consumeOrReject(res, portalLimiter, "poll:" + portal.id)) return;
                const items = commands.deliver(portal.id, Number(url.searchParams.get("limit") || 20));
                if (items.length) audit(app, "portal.commands_delivered", { username: portal.id, source: "portal", role: "Portal", status: "active" }, req, { portalId: portal.id, count: items.length, commandIds: items.map(item => item.id) }, "success", "operations", config);
                return json(res, 200, { ok: true, portalId: portal.id, commands: items, pollAfterSeconds: 15 });
            }
            const ackMatch = url.pathname.match(/^\/api\/portal\/v1\/commands\/(cmd-[a-z0-9_-]+)\/ack$/);
            if (req.method === "POST" && ackMatch) {
                if (!consumeOrReject(res, preAuthLimiter, "ack:ip:" + requestIp(req, config))) return;
                const portal = authenticatePortal(app, req);
                if (!portal) return json(res, 404, { ok: false, error: "Not found." });
                if (!consumeOrReject(res, portalLimiter, "ack:" + portal.id)) return;
                const command = commands.acknowledge(portal.id, ackMatch[1], await readBody(req));
                audit(app, "portal.command_acknowledged", { username: portal.id, source: "portal", role: "Portal", status: "active" }, req, { portalId: portal.id, commandId: command.id, state: command.state, progress: command.progress }, command.state === "failed" ? "failure" : "success", "operations", config);
                return json(res, 200, { ok: true, command });
            }

            if (!url.pathname.startsWith("/api/portal-operations")) return false;
            const actor = actorFor(app, req);
            if (!actor) return json(res, 401, { ok: false, error: "Authentication required." });

            if (req.method === "GET" && url.pathname === "/api/portal-operations") {
                if (!canRead(actor)) return json(res, 403, { ok: false, error: "Permission denied." });
                const portalIds = visiblePortalIds(app, actor);
                const filter = {
                    portalIds,
                    portalId: url.searchParams.get("portalId") || undefined,
                    state: url.searchParams.get("state") || undefined,
                    type: url.searchParams.get("type") || undefined,
                    limit: Number(url.searchParams.get("limit") || 200)
                };
                validateFilter(filter, commands);
                if (filter.portalId && !portalIds.includes(filter.portalId)) return json(res, 403, { ok: false, error: "Permission denied." });
                return json(res, 200, { ok: true, commands: commands.list(filter), summary: commands.summary(filter), types: commands.TYPES, states: commands.STATES });
            }
            if (req.method === "POST" && url.pathname === "/api/portal-operations") {
                if (!canWrite(actor)) return json(res, 403, { ok: false, error: "Permission denied." });
                if (!csrfAccepted(req, config)) return json(res, 403, { ok: false, error: "CSRF validation failed." });
                const body = await readBody(req);
                const portalId = String(body.portalId || "").toLowerCase();
                const type = String(body.type || "");
                if (!portalAllowed(app, actor, portalId)) return json(res, 403, { ok: false, error: "Permission denied." });
                if (!app.portalRegistry || !app.portalRegistry.list().some(item => item.id === portalId)) return json(res, 404, { ok: false, error: "Portal not found." });
                const approval = HIGH_RISK.has(type) ? approvedOperation(app, body.approvalId, portalId, type) : null;
                if (HIGH_RISK.has(type) && !approval) {
                    return json(res, 409, { ok: false, code: "APPROVAL_REQUIRED", error: "This operation requires a new, unused operation.high-risk approval matching the exact Portal and command type." });
                }
                const command = commands.enqueue({
                    portalId,
                    type,
                    payload: body.payload,
                    ttlMinutes: body.ttlMinutes,
                    approvalId: approval ? body.approvalId : ""
                }, actor);
                if (approval) consumeApproval(app, body.approvalId, command, actor, commands);
                audit(app, "portal.command_queued", actor, req, { portalId: command.portalId, commandId: command.id, type: command.type, approvalId: command.approvalId }, "success", "operations", config);
                return json(res, 201, { ok: true, command });
            }
            const actionMatch = url.pathname.match(/^\/api\/portal-operations\/(cmd-[a-z0-9_-]+)\/(cancel|retry)$/);
            if (req.method === "POST" && actionMatch) {
                if (!canWrite(actor)) return json(res, 403, { ok: false, error: "Permission denied." });
                if (!csrfAccepted(req, config)) return json(res, 403, { ok: false, error: "CSRF validation failed." });
                const source = commands.get(actionMatch[1]);
                if (!source) return json(res, 404, { ok: false, error: "Command not found." });
                if (!portalAllowed(app, actor, source.portalId)) return json(res, 403, { ok: false, error: "Permission denied." });
                let command;
                if (actionMatch[2] === "cancel") {
                    command = commands.cancel(actionMatch[1], actor);
                } else {
                    const body = await readBody(req, 16384);
                    const approval = HIGH_RISK.has(source.type) ? approvedOperation(app, body.approvalId, source.portalId, source.type) : null;
                    if (HIGH_RISK.has(source.type) && !approval) {
                        return json(res, 409, { ok: false, code: "APPROVAL_REQUIRED", error: "Retrying this high-risk command requires a new, unused approval." });
                    }
                    command = commands.retry(actionMatch[1], actor, {
                        approvalId: approval ? body.approvalId : "",
                        ttlMinutes: body.ttlMinutes
                    });
                    if (approval) consumeApproval(app, body.approvalId, command, actor, commands);
                }
                audit(app, "portal.command_" + actionMatch[2], actor, req, { portalId: command.portalId, commandId: command.id, type: command.type, approvalId: command.approvalId }, "success", "operations", config);
                return json(res, 200, { ok: true, command });
            }
            return json(res, 404, { ok: false, error: "Not found." });
        } catch (error) {
            const status = Number.isInteger(error.statusCode) ? error.statusCode : 500;
            const message = status >= 500 ? "Internal server error." : error.message || "Request failed.";
            if (!res.headersSent) return json(res, status, { ok: false, code: error.code || (status >= 500 ? "INTERNAL_ERROR" : "REQUEST_REJECTED"), error: message });
            res.destroy(error);
        }
    };
    app.router.prepend(handler);
    Object.assign(app, { version: VERSION, portalCommands: commands });
    return app
}

module.exports = {
    registerPortalCommands,
    VERSION,
    HIGH_RISK,
    approvedOperation,
    approvalAccepted,
    consumeApproval,
    canRead,
    canWrite,
    portalAllowed,
    visiblePortalIds
};
