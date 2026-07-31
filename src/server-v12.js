"use strict";

const http = require("node:http");
const { createAdminRuntime } = require("./server-v11");
const { loadConfig } = require("./server-v1");
const { parseCookies } = require("./server-v8");

const VERSION = "1.0.0-rc.16";

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
function currentToken(req) { return parseCookies(req).sirk_central_session || ""; }
function sessionActor(app, req) {
    const token = currentToken(req);
    return token && app.sessions ? app.sessions.get(token, true) : null;
}
function canManage(actor) {
    return Boolean(actor && (actor.builtIn === true || actor.role === "SecAdmin" || actor.role === "Admin"));
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
function audit(app, action, actor, req, details, result = "success") {
    if (!app.auditStore || typeof app.auditStore.append !== "function") return;
    app.auditStore.append({
        action,
        category: "security",
        result,
        actor,
        request: {
            ip: String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim(),
            userAgent: String(req.headers["user-agent"] || ""),
            method: req.method,
            path: req.url
        },
        details
    });
}
function publicSession(record, currentId) {
    return {
        id: record.id,
        username: record.username || "",
        displayName: record.displayName || "",
        identityKey: record.identityKey || "",
        source: record.source || "",
        role: record.builtIn ? "BreakGlass" : record.role || "",
        builtIn: Boolean(record.builtIn),
        ip: record.ip || "",
        userAgent: record.userAgent || "",
        createdAtUtc: new Date(record.createdAt).toISOString(),
        lastSeenAtUtc: new Date(record.lastSeenAt).toISOString(),
        idleExpiresAtUtc: new Date(record.idleExpiresAt).toISOString(),
        absoluteExpiresAtUtc: new Date(record.absoluteExpiresAt).toISOString(),
        current: record.id === currentId
    };
}

function createSecurityRuntime(config) {
    const app = createAdminRuntime(config);
    const inner = app.server.listeners("request")[0];
    if (typeof inner !== "function") throw new Error("SIRK Central v11 request handler is unavailable.");

    const server = http.createServer(async (req, res) => {
        try {
            const url = new URL(req.url, "http://central.local");
            const actor = sessionActor(app, req);
            if (req.method === "GET" && url.pathname === "/api/security/sessions") {
                if (!canManage(actor)) return json(res, 403, { ok: false, error: "Permission denied." });
                const current = actor && actor.id || "";
                const sessions = app.sessions.list().map(record => publicSession(record, current));
                return json(res, 200, { ok: true, sessions, generatedAtUtc: new Date().toISOString() });
            }
            const revokeMatch = url.pathname.match(/^\/api\/security\/sessions\/([A-Za-z0-9_-]{8,64})$/);
            if (req.method === "DELETE" && revokeMatch) {
                if (!canManage(actor)) return json(res, 403, { ok: false, error: "Permission denied." });
                if (!csrfAccepted(req, config)) return json(res, 403, { ok: false, error: "CSRF validation failed." });
                const sessionId = revokeMatch[1];
                if (sessionId === actor.id) return json(res, 409, { ok: false, error: "The current session cannot be revoked from this action." });
                const revoked = app.sessions.revokeById(sessionId);
                if (!revoked) return json(res, 404, { ok: false, error: "Session not found." });
                audit(app, "session.revoked", actor, req, { sessionId });
                return json(res, 200, { ok: true, revoked: sessionId });
            }
            if (req.method === "POST" && url.pathname === "/api/security/sessions/revoke-others") {
                if (!canManage(actor)) return json(res, 403, { ok: false, error: "Permission denied." });
                if (!csrfAccepted(req, config)) return json(res, 403, { ok: false, error: "CSRF validation failed." });
                const token = currentToken(req);
                const count = app.sessions.revokeWhere(() => true, token);
                audit(app, "session.others_revoked", actor, req, { count });
                return json(res, 200, { ok: true, revokedCount: count });
            }
            return inner(req, res);
        } catch (error) {
            if (!res.headersSent) return json(res, error.statusCode || 400, { ok: false, code: error.code || "REQUEST_REJECTED", error: error.message || "Request failed." });
            res.destroy(error);
        }
    });
    server.on("upgrade", (req, socket, head) => app.server.emit("upgrade", req, socket, head));
    return Object.assign({}, app, { server, version: VERSION });
}

if (require.main === module) {
    const config = loadConfig(process.env);
    const app = createSecurityRuntime(config);
    app.server.listen(config.port, config.bindHost, () => process.stdout.write("SIRK Central v12 listening on " + config.bindHost + ":" + config.port + "\n"));
}

module.exports = { createSecurityRuntime, VERSION };
