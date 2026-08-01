"use strict";

const crypto = require("node:crypto");
const http = require("node:http");

const STATIC_PATHS = new Set(["/status", "/run", "/backup/status", "/backup/run", "/backup/restore", "/backup/encrypted/restore", "/appliance/status"]);

function safeEqual(left, right) {
    const a = Buffer.from(String(left || ""));
    const b = Buffer.from(String(right || ""));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function authorized(req, token) {
    const match = String(req.headers.authorization || "").match(/^Bearer ([A-Za-z0-9_-]{43,512})$/);
    return Boolean(match && safeEqual(match[1], token));
}
function pathAllowed(requestPath) {
    const value = String(requestPath || "");
    if (!value || value.length > 512 || !value.startsWith("/") || value.includes("?") || value.includes("#")) return false;
    let decoded;
    try { decoded = decodeURIComponent(value); }
    catch (_) { return false; }
    if (STATIC_PATHS.has(decoded)) return true;
    if (/^\/backup\/file\/sirk-central-\d{8}T\d{6}Z\.tar\.gz\.age$/.test(decoded)) return true;
    return /^\/backup\/sirk-central-\d{8}T\d{6}(?:Z|[+-]\d{4})\.tar\.gz$/.test(decoded);
}
function workerOrigin(value, allowedHosts) {
    let origin;
    try { origin = new URL(String(value || "http://updater:8090")); }
    catch (_) { throw new Error("Updater worker origin is invalid."); }
    const hosts = new Set(String(allowedHosts || "updater").split(",").map(item => item.trim().toLowerCase()).filter(Boolean));
    if (origin.protocol !== "http:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash || !hosts.has(origin.hostname.toLowerCase())) {
        throw new Error("Updater worker origin is not allowed.");
    }
    return origin.origin;
}
function securityHeaders() {
    return {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
        "Referrer-Policy": "no-referrer",
        "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'"
    };
}
function sendJson(res, status, body, headers = {}) {
    const data = Buffer.from(JSON.stringify(body));
    res.writeHead(status, Object.assign(securityHeaders(), {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": String(data.length)
    }, headers));
    res.end(data);
}
function sendBuffer(res, status, data, contentType, headers = {}) {
    res.writeHead(status, Object.assign(securityHeaders(), {
        "Content-Type": contentType || "application/json; charset=utf-8",
        "Content-Length": String(data.length)
    }, headers));
    res.end(data);
}
function readRawBody(req, limit) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        let settled = false;
        req.on("data", chunk => {
            if (settled) return;
            size += chunk.length;
            if (size > limit) {
                settled = true;
                reject(Object.assign(new Error("Request body is too large."), { statusCode: 413, code: "REQUEST_TOO_LARGE" }));
                req.resume();
            } else chunks.push(chunk);
        });
        req.on("end", () => { if (!settled) resolve(Buffer.concat(chunks)); });
        req.on("error", error => { if (!settled) reject(error); });
    });
}
function maintenanceRequired(res) {
    return sendJson(res, 409, {
        ok: false,
        code: "UPDATER_MAINTENANCE_REQUIRED",
        error: "Updater appliance worker is unavailable."
    });
}

function createGateway(options = {}) {
    const bindHost = String(options.bindHost || "0.0.0.0");
    const port = Number(options.port || 8092);
    const token = String(options.token || "");
    const origin = workerOrigin(options.workerOrigin || "http://updater:8090", options.allowedWorkerHosts || "updater");
    const fetchImpl = options.fetchImpl || global.fetch;
    const timeoutMs = Math.max(1000, Math.min(120000, Number(options.timeoutMs || 35000)));
    const maxBodyBytes = Math.max(8192, Math.min(16 * 1024 * 1024, Number(options.maxBodyBytes || 2 * 1024 * 1024)));

    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Updater gateway port is invalid.");
    if (token.length < 43) throw new Error("SIRK_UPDATER_TOKEN must contain at least 43 characters.");
    if (typeof fetchImpl !== "function") throw new Error("Updater gateway fetch implementation is unavailable.");

    const server = http.createServer(async (req, res) => {
        try {
            const url = new URL(req.url, "http://updater-gateway.local");
            if (req.method === "GET" && url.pathname === "/healthz") {
                return sendJson(res, 200, { ok: true, service: "updater-gateway", worker: "appliance-internal" });
            }
            if (!authorized(req, token)) return sendJson(res, 404, { ok: false, error: "Not found." });
            if (!["GET", "POST", "DELETE"].includes(req.method) || !pathAllowed(url.pathname)) {
                return sendJson(res, 404, { ok: false, error: "Not found." });
            }

            const body = ["POST", "DELETE"].includes(req.method) ? await readRawBody(req, maxBodyBytes) : undefined;
            let response;
            try {
                response = await fetchImpl(origin + url.pathname, {
                    method: req.method,
                    headers: {
                        Authorization: "Bearer " + token,
                        "Content-Type": "application/json",
                        Accept: req.method === "GET" && url.pathname.startsWith("/backup/file/") ? "application/octet-stream" : "application/json"
                    },
                    body: body && body.length ? body : undefined,
                    signal: AbortSignal.timeout(timeoutMs)
                });
            } catch (error) {
                if (options.onWorkerUnavailable) options.onWorkerUnavailable(error);
                return maintenanceRequired(res);
            }

            const responseBody = Buffer.from(await response.arrayBuffer());
            const retryAfter = response.headers.get("retry-after");
            const disposition = response.headers.get("content-disposition");
            const passthrough = {};
            if (retryAfter) passthrough["Retry-After"] = retryAfter;
            if (disposition) passthrough["Content-Disposition"] = disposition;
            return sendBuffer(res, response.status, responseBody, response.headers.get("content-type") || "application/json; charset=utf-8", passthrough);
        } catch (error) {
            const status = Number.isInteger(error.statusCode) ? error.statusCode : 500;
            return sendJson(res, status, {
                ok: false,
                code: error.code || (status >= 500 ? "INTERNAL_ERROR" : "REQUEST_REJECTED"),
                error: status >= 500 ? "Internal gateway error." : error.message
            });
        }
    });
    server.requestTimeout = 45000;
    server.headersTimeout = 10000;
    server.keepAliveTimeout = 5000;
    return { server, bindHost, port, workerOrigin: origin };
}

if (require.main === module) {
    const gateway = createGateway({
        bindHost: process.env.SIRK_UPDATER_GATEWAY_BIND_HOST || "0.0.0.0",
        port: Number(process.env.SIRK_UPDATER_GATEWAY_PORT || 8092),
        token: process.env.SIRK_UPDATER_TOKEN,
        workerOrigin: process.env.SIRK_UPDATER_WORKER_ORIGIN || "http://updater:8090",
        allowedWorkerHosts: process.env.SIRK_UPDATER_WORKER_ALLOWED_HOSTS || "updater",
        timeoutMs: Number(process.env.SIRK_UPDATER_GATEWAY_TIMEOUT_MS || 35000),
        maxBodyBytes: Number(process.env.SIRK_UPDATER_GATEWAY_MAX_BODY_BYTES || 2 * 1024 * 1024)
    });
    gateway.server.listen(gateway.port, gateway.bindHost, () => {
        process.stdout.write("SIRK updater gateway listening on " + gateway.bindHost + ":" + gateway.port + "\n");
    });
}

module.exports = { createGateway, authorized, pathAllowed, workerOrigin, maintenanceRequired };
