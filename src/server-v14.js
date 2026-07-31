"use strict";

const http = require("node:http");
const { createApprovalRuntime } = require("./server-v13");
const commandStoreFactory = require("./portal-command-store");
const { loadConfig } = require("./server-v1");
const { parseCookies } = require("./server-v8");

const VERSION = "1.0.0-rc.19";
const HIGH_RISK = new Set(["update", "restart", "diagnostics"]);

function json(res, status, body) {
    const data = Buffer.from(JSON.stringify(body));
    res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": String(data.length),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
        "Referrer-Policy": "no-referrer"
    });
    res.end(data);
}
function readBody(req, limit = 65536) {
    return new Promise((resolve, reject) => {
        const chunks = []; let size = 0;
        req.on("data", chunk => {
            size += chunk.length;
            if (size > limit) {
                reject(Object.assign(new Error("Request body is too large."), { statusCode: 413 }));
                req.destroy();
            } else chunks.push(chunk);
        });
        req.on("end", () => {
            try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
            catch (_) { reject(Object.assign(new Error("Invalid JSON body."), { statusCode: 400 })); }
        });
        req.on("error", reject);
    });
}
function actorFor(app, req) {
    const token = parseCookies(req).sirk_central_session || "";
    return token && app.sessions ? app.sessions.get(token, true) : null;
}
function canRead(actor) {
    return Boolean(actor && (actor.builtIn === true || ["Admin", "SecAdmin", "Auditor", "OperatorL1", "SupportL2", "EngineerL3"].includes(actor.role)));
}
function canWrite(actor) {
    return Boolean(actor && (actor.builtIn === true || ["Admin", "SecAdmin", "SupportL2", "EngineerL3"].includes(actor.role)));
}
function csrfAccepted(req, config) {
    const cookies = parseCookies(req);
    const cookie = String(cookies.sirk_central_csrf || "");
    const supplied = String(req.headers["x-sirk-csrf"] || "");
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(cookie) || supplied !== cookie) return false;
    const origin = String(req.headers.origin || "");
    if (origin && origin !== config.publicOrigin) return false;
    const site = String(req.headers["sec-fetch-site"] || "");
    return !site || site === "same-origin" || site === "none";
}
function portalCredential(req) {
    const match = String(req.headers.authorization || "").match(/^SIRK-Portal ([A-Za-z0-9_-]+)$/);
    if (!match) return null;
    try {
        const decoded = Buffer.from(match[1], "base64url").toString("utf8");
        const index = decoded.indexOf(":");
        return index < 1 ? null : { id: decoded.slice(0, index), token: decoded.slice(index + 1) };
    } catch (_) { return null; }
}
function authenticatePortal(app, req) {
    const credential = portalCredential(req);
    if (!credential || !app.portalRegistry || typeof app.portalRegistry.authenticate !== "function") return null;
    return app.portalRegistry.authenticate(credential.id, credential.token);
}
function audit(app, action, actor, req, details, result = "success", category = "operations") {
    if (!app.auditStore || typeof app.auditStore.append !== "function") return;
    app.auditStore.append({
        action, category, result, actor,
        request: {
            ip: String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim(),
            userAgent: String(req.headers["user-agent"] || ""),
            method: req.method,
            path: req.url
        },
        target: details && (details.commandId || details.portalId) || "",
        details
    });
}
function approvedOperation(app, approvalId, portalId, type) {
    if (!HIGH_RISK.has(type)) return { required: false, request: null };
    if (!approvalId || !app.approvals || typeof app.approvals.get !== "function") return null;
    const request = app.approvals.get(approvalId);
    if (!request || request.state !== "approved" || request.execution) return null;
    if (request.type !== "operation.high-risk") return null;
    const approvedPortal = String(request.scope && request.scope.portalId || request.payload && request.payload.portalId || "").toLowerCase();
    const approvedType = String(request.payload && (request.payload.operation || request.payload.type) || "");
    if (!approvedPortal || !approvedType) return null;
    if (approvedPortal !== portalId || approvedType !== type) return null;
    return { required: true, request };
}
function approvalAccepted(app, approvalId, portalId, type) {
    return Boolean(approvedOperation(app, approvalId, portalId, type));
}

