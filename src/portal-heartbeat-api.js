"use strict";

const portalStoreFactory = require("./portal-store");
const telemetryStoreFactory = require("./portal-telemetry-store");
const rateLimiterFactory = require("./request-rate-limiter");
const { hasPermission } = require("./rbac");

function json(res, status, body, headers = {}) {
    const data = Buffer.from(JSON.stringify(body));
    res.writeHead(status, Object.assign({
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": String(data.length),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
        "Referrer-Policy": "no-referrer"
    }, headers));
    res.end(data);
}
function parseCookies(req) {
    const result = {};
    for (const part of String(req.headers.cookie || "").split(";")) {
        const index = part.indexOf("=");
        if (index > 0) result[part.slice(0, index).trim()] = part.slice(index + 1).trim();
    }
    return result;
}
function actorFor(app, req) {
    const token = parseCookies(req).sirk_central_session || "";
    return token && app.sessions ? app.sessions.get(token, true) : null;
}
function portalCredentials(req) {
    const authorization = String(req.headers.authorization || "");
    if (authorization.length > 8192) return null;
    const match = authorization.match(/^SIRK-Portal ([A-Za-z0-9_-]{8,8192})$/);
    if (!match) return null;
    try {
        const decoded = Buffer.from(match[1], "base64url").toString("utf8");
        const separator = decoded.indexOf(":");
        if (separator < 1 || separator > 128 || decoded.length - separator - 1 < 16) return null;
        return { id: decoded.slice(0, separator), token: decoded.slice(separator + 1) };
    } catch (_) { return null; }
}
function readRawBody(req, limit = 65536) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        let settled = false;
        req.on("data", chunk => {
            if (settled) return;
            size += chunk.length;
            if (size > limit) {
                settled = true;
                reject(Object.assign(new Error("Request body is too large."), { statusCode: 413, code: "PORTAL_BODY_TOO_LARGE" }));
                req.resume();
            } else chunks.push(chunk);
        });
        req.on("end", () => { if (!settled) resolve(Buffer.concat(chunks).toString("utf8")); });
        req.on("error", error => { if (!settled) reject(error); });
    });
}
function requestIp(req, config) {
    if (config.trustProxy) {
        const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
        if (forwarded) return forwarded.slice(0, 128);
    }
    return String(req.socket && req.socket.remoteAddress || "unknown").slice(0, 128);
}
function consumeOrReject(res, limiter, key) {
    const result = limiter.consume(key);
    if (result.allowed) return true;
    json(res, 429, { ok: false, code: "RATE_LIMITED", error: "Too many requests." }, {
        "Retry-After": String(result.retryAfterSeconds),
        "X-RateLimit-Limit": String(result.limit),
        "X-RateLimit-Remaining": "0"
    });
    return false;
}
function portalVisible(app, actor, portalId) {
    if (actor && actor.builtIn === true) return true;
    if (!actor || !app.accessStore || typeof app.accessStore.effective !== "function") return false;
    try { return app.accessStore.effective(actor, portalId).allowed === true; }
    catch (_) { return false; }
}
function create(options) {
    const app = options.app;
    const config = options.config;
    const portals = portalStoreFactory.create({ dataDir: config.dataDir });
    const telemetry = telemetryStoreFactory.create({
        dataDir: config.dataDir,
        onlineAfterMs: Number(config.env.SIRK_PORTAL_OFFLINE_AFTER_MS || 180000),
        maximumClockSkewMs: Number(config.env.SIRK_PORTAL_HEARTBEAT_SKEW_MS || 300000),
        maxNoncesPerPortal: Number(config.env.SIRK_PORTAL_HEARTBEAT_MAX_NONCES || 1000)
    });
    const preAuthLimiter = rateLimiterFactory.create({ limit: Number(config.env.SIRK_PORTAL_AUTH_RATE_LIMIT || 120), windowMs: Number(config.env.SIRK_PORTAL_AUTH_RATE_WINDOW_MS || 60000), maxEntries: Number(config.env.SIRK_PORTAL_RATE_LIMIT_MAX_KEYS || 20000) });
    const heartbeatLimiter = rateLimiterFactory.create({ limit: Number(config.env.SIRK_PORTAL_HEARTBEAT_RATE_LIMIT || 30), windowMs: Number(config.env.SIRK_PORTAL_HEARTBEAT_RATE_WINDOW_MS || 60000), maxEntries: Number(config.env.SIRK_PORTAL_RATE_LIMIT_MAX_KEYS || 20000) });
    const configLimiter = rateLimiterFactory.create({ limit: Number(config.env.SIRK_PORTAL_CONFIG_RATE_LIMIT || 120), windowMs: Number(config.env.SIRK_PORTAL_CONFIG_RATE_WINDOW_MS || 60000), maxEntries: Number(config.env.SIRK_PORTAL_RATE_LIMIT_MAX_KEYS || 20000) });
    function authenticate(req, res, route) {
        const ip = requestIp(req, config);
        if (!consumeOrReject(res, preAuthLimiter, route + ":ip:" + ip)) return { handled: true, portal: null };
        const credentials = portalCredentials(req);
        const portal = credentials && portals.authenticate(credentials.id, credentials.token);
        if (!portal) return { handled: false, portal: null, credentials: null, ip };
        return { handled: false, portal, credentials, ip };
    }
    async function handler(req, res, url) {
        if (req.method === "POST" && url.pathname === "/api/portal/v1/heartbeat") {
            const auth = authenticate(req, res, "heartbeat");
            if (auth.handled) return true;
            if (!auth.portal) return json(res, 401, { ok: false, code: "PORTAL_AUTH_INVALID", error: "Portal authentication failed." }), true;
            if (!consumeOrReject(res, heartbeatLimiter, "portal:" + auth.portal.id)) return true;
            const rawBody = await readRawBody(req);
            const accepted = telemetry.accept(auth.portal, {
                token: auth.credentials.token,
                timestamp: Number(req.headers["x-sirk-timestamp"] || 0),
                nonce: String(req.headers["x-sirk-nonce"] || ""),
                signature: String(req.headers["x-sirk-signature"] || ""),
                rawBody
            });
            if (app.auditStore && (accepted.heartbeatCount === 1 || accepted.metrics.health !== "ok" || accepted.metrics.updater.status !== "ready")) {
                app.auditStore.append({
                    action: "portal.heartbeat",
                    category: "portals",
                    result: accepted.metrics.health === "critical" || accepted.metrics.updater.status === "failed" ? "failure" : "success",
                    actor: { username: auth.portal.id, displayName: auth.portal.name, role: "Portal", source: "portal" },
                    request: { method: req.method, path: url.pathname, ip: auth.ip },
                    target: auth.portal.id,
                    details: {
                        portalVersion: accepted.metrics.portalVersion,
                        health: accepted.metrics.health,
                        agentCount: accepted.metrics.agentCount,
                        onlineAgents: accepted.metrics.onlineAgents,
                        updaterStatus: accepted.metrics.updater.status,
                        updaterChannel: accepted.metrics.updater.channel,
                        updaterTargetVersion: accepted.metrics.updater.targetVersion,
                        updaterPhase: accepted.metrics.updater.phase
                    }
                });
            }
            return json(res, 202, { ok: true, acceptedAtUtc: new Date().toISOString(), nextHeartbeatSeconds: Math.max(30, Math.floor(telemetry.onlineAfterMs / 3000)) }), true;
        }
        if (req.method === "GET" && url.pathname === "/api/portal/v1/config") {
            const auth = authenticate(req, res, "config");
            if (auth.handled) return true;
            if (!auth.portal) return json(res, 404, { ok: false, error: "Not found." }), true;
            if (!consumeOrReject(res, configLimiter, "portal:" + auth.portal.id)) return true;
            return json(res, 200, {
                ok: true, portalId: auth.portal.id, serverTimeUtc: new Date().toISOString(),
                heartbeat: { intervalSeconds: Math.max(30, Math.floor(telemetry.onlineAfterMs / 3000)), offlineAfterSeconds: Math.floor(telemetry.onlineAfterMs / 1000), maximumClockSkewSeconds: Math.floor(telemetry.maximumClockSkewMs / 1000) }
            }), true;
        }
        if (req.method === "GET" && url.pathname === "/api/portal-telemetry") {
            const actor = actorFor(app, req);
            const allowed = actor && (actor.builtIn === true || hasPermission(actor, "portals.read") || hasPermission(actor, "settings.read"));
            if (!allowed) return json(res, actor ? 403 : 401, { ok: false, error: actor ? "Permission denied." : "Authentication required." }), true;
            const visibleRegistry = portals.list().filter(portal => portalVisible(app, actor, portal.id));
            return json(res, 200, { ok: true, portals: telemetry.list(visibleRegistry).filter(portal => portal.registered && portalVisible(app, actor, portal.id)), generatedAtUtc: new Date().toISOString() }), true;
        }
        return false;
    }
    return { handler, portals, telemetry, preAuthLimiter, heartbeatLimiter, configLimiter };
}
module.exports = { create, portalCredentials, requestIp, portalVisible };
