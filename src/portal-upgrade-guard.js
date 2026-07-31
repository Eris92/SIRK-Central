"use strict";

const rateLimiterFactory = require("./request-rate-limiter");

function reject(socket, status, message, headers = {}) {
    const text = String(message || "Connection rejected.");
    const lines = [
        "HTTP/1.1 " + status,
        "Connection: close",
        "Content-Type: text/plain; charset=utf-8",
        "Content-Length: " + Buffer.byteLength(text),
        "X-Content-Type-Options: nosniff"
    ];
    for (const [name, value] of Object.entries(headers)) lines.push(name + ": " + value);
    try { socket.write(lines.join("\r\n") + "\r\n\r\n" + text); } catch (_) { /* socket may already be closed */ }
    socket.destroy();
    return false;
}

function allowedOrigins(config) {
    const configured = String(config.env.SIRK_PORTAL_TUNNEL_ALLOWED_ORIGINS || "")
        .split(",")
        .map(value => value.trim().replace(/\/+$/, ""))
        .filter(Boolean);
    return new Set([config.publicOrigin, ...configured].filter(Boolean));
}

function create(options) {
    const app = options.app;
    const config = options.config;
    const parseCredential = options.portalCredential;
    const requestIp = options.requestIp;
    const precondition = typeof options.precondition === "function" ? options.precondition : () => ({ ok: true });
    if (!app || typeof parseCredential !== "function" || typeof requestIp !== "function") {
        throw new Error("Portal upgrade guard dependencies are required.");
    }
    const preAuth = rateLimiterFactory.create({
        limit: Number(config.env.SIRK_PORTAL_TUNNEL_AUTH_RATE_LIMIT || 60),
        windowMs: Number(config.env.SIRK_PORTAL_TUNNEL_AUTH_RATE_WINDOW_MS || 60000),
        maxEntries: Number(config.env.SIRK_PORTAL_RATE_LIMIT_MAX_KEYS || 20000)
    });
    const perPortal = rateLimiterFactory.create({
        limit: Number(config.env.SIRK_PORTAL_TUNNEL_RATE_LIMIT || 20),
        windowMs: Number(config.env.SIRK_PORTAL_TUNNEL_RATE_WINDOW_MS || 60000),
        maxEntries: Number(config.env.SIRK_PORTAL_RATE_LIMIT_MAX_KEYS || 20000)
    });
    const origins = allowedOrigins(config);

    function handle(req, socket, head, forward) {
        let url;
        try { url = new URL(req.url, "http://central.local"); }
        catch (_) { return reject(socket, "400 Bad Request", "Invalid request."); }
        if (req.method !== "GET" || url.pathname !== "/tunnel" || url.search || url.hash) {
            return reject(socket, "404 Not Found", "Not found.");
        }
        if (String(req.headers.upgrade || "").toLowerCase() !== "websocket"
            || !String(req.headers.connection || "").toLowerCase().split(",").map(value => value.trim()).includes("upgrade")
            || String(req.headers["sec-websocket-version"] || "") !== "13") {
            return reject(socket, "400 Bad Request", "Invalid WebSocket upgrade.");
        }
        if (Buffer.isBuffer(head) && head.length > 4096) return reject(socket, "413 Payload Too Large", "Upgrade payload is too large.");
        const origin = String(req.headers.origin || "").replace(/\/+$/, "");
        if (origin && !origins.has(origin)) return reject(socket, "403 Forbidden", "Origin rejected.");

        const prerequisite = precondition(req);
        if (!prerequisite || prerequisite.ok !== true) {
            return reject(socket, "503 Service Unavailable", "Portal tunnels are temporarily unavailable.", { "Retry-After": String(prerequisite && prerequisite.retryAfterSeconds || 60) });
        }

        const ipResult = preAuth.consume("ip:" + requestIp(req, config));
        if (!ipResult.allowed) return reject(socket, "429 Too Many Requests", "Too many connection attempts.", { "Retry-After": String(ipResult.retryAfterSeconds) });

        const credential = parseCredential(req);
        const portal = credential && app.portalRegistry && app.portalRegistry.authenticate(credential.id, credential.token);
        if (!portal) return reject(socket, "401 Unauthorized", "Portal authentication failed.");

        const portalResult = perPortal.consume("portal:" + portal.id);
        if (!portalResult.allowed) return reject(socket, "429 Too Many Requests", "Too many Portal tunnel connections.", { "Retry-After": String(portalResult.retryAfterSeconds) });

        forward(req, socket, head);
        return true;
    }

    return { handle, allowedOrigins: origins };
}

module.exports = { create, reject, allowedOrigins };
