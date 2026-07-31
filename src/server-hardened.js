"use strict";

const http = require("node:http");
const oldServer = require("./server");
const organizationStoreFactory = require("./organization-store");
const { PersistentSessionMap } = require("./persistent-session-map");

function parseCookies(req) {
    const result = {};
    for (const part of String(req.headers.cookie || "").split(";")) {
        const index = part.indexOf("=");
        if (index > 0) result[part.slice(0, index).trim()] = part.slice(index + 1).trim();
    }
    return result;
}
function readBody(req, limit) {
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
        req.on("end", () => {
            try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
            catch (_) { reject(Object.assign(new Error("Invalid JSON body."), { statusCode: 400 })); }
        });
        req.on("error", reject);
    });
}
function sendJson(res, status, body) {
    const data = Buffer.from(JSON.stringify(body));
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": String(data.length), "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    res.end(data);
}
function cloneRequest(req, url, method) {
    const clone = Object.create(req);
    Object.defineProperty(clone, "url", { value: url, writable: true, configurable: true });
    Object.defineProperty(clone, "method", { value: method || req.method, writable: true, configurable: true });
    return clone;
}
async function capture(handler, req) {
    let statusCode = 200;
    const headers = {};
    const chunks = [];
    let resolveFinished;
    const finished = new Promise(resolve => { resolveFinished = resolve; });
    const response = {
        statusCode: 200, headersSent: false, writableEnded: false,
        setHeader(name, value) { headers[String(name).toLowerCase()] = value; },
        getHeader(name) { return headers[String(name).toLowerCase()]; },
        removeHeader(name) { delete headers[String(name).toLowerCase()]; },
        writeHead(status, reasonOrHeaders, possibleHeaders) {
            statusCode = Number(status) || 200;
            this.statusCode = statusCode;
            const supplied = typeof reasonOrHeaders === "object" ? reasonOrHeaders : possibleHeaders;
            if (supplied) for (const [name, value] of Object.entries(supplied)) headers[String(name).toLowerCase()] = value;
            this.headersSent = true;
            return this;
        },
        write(chunk) { if (chunk !== undefined) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))); return true; },
        end(chunk) { if (chunk !== undefined) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))); this.writableEnded = true; resolveFinished(); },
        on() { return this; }, once() { return this; }, emit() { return false; }
    };
    await Promise.resolve(handler(req, response));
    if (!response.writableEnded) await finished;
    return { statusCode, headers, body: Buffer.concat(chunks) };
}
async function readIdentity(handler, req) {
    const result = await capture(handler, cloneRequest(req, "/api/session", "GET"));
    if (result.statusCode !== 200) return null;
    try { return JSON.parse(result.body.toString("utf8")); } catch (_) { return null; }
}
function hasPermission(identity, permission) {
    const permissions = identity && Array.isArray(identity.permissions) ? identity.permissions : [];
    return permissions.includes("*") || permissions.includes(permission);
}
function createApp(config) {
    const NativeMap = global.Map;
    const persistentSessions = new PersistentSessionMap({
        dataDir: config.dataDir,
        idleMinutes: Number(config.env && config.env.SIRK_SESSION_IDLE_MINUTES || 30),
        absoluteHours: Number(config.sessionHours || 8)
    });
    let createdMaps = 0;
    class SessionAwareMap extends NativeMap {
        constructor(...args) {
            super();
            createdMaps += 1;
            if (createdMaps === 1) return persistentSessions;
            return new NativeMap(...args);
        }
    }
    let app;
    global.Map = SessionAwareMap;
    try { app = oldServer.createApp(config); }
    finally { global.Map = NativeMap; }
    const oldHandler = app.server.listeners("request")[0];
    const organizationStore = organizationStoreFactory.create({ dataDir: config.dataDir });
    const server = http.createServer(async (req, res) => {
        try {
            const url = new URL(req.url, "http://central.local");
            if (url.pathname.startsWith("/api/organizations")) {
                const identity = await readIdentity(oldHandler, req);
                if (!identity) return sendJson(res, 401, { ok: false, error: "Authentication required." });
                const canRead = hasPermission(identity, "settings.read") || hasPermission(identity, "settings.manage");
                const canWrite = hasPermission(identity, "settings.manage");
                if (req.method === "GET" && url.pathname === "/api/organizations") {
                    if (!canRead) return sendJson(res, 403, { ok: false, error: "Permission denied." });
                    return sendJson(res, 200, { ok: true, organizations: organizationStore.list(), tree: organizationStore.tree() });
                }
                if (req.method === "POST" && url.pathname === "/api/organizations/tenants") {
                    if (!canWrite) return sendJson(res, 403, { ok: false, error: "Permission denied." });
                    const tenant = organizationStore.createTenant(await readBody(req, 32768), identity);
                    app.securityCenter.audit("organization.tenant.created", identity, { tenantId: tenant.id });
                    return sendJson(res, 201, { ok: true, tenant });
                }
                if (req.method === "POST" && url.pathname === "/api/organizations/customers") {
                    if (!canWrite) return sendJson(res, 403, { ok: false, error: "Permission denied." });
                    const customer = organizationStore.createCustomer(await readBody(req, 32768), identity);
                    app.securityCenter.audit("organization.customer.created", identity, { tenantId: customer.tenantId, customerId: customer.id });
                    return sendJson(res, 201, { ok: true, customer });
                }
                if (req.method === "POST" && url.pathname === "/api/organizations/sites") {
                    if (!canWrite) return sendJson(res, 403, { ok: false, error: "Permission denied." });
                    const site = organizationStore.createSite(await readBody(req, 32768), identity);
                    app.securityCenter.audit("organization.site.created", identity, { tenantId: site.tenantId, customerId: site.customerId, siteId: site.id });
                    return sendJson(res, 201, { ok: true, site });
                }
                const match = url.pathname.match(/^\/api\/organizations\/(tenant|customer|site)s\/([a-z0-9_-]+)$/);
                if (match && req.method === "PATCH") {
                    if (!canWrite) return sendJson(res, 403, { ok: false, error: "Permission denied." });
                    const body = await readBody(req, 16384);
                    const result = organizationStore.setStatus(match[1], match[2], body.status, identity);
                    app.securityCenter.audit("organization." + match[1] + ".status", identity, { id: match[2], status: body.status });
                    return sendJson(res, 200, { ok: true, result });
                }
                if (match && req.method === "DELETE") {
                    if (!canWrite) return sendJson(res, 403, { ok: false, error: "Permission denied." });
                    const result = organizationStore.remove(match[1], match[2], identity);
                    app.securityCenter.audit("organization." + match[1] + ".deleted", identity, { id: match[2] });
                    return sendJson(res, 200, { ok: true, result });
                }
                return sendJson(res, 404, { ok: false, error: "Not found." });
            }
            const rotatesBreakGlass = req.method === "POST" && (url.pathname === "/api/break-glass/password" || url.pathname === "/api/break-glass/access");
            if (rotatesBreakGlass) {
                const originalWriteHead = res.writeHead.bind(res);
                const originalEnd = res.end.bind(res);
                let statusCode = 200;
                res.writeHead = function (status, ...args) { statusCode = Number(status) || 200; return originalWriteHead(status, ...args); };
                res.end = function (...args) {
                    const result = originalEnd(...args);
                    if (statusCode >= 200 && statusCode < 300) {
                        const currentToken = parseCookies(req).sirk_central_session || "";
                        const count = persistentSessions.revokeWhere(record => record.builtIn === true && record.role === "BreakGlass", currentToken);
                        app.securityCenter.audit("breakglass.sessions.revoked", null, { count, reason: url.pathname });
                    }
                    return result;
                };
            }
            return oldHandler(req, res);
        } catch (error) {
            if (!res.headersSent) return sendJson(res, error.statusCode || 400, { ok: false, error: error.message || "Internal server error." });
            res.destroy(error);
        }
    });
    server.on("upgrade", (req, socket, head) => app.server.emit("upgrade", req, socket, head));
    return Object.assign({}, app, { server, sessionStore: persistentSessions, organizationStore });
}
module.exports = { loadConfig: oldServer.loadConfig, createApp };
