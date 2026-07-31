"use strict";

const http = require("node:http");
const { createPortalOperationsRuntime } = require("./server-v14");
const ticketStoreFactory = require("./ticket-projection-store");
const { loadConfig } = require("./server-v1");
const { parseCookies } = require("./server-v8");

const VERSION = "1.0.0-rc.19";

function json(res, status, body) {
    const data = Buffer.from(JSON.stringify(body));
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": String(data.length), "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer" });
    res.end(data);
}
function readBody(req, limit = 2 * 1024 * 1024) {
    return new Promise((resolve, reject) => {
        const chunks = []; let size = 0;
        req.on("data", chunk => { size += chunk.length; if (size > limit) { reject(Object.assign(new Error("Request body is too large."), { statusCode: 413 })); req.destroy(); } else chunks.push(chunk); });
        req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); } catch (_) { reject(Object.assign(new Error("Invalid JSON body."), { statusCode: 400 })); } });
        req.on("error", reject);
    });
}
function actorFor(app, req) { const token = parseCookies(req).sirk_central_session || ""; return token && app.sessions ? app.sessions.get(token, true) : null; }
function portalCredential(req) {
    const match = String(req.headers.authorization || "").match(/^SIRK-Portal ([A-Za-z0-9_-]+)$/); if (!match) return null;
    try { const decoded = Buffer.from(match[1], "base64url").toString("utf8"); const index = decoded.indexOf(":"); return index < 1 ? null : { id: decoded.slice(0, index), token: decoded.slice(index + 1) }; } catch (_) { return null; }
}
function authenticatePortal(app, req) { const value = portalCredential(req); return value && app.portalRegistry && app.portalRegistry.authenticate(value.id, value.token); }
function canRead(actor) { return Boolean(actor && (actor.builtIn === true || ["Admin", "SecAdmin", "Auditor", "OperatorL1", "SupportL2", "EngineerL3"].includes(actor.role))); }
function canWrite(actor) { return Boolean(actor && (actor.builtIn === true || ["Admin", "SecAdmin", "SupportL2", "EngineerL3"].includes(actor.role))); }
function csrfAccepted(req, config) {
    const cookies = parseCookies(req); const cookie = String(cookies.sirk_central_csrf || ""); const supplied = String(req.headers["x-sirk-csrf"] || "");
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(cookie) || supplied !== cookie) return false;
    const origin = String(req.headers.origin || ""); if (origin && origin !== config.publicOrigin) return false;
    const site = String(req.headers["sec-fetch-site"] || ""); return !site || site === "same-origin" || site === "none";
}
function audit(app, action, actor, req, details, result = "success") {
    if (!app.auditStore || typeof app.auditStore.append !== "function") return;
    app.auditStore.append({ action, category: "tickets", result, actor, request: { method: req.method, path: req.url, ip: String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim(), userAgent: String(req.headers["user-agent"] || "") }, target: details && (details.ticketId || details.portalId) || "", details });
}