function createPortalOperationsRuntime(config) {
    const app = createApprovalRuntime(config);
    const inner = app.server.listeners("request")[0];
    if (typeof inner !== "function") throw new Error("SIRK Central v13 request handler is unavailable.");
    const commands = commandStoreFactory.create({ dataDir: config.dataDir });

    const server = http.createServer(async (req, res) => {
        try {
            const url = new URL(req.url, "http://central.local");

            if (req.method === "GET" && url.pathname === "/api/portal/v1/commands") {
                const portal = authenticatePortal(app, req);
                if (!portal) return json(res, 404, { ok: false, error: "Not found." });
                const items = commands.deliver(portal.id, Number(url.searchParams.get("limit") || 20));
                if (items.length) audit(app, "portal.commands_delivered", { username: portal.id, source: "portal", role: "Portal" }, req, { portalId: portal.id, count: items.length, commandIds: items.map(item => item.id) });
                return json(res, 200, { ok: true, portalId: portal.id, commands: items, pollAfterSeconds: 15 });
            }
            const ackMatch = url.pathname.match(/^\/api\/portal\/v1\/commands\/(cmd-[a-z0-9_-]+)\/ack$/);
            if (req.method === "POST" && ackMatch) {
                const portal = authenticatePortal(app, req);
                if (!portal) return json(res, 404, { ok: false, error: "Not found." });
                const command = commands.acknowledge(portal.id, ackMatch[1], await readBody(req));
                audit(app, "portal.command_acknowledged", { username: portal.id, source: "portal", role: "Portal" }, req, { portalId: portal.id, commandId: command.id, state: command.state, progress: command.progress }, command.state === "failed" ? "failure" : "success");
                return json(res, 200, { ok: true, command });
            }

            if (!url.pathname.startsWith("/api/portal-operations")) return inner(req, res);
            const actor = actorFor(app, req);
            if (!actor) return json(res, 401, { ok: false, error: "Authentication required." });

            if (req.method === "GET" && url.pathname === "/api/portal-operations") {
                if (!canRead(actor)) return json(res, 403, { ok: false, error: "Permission denied." });
                const filter = {
                    portalId: url.searchParams.get("portalId") || undefined,
                    state: url.searchParams.get("state") || undefined,
                    type: url.searchParams.get("type") || undefined,
                    limit: Number(url.searchParams.get("limit") || 200)
                };
                return json(res, 200, { ok: true, commands: commands.list(filter), summary: commands.summary(), types: commands.TYPES, states: commands.STATES });
            }
            if (req.method === "POST" && url.pathname === "/api/portal-operations") {
                if (!canWrite(actor)) return json(res, 403, { ok: false, error: "Permission denied." });
                if (!csrfAccepted(req, config)) return json(res, 403, { ok: false, error: "CSRF validation failed." });
                const body = await readBody(req);
                const portalId = String(body.portalId || "").toLowerCase();
                const type = String(body.type || "");
                const approval = approvedOperation(app, body.approvalId, portalId, type);
                if (HIGH_RISK.has(type) && !approval) {
                    return json(res, 409, { ok: false, code: "APPROVAL_REQUIRED", error: "This operation requires a new, unused operation.high-risk approval matching the exact Portal and command type." });
                }
                if (app.portalRegistry && typeof app.portalRegistry.list === "function" && !app.portalRegistry.list().some(item => item.id === portalId)) {
                    return json(res, 404, { ok: false, error: "Portal not found." });
                }
                const command = commands.enqueue(body, actor);
                if (approval && app.approvals && typeof app.approvals.markExecution === "function") {
                    app.approvals.markExecution(body.approvalId, {
                        state: "completed",
                        action: "portal.command.queued",
                        portalId: command.portalId,
                        commandType: command.type,
                        commandId: command.id,
                        executedBy: actor.identityKey || actor.username || "system"
                    });
                }
                audit(app, "portal.command_queued", actor, req, { portalId: command.portalId, commandId: command.id, type: command.type, approvalId: command.approvalId });
                return json(res, 201, { ok: true, command });
            }
            const actionMatch = url.pathname.match(/^\/api\/portal-operations\/(cmd-[a-z0-9_-]+)\/(cancel|retry)$/);
            if (req.method === "POST" && actionMatch) {
                if (!canWrite(actor)) return json(res, 403, { ok: false, error: "Permission denied." });
                if (!csrfAccepted(req, config)) return json(res, 403, { ok: false, error: "CSRF validation failed." });
                const command = actionMatch[2] === "cancel" ? commands.cancel(actionMatch[1], actor) : commands.retry(actionMatch[1], actor);
                audit(app, "portal.command_" + actionMatch[2], actor, req, { portalId: command.portalId, commandId: command.id, type: command.type });
                return json(res, 200, { ok: true, command });
            }
            return json(res, 404, { ok: false, error: "Not found." });
        } catch (error) {
            if (!res.headersSent) return json(res, error.statusCode || 400, { ok: false, code: error.code || "REQUEST_REJECTED", error: error.message || "Request failed." });
            res.destroy(error);
        }
    });
    server.on("upgrade", (req, socket, head) => app.server.emit("upgrade", req, socket, head));
    return Object.assign({}, app, { server, version: VERSION, portalCommands: commands });
}

if (require.main === module) {
    const config = loadConfig(process.env);
    const app = createPortalOperationsRuntime(config);
    app.server.listen(config.port, config.bindHost, () => process.stdout.write("SIRK Central v14 listening on " + config.bindHost + ":" + config.port + "\n"));
}

module.exports = { createPortalOperationsRuntime, VERSION, approvedOperation, approvalAccepted, canRead, canWrite };
