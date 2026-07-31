"use strict";

const portalStoreFactory = require("./portal-store");
const telemetryStoreFactory = require("./portal-telemetry-store");
const { hasPermission } = require("./rbac");

function json(res, status, body) {
    const data = Buffer.from(JSON.stringify(body));
    res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": String(data.length),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff"
    });
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
    const match = String(req.headers.authorization || "").match(/^SIRK-Portal ([A-Za-z0-9_-]+)$/);
    if (!match) return null;
    try {
        const decoded = Buffer.from(match[1], "base64url").toString("utf8");
        const separator = decoded.indexOf(":");
        return separator < 1 ? null : { id: decoded.slice(0, separator), token: decoded.slice(separator + 1) };
    } catch (_) { return null; }
}

function readRawBody(req, limit = 65536) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on("data", chunk => {
            size += chunk.length;
            if (size > limit) {
                reject(Object.assign(new Error("Request body is too large."), { statusCode: 413 }));
                req.destroy();
            } else chunks.push(chunk);
        });
        req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        req.on("error", reject);
    });
}

function create(options) {
    const app = options.app;
    const config = options.config;
    const portals = portalStoreFactory.create({ dataDir: config.dataDir });
    const telemetry = telemetryStoreFactory.create({
        dataDir: config.dataDir,
        onlineAfterMs: Number(config.env.SIRK_PORTAL_OFFLINE_AFTER_MS || 180000),
        maximumClockSkewMs: Number(config.env.SIRK_PORTAL_HEARTBEAT_SKEW_MS || 300000)
    });

    async function handler(req, res, url) {
        if (req.method === "POST" && url.pathname === "/api/portal/v1/heartbeat") {
            const credentials = portalCredentials(req);
            const portal = credentials && portals.authenticate(credentials.id, credentials.token);
            if (!portal) return json(res, 401, { ok: false, code: "PORTAL_AUTH_INVALID", error: "Portal authentication failed." });
            const rawBody = await readRawBody(req);
            const accepted = telemetry.accept(portal, {
                token: credentials.token,
                timestamp: Number(req.headers["x-sirk-timestamp"] || 0),
                nonce: String(req.headers["x-sirk-nonce"] || ""),
                signature: String(req.headers["x-sirk-signature"] || ""),
                rawBody
            });
            if (app.auditStore && (accepted.heartbeatCount === 1 || accepted.metrics.health !== "ok")) {
                app.auditStore.append({
                    action: "portal.heartbeat",
                    category: "portals",
                    result: accepted.metrics.health === "critical" ? "failure" : "success",
                    actor: { username: portal.id, displayName: portal.name, role: "Portal", source: "portal" },
                    request: { method: req.method, path: url.pathname },
                    target: portal.id,
                    details: {
                        portalVersion: accepted.metrics.portalVersion,
                        health: accepted.metrics.health,
                        agentCount: accepted.metrics.agentCount,
                        onlineAgents: accepted.metrics.onlineAgents
                    }
                });
            }
            return json(res, 202, {
                ok: true,
                acceptedAtUtc: new Date().toISOString(),
                nextHeartbeatSeconds: Math.max(30, Math.floor(telemetry.onlineAfterMs / 3000))
            });
        }

        if (req.method === "GET" && url.pathname === "/api/portal/v1/config") {
            const credentials = portalCredentials(req);
            const portal = credentials && portals.authenticate(credentials.id, credentials.token);
            if (!portal) return json(res, 404, { ok: false, error: "Not found." });
            return json(res, 200, {
                ok: true,
                portalId: portal.id,
                serverTimeUtc: new Date().toISOString(),
                heartbeat: {
                    intervalSeconds: Math.max(30, Math.floor(telemetry.onlineAfterMs / 3000)),
                    offlineAfterSeconds: Math.floor(telemetry.onlineAfterMs / 1000),
                    maximumClockSkewSeconds: Math.floor(telemetry.maximumClockSkewMs / 1000)
                }
            });
        }

        if (req.method === "GET" && url.pathname === "/api/portal-telemetry") {
            const actor = actorFor(app, req);
            const allowed = actor && (actor.builtIn === true || hasPermission(actor, "portals.read") || hasPermission(actor, "settings.read"));
            if (!allowed) return json(res, actor ? 403 : 401, { ok: false, error: actor ? "Permission denied." : "Authentication required." });
            return json(res, 200, { ok: true, portals: telemetry.list(portals.list()), generatedAtUtc: new Date().toISOString() });
        }

        return false;
    }

    return { handler, portals, telemetry };
}

module.exports = { create, portalCredentials };