function createTicketRuntime(config) {
    const app = createPortalOperationsRuntime(config);
    const inner = app.server.listeners("request")[0];
    if (typeof inner !== "function") throw new Error("SIRK Central v14 request handler is unavailable.");
    const tickets = ticketStoreFactory.create({ dataDir: config.dataDir, maxTickets: Number(config.env.SIRK_TICKET_MAX_PROJECTIONS || 25000) });
    const server = http.createServer(async (req, res) => {
        try {
            const url = new URL(req.url, "http://central.local");
            if (req.method === "GET" && url.pathname === "/api/portal/v1/ticket-policy") {
                const portal = authenticatePortal(app, req); if (!portal) return json(res, 404, { ok: false, error: "Not found." });
                return json(res, 200, { ok: true, portalId: portal.id, policy: tickets.getPolicy(portal.id), statuses: tickets.STATUSES, priorities: tickets.PRIORITIES, protocolVersion: 1 });
            }
            if (req.method === "POST" && url.pathname === "/api/portal/v1/tickets/snapshot") {
                const portal = authenticatePortal(app, req); if (!portal) return json(res, 404, { ok: false, error: "Not found." });
                const result = tickets.snapshot(portal.id, await readBody(req));
                audit(app, "ticket.snapshot_received", { username: portal.id, source: "portal", role: "Portal" }, req, { portalId: portal.id, accepted: result.accepted });
                return json(res, 202, { ok: true, ...result });
            }
            if (req.method === "POST" && url.pathname === "/api/portal/v1/tickets/events") {
                const portal = authenticatePortal(app, req); if (!portal) return json(res, 404, { ok: false, error: "Not found." });
                const body = await readBody(req, 256 * 1024); const events = Array.isArray(body.events) ? body.events : [body];
                if (events.length > 500) return json(res, 413, { ok: false, error: "Too many ticket events." });
                const accepted = events.map(item => tickets.event(portal.id, item));
                for (const item of accepted) if (["ticket.sla_breached", "ticket.sync_failed"].includes(item.type)) audit(app, item.type, { username: portal.id, source: "portal", role: "Portal" }, req, { portalId: portal.id, ticketId: item.ticket.ticketId }, "failure");
                return json(res, 202, { ok: true, accepted: accepted.length });
            }
            if (!url.pathname.startsWith("/api/tickets")) return inner(req, res);
            const actor = actorFor(app, req); if (!actor) return json(res, 401, { ok: false, error: "Authentication required." });
            if (req.method === "GET" && url.pathname === "/api/tickets") {
                if (!canRead(actor)) return json(res, 403, { ok: false, error: "Permission denied." });
                const filter = { portalId: url.searchParams.get("portalId") || undefined, tenantId: url.searchParams.get("tenantId") || undefined, siteId: url.searchParams.get("siteId") || undefined, status: url.searchParams.get("status") || undefined, priority: url.searchParams.get("priority") || undefined, search: url.searchParams.get("search") || undefined, slaBreached: url.searchParams.get("slaBreached") === "true", limit: Number(url.searchParams.get("limit") || 200) };
                return json(res, 200, { ok: true, tickets: tickets.list(filter), summary: tickets.summary(), statuses: tickets.STATUSES, priorities: tickets.PRIORITIES, generatedAtUtc: new Date().toISOString() });
            }
            const policyMatch = url.pathname.match(/^\/api\/tickets\/policy\/([a-z0-9][a-z0-9._:-]{1,127})$/);
            if (policyMatch && req.method === "GET") { if (!canRead(actor)) return json(res, 403, { ok: false, error: "Permission denied." }); return json(res, 200, { ok: true, portalId: policyMatch[1], policy: tickets.getPolicy(policyMatch[1]) }); }
            if (policyMatch && req.method === "PUT") {
                if (!canWrite(actor)) return json(res, 403, { ok: false, error: "Permission denied." }); if (!csrfAccepted(req, config)) return json(res, 403, { ok: false, error: "CSRF validation failed." });
                const policy = tickets.setPolicy(policyMatch[1], await readBody(req, 32768)); audit(app, "ticket.policy_updated", actor, req, { portalId: policyMatch[1], mode: policy.mode }); return json(res, 200, { ok: true, policy });
            }
            const ticketMatch = url.pathname.match(/^\/api\/tickets\/([a-z0-9][a-z0-9._:-]{1,127})\/([a-z0-9][a-z0-9._:-]{1,127})$/);
            if (ticketMatch && req.method === "GET") { if (!canRead(actor)) return json(res, 403, { ok: false, error: "Permission denied." }); const ticket = tickets.get(ticketMatch[1], ticketMatch[2]); return ticket ? json(res, 200, { ok: true, ticket }) : json(res, 404, { ok: false, error: "Ticket not found." }); }
            if (ticketMatch && req.method === "PATCH") {
                if (!canWrite(actor)) return json(res, 403, { ok: false, error: "Permission denied." }); if (!csrfAccepted(req, config)) return json(res, 403, { ok: false, error: "CSRF validation failed." });
                const policy = tickets.getPolicy(ticketMatch[1]); if (!policy.allowCentralChanges) return json(res, 409, { ok: false, code: "PORTAL_POLICY_READ_ONLY", error: "Portal policy does not permit Central-side ticket changes." });
                const ticket = tickets.updateCentral(ticketMatch[1], ticketMatch[2], await readBody(req, 65536), actor); audit(app, "ticket.central_change", actor, req, { portalId: ticket.portalId, ticketId: ticket.ticketId, status: ticket.status }); return json(res, 200, { ok: true, ticket });
            }
            return json(res, 404, { ok: false, error: "Not found." });
        } catch (error) { if (!res.headersSent) return json(res, error.statusCode || 400, { ok: false, code: error.code || "REQUEST_REJECTED", error: error.message || "Request failed." }); res.destroy(error); }
    });
    server.on("upgrade", (req, socket, head) => app.server.emit("upgrade", req, socket, head));
    return Object.assign({}, app, { server, version: VERSION, ticketProjections: tickets });
}

if (require.main === module) { const config = loadConfig(process.env); const app = createTicketRuntime(config); app.server.listen(config.port, config.bindHost, () => process.stdout.write("SIRK Central v15 listening on " + config.bindHost + ":" + config.port + "\n")); }
module.exports = { createTicketRuntime, VERSION, canRead, canWrite };
