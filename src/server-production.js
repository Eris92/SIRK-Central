"use strict";

const http = require("node:http");
const hardened = require("./server-hardened");
const approvalStoreFactory = require("./approval-store");

function cloneRequest(req, url, method) {
    const clone = Object.create(req);
    Object.defineProperty(clone, "url", { value: url, writable: true, configurable: true });
    Object.defineProperty(clone, "method", { value: method || req.method, writable: true, configurable: true });
    return clone;
}
async function capture(handler, req) {
    let statusCode = 200;
    const chunks = [];
    let resolveFinished;
    const finished = new Promise(resolve => { resolveFinished = resolve; });
    const response = {
        headersSent: false, writableEnded: false,
        setHeader() {}, getHeader() {}, removeHeader() {},
        writeHead(status) { statusCode = Number(status) || 200; this.headersSent = true; return this; },
        write(chunk) { if (chunk !== undefined) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))); return true; },
        end(chunk) { if (chunk !== undefined) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))); this.writableEnded = true; resolveFinished(); },
        on() { return this; }, once() { return this; }, emit() { return false; }
    };
    await Promise.resolve(handler(req, response));
    if (!response.writableEnded) await finished;
    return { statusCode, body: Buffer.concat(chunks) };
}
async function identity(handler, req) {
    const result = await capture(handler, cloneRequest(req, "/api/session", "GET"));
    if (result.statusCode !== 200) return null;
    try { return JSON.parse(result.body.toString("utf8")); } catch (_) { return null; }
}
function hasPermission(actor, permission) {
    const permissions = actor && Array.isArray(actor.permissions) ? actor.permissions : [];
    return permissions.includes("*") || permissions.includes(permission);
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
function createApp(config) {
    const app = hardened.createApp(config);
    const oldHandler = app.server.listeners("request")[0];
    const approvals = approvalStoreFactory.create({ dataDir: config.dataDir });
    const server = http.createServer(async (req, res) => {
        try {
            const url = new URL(req.url, "http://central.local");
            if (!url.pathname.startsWith("/api/approvals")) return oldHandler(req, res);
            const actor = await identity(oldHandler, req);
            if (!actor) return sendJson(res, 401, { ok: false, error: "Authentication required." });
            const canRead = hasPermission(actor, "audit.read") || hasPermission(actor, "users.manage") || hasPermission(actor, "security.manage");
            const canReview = hasPermission(actor, "users.manage") || hasPermission(actor, "security.manage");
            if (req.method === "GET" && url.pathname === "/api/approvals") {
                if (!canRead) return sendJson(res, 403, { ok: false, error: "Permission denied." });
                return sendJson(res, 200, { ok: true, requests: approvals.list({ state: url.searchParams.get("state") || undefined, type: url.searchParams.get("type") || undefined }), types: approvals.TYPES, states: approvals.STATES });
            }
            if (req.method === "POST" && url.pathname === "/api/approvals") {
                if (!canRead) return sendJson(res, 403, { ok: false, error: "Permission denied." });
                const request = approvals.submit(await readBody(req, 65536), actor);
                app.securityCenter.audit("approval.requested", actor, { approvalId: request.id, type: request.type, requiredApprovals: request.requiredApprovals });
                return sendJson(res, 201, { ok: true, request });
            }
            const match = url.pathname.match(/^\/api\/approvals\/(apr-[a-z0-9_-]+)\/(approve|reject|cancel)$/);
            if (match && req.method === "POST") {
                const body = await readBody(req, 16384);
                let request;
                if (match[2] === "cancel") request = approvals.cancel(match[1], actor);
                else {
                    if (!canReview) return sendJson(res, 403, { ok: false, error: "Permission denied." });
                    request = approvals.decide(match[1], match[2], actor, body.comment);
                }
                app.securityCenter.audit("approval." + match[2], actor, { approvalId: request.id, type: request.type, state: request.state });
                return sendJson(res, 200, { ok: true, request });
            }
            return sendJson(res, 404, { ok: false, error: "Not found." });
        } catch (error) {
            if (!res.headersSent) return sendJson(res, error.statusCode || 400, { ok: false, error: error.message || "Internal server error." });
            res.destroy(error);
        }
    });
    server.on("upgrade", (req, socket, head) => app.server.emit("upgrade", req, socket, head));
    return Object.assign({}, app, { server, approvalStore: approvals });
}
module.exports = { loadConfig: hardened.loadConfig, createApp };
