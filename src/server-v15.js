"use strict";

const http = require("node:http");
const { createPortalOperationsRuntime } = require("./server-v14");
const ticketStoreFactory = require("./ticket-projection-store");
const rateLimiterFactory = require("./request-rate-limiter");
const ssoCallbackFactory = require("./sso-callback-handler");
const centralOperationGuard = require("./central-operation-guard");
const auditIntegrityGuard = require("./audit-integrity-guard");
const portalUpgradeGuardFactory = require("./portal-upgrade-guard");
const runtimeLockFactory = require("./runtime-lock");
const { identityActive } = require("./rbac");
const { loadConfig } = require("./server-v1");
const { parseCookies } = require("./server-v8");

const VERSION = "1.0.0-rc.25";

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
function readBody(req, limit = 2 * 1024 * 1024) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        let settled = false;
        req.on("data", chunk => {
            if (settled) return;
            size += chunk.length;
            if (size > limit) {
                settled = true;
                reject(Object.assign(new Error("Request body is too large."), { statusCode: 413 }));
                req.resume();
            } else chunks.push(chunk);
        });
        req.on("end", () => {
            if (settled) return;
            try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
            catch (_) { reject(Object.assign(new Error("Invalid JSON body."), { statusCode: 400 })); }
        });
        req.on("error", error => { if (!settled) reject(error); });
    });
}
function actorFor(app, req) {
    const token = parseCookies(req).sirk_central_session || "";
    return token && app.sessions ? app.sessions.get(token, true) : null;
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
    const value = portalCredential(req);
    return value && app.portalRegistry && app.portalRegistry.authenticate(value.id, value.token);
}
function canRead(actor) {
    return Boolean(identityActive(actor) && (actor.builtIn === true || ["Admin", "SecAdmin", "Auditor", "OperatorL1", "SupportL2", "EngineerL3"].includes(actor.role)));
}
function canWrite(actor) {
    return Boolean(identityActive(actor) && (actor.builtIn === true || ["Admin", "SupportL2", "EngineerL3"].includes(actor.role)));
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
    const registry = app.portalRegistry && typeof app.portalRegistry.list === "function"
        ? app.portalRegistry.list()
        : app.portalStore && typeof app.portalStore.list === "function" ? app.portalStore.list() : [];
    return registry.filter(portal => portalAllowed(app, actor, portal.id)).map(portal => portal.id);
}
function portalAssignment(app, portalId) {
    const assignment = app.portalAssignments && typeof app.portalAssignments.get === "function"
        ? app.portalAssignments.get(portalId)
        : null;
    if (!assignment) {
        throw Object.assign(new Error("Portal must be assigned to an active Tenant, Customer and Site before ticket synchronization."), {
            code: "PORTAL_ASSIGNMENT_REQUIRED",
            statusCode: 409
        });
    }
    return assignment;
}
function requireKnownPortal(app, portalId) {
    const exists = app.portalRegistry && typeof app.portalRegistry.list === "function"
        && app.portalRegistry.list().some(item => item.id === portalId);
    if (!exists) throw Object.assign(new Error("Portal not found."), { code: "PORTAL_NOT_FOUND", statusCode: 404 });
}
function audit(app, action, actor, req, details, result = "success", config = {}) {
    if (!app.auditStore || typeof app.auditStore.append !== "function") return;
    app.auditStore.append({
        action,
        category: "tickets",
        result,
        actor,
        request: {
            method: req.method,
            path: req.url,
            ip: requestIp(req, config),
            userAgent: String(req.headers["user-agent"] || "")
        },
        target: details && (details.ticketId || details.portalId) || "",
        details
    });
}
function validateFilter(filter, tickets) {
    if (filter.status && !tickets.STATUSES.includes(filter.status)) throw Object.assign(new Error("Unsupported ticket status filter."), { statusCode: 400, code: "TICKET_STATUS_INVALID" });
    if (filter.priority && !tickets.PRIORITIES.includes(filter.priority)) throw Object.assign(new Error("Unsupported ticket priority filter."), { statusCode: 400, code: "TICKET_PRIORITY_INVALID" });
    if (filter.portalId && !/^[a-z0-9][a-z0-9._:-]{1,127}$/.test(filter.portalId)) throw Object.assign(new Error("Portal ID filter is invalid."), { statusCode: 400, code: "PORTAL_ID_INVALID" });
}
function eventErrorResult(index, error) {
    const status = Number.isInteger(error && error.statusCode) && error.statusCode >= 400 && error.statusCode <= 599
        ? error.statusCode
        : 500;
    return {
        index,
        rejected: true,
        status,
        retryable: status === 429 || status >= 500,
        code: error && error.code || "TICKET_EVENT_REJECTED",
        error: status < 500 ? String(error && error.message || "Ticket event was rejected.") : "Ticket event was rejected."
    };
}

function createTicketRuntime(config) {
    const lockDisabled = String(config.env.SIRK_RUNTIME_LOCK_DISABLED || "").toLowerCase() === "true";
    if (lockDisabled && String(config.env.NODE_ENV || "").toLowerCase() === "production") {
        throw Object.assign(new Error("SIRK_RUNTIME_LOCK_DISABLED is forbidden in production."), { code: "RUNTIME_LOCK_REQUIRED", statusCode: 503 });
    }
    const runtimeLock = lockDisabled ? null : runtimeLockFactory.acquire({
        dataDir: config.dataDir,
        staleMs: Number(config.env.SIRK_RUNTIME_LOCK_STALE_MS || 120000),
        heartbeatMs: Number(config.env.SIRK_RUNTIME_LOCK_HEARTBEAT_MS || 30000)
    });

    let app;
    let ssoCallback;
    let tickets;
    let preAuthLimiter;
    let ingestionLimiter;
    let upgradeGuard;
    try {
        app = createPortalOperationsRuntime(config);
        const inner = app.server.listeners("request")[0];
        if (typeof inner !== "function") throw new Error("SIRK Central v14 request handler is unavailable.");
        app.innerRequestHandler = inner;
        ssoCallback = ssoCallbackFactory.create({ app, config });
        tickets = ticketStoreFactory.create({
            dataDir: config.dataDir,
            maxTickets: Number(config.env.SIRK_TICKET_MAX_PROJECTIONS || 25000),
            maxEventIdsPerPortal: Number(config.env.SIRK_TICKET_EVENT_ID_RETENTION || 2000)
        });
        preAuthLimiter = rateLimiterFactory.create({
            limit: Number(config.env.SIRK_PORTAL_AUTH_RATE_LIMIT || 120),
            windowMs: Number(config.env.SIRK_PORTAL_AUTH_RATE_WINDOW_MS || 60000),
            maxEntries: Number(config.env.SIRK_PORTAL_RATE_LIMIT_MAX_KEYS || 20000)
        });
        ingestionLimiter = rateLimiterFactory.create({
            limit: Number(config.env.SIRK_TICKET_INGEST_RATE_LIMIT || 120),
            windowMs: Number(config.env.SIRK_TICKET_INGEST_RATE_WINDOW_MS || 60000),
            maxEntries: Number(config.env.SIRK_PORTAL_RATE_LIMIT_MAX_KEYS || 20000)
        });
        upgradeGuard = portalUpgradeGuardFactory.create({
            app,
            config,
            portalCredential,
            requestIp,
            precondition: () => auditIntegrityGuard.integrity(app)
        });
    } catch (error) {
        if (runtimeLock) runtimeLock.release();
        throw error;
    }
    const inner = app.innerRequestHandler;
    delete app.innerRequestHandler;

    function portalRequest(req, res, route) {
        if (!consumeOrReject(res, preAuthLimiter, route + ":ip:" + requestIp(req, config))) return { handled: true, portal: null };
        const portal = authenticatePortal(app, req);
        if (!portal) return { handled: false, portal: null };
        if (!consumeOrReject(res, ingestionLimiter, route + ":portal:" + portal.id)) return { handled: true, portal: null };
        return { handled: false, portal };
    }

    const server = http.createServer(async (req, res) => {
        try {
            const url = new URL(req.url, "http://central.local");
            const auditDecision = auditIntegrityGuard.evaluate(app, req, url.pathname);
            if (auditDecision.handled) return json(res, auditDecision.status, auditDecision.body);
            const operationDecision = centralOperationGuard.evaluate(actorFor(app, req), req.method, url.pathname);
            if (operationDecision.handled) return json(res, operationDecision.status, { ok: false, code: "OPERATION_ROLE_REQUIRED", error: operationDecision.error });
            if (ssoCallback.handler(req, res, url)) return;

            if (req.method === "GET" && url.pathname === "/api/portal/v1/ticket-policy") {
                const auth = portalRequest(req, res, "policy");
                if (auth.handled) return;
                if (!auth.portal) return json(res, 404, { ok: false, error: "Not found." });
                const assignment = portalAssignment(app, auth.portal.id);
                return json(res, 200, {
                    ok: true,
                    portalId: auth.portal.id,
                    assignment,
                    policy: tickets.getPolicy(auth.portal.id),
                    statuses: tickets.STATUSES,
                    priorities: tickets.PRIORITIES,
                    protocolVersion: 1
                });
            }
            if (req.method === "POST" && url.pathname === "/api/portal/v1/tickets/snapshot") {
                const auth = portalRequest(req, res, "snapshot");
                if (auth.handled) return;
                if (!auth.portal) return json(res, 404, { ok: false, error: "Not found." });
                const assignment = portalAssignment(app, auth.portal.id);
                const result = tickets.snapshot(auth.portal.id, await readBody(req), { assignment });
                audit(app, "ticket.snapshot_received", { username: auth.portal.id, source: "portal", role: "Portal", status: "active" }, req, {
                    portalId: auth.portal.id,
                    accepted: result.accepted,
                    skipped: result.skipped,
                    stale: result.stale,
                    duplicate: result.duplicate
                }, "success", config);
                return json(res, 202, { ok: true, ...result });
            }
            if (req.method === "POST" && url.pathname === "/api/portal/v1/tickets/events") {
                const auth = portalRequest(req, res, "events");
                if (auth.handled) return;
                if (!auth.portal) return json(res, 404, { ok: false, error: "Not found." });
                const assignment = portalAssignment(app, auth.portal.id);
                const body = await readBody(req, 256 * 1024);
                const explicitBatch = Object.prototype.hasOwnProperty.call(body, "events");
                if (explicitBatch && !Array.isArray(body.events)) return json(res, 400, { ok: false, code: "TICKET_EVENTS_INVALID", error: "events must be an array." });
                const events = explicitBatch ? body.events : [body];
                if (!events.length) return json(res, 400, { ok: false, code: "TICKET_EVENTS_EMPTY", error: "At least one ticket event is required." });
                if (events.length > 500) return json(res, 413, { ok: false, code: "TICKET_EVENTS_TOO_LARGE", error: "Too many ticket events." });
                const results = [];
                for (let index = 0; index < events.length; index += 1) {
                    try {
                        results.push(Object.assign({ index, rejected: false, status: 202, retryable: false }, tickets.event(auth.portal.id, events[index], { assignment })));
                    } catch (error) {
                        results.push(eventErrorResult(index, error));
                    }
                }
                for (const item of results) {
                    if (!item.rejected && item.accepted && item.ticket && ["ticket.sla_breached", "ticket.sync_failed"].includes(item.type)) {
                        audit(app, item.type, { username: auth.portal.id, source: "portal", role: "Portal", status: "active" }, req, { portalId: auth.portal.id, ticketId: item.ticket.ticketId }, "failure", config);
                    }
                }
                const rejectedItems = results.filter(item => item.rejected);
                const rejected = rejectedItems.length;
                const response = {
                    ok: rejected === 0,
                    batch: explicitBatch,
                    accepted: results.filter(item => !item.rejected && item.accepted).length,
                    duplicates: results.filter(item => !item.rejected && item.duplicate).length,
                    stale: results.filter(item => !item.rejected && item.stale).length,
                    skipped: results.filter(item => !item.rejected && !item.accepted && !item.duplicate && !item.stale).length,
                    rejected,
                    results: explicitBatch ? results : undefined
                };
                if (rejected) {
                    audit(app, "ticket.events_rejected", { username: auth.portal.id, source: "portal", role: "Portal", status: "active" }, req, {
                        portalId: auth.portal.id,
                        batch: explicitBatch,
                        rejected,
                        codes: rejectedItems.map(item => item.code)
                    }, "failure", config);
                }
                if (!explicitBatch && rejected === 1) {
                    const item = rejectedItems[0];
                    return json(res, item.status, { ok: false, code: item.code, error: item.error, retryable: item.retryable });
                }
                return json(res, rejected ? 207 : 202, response);
            }

            if (!url.pathname.startsWith("/api/tickets")) return inner(req, res);
            const actor = actorFor(app, req);
            if (!actor) return json(res, 401, { ok: false, error: "Authentication required." });

            if (req.method === "GET" && url.pathname === "/api/tickets") {
                if (!canRead(actor)) return json(res, 403, { ok: false, error: "Permission denied." });
                const portalIds = visiblePortalIds(app, actor);
                const requestedPortalId = url.searchParams.get("portalId") || undefined;
                if (requestedPortalId && !portalIds.includes(requestedPortalId)) return json(res, 403, { ok: false, error: "Permission denied." });
                const filter = {
                    portalIds,
                    portalId: requestedPortalId,
                    tenantId: url.searchParams.get("tenantId") || undefined,
                    customerId: url.searchParams.get("customerId") || undefined,
                    siteId: url.searchParams.get("siteId") || undefined,
                    status: url.searchParams.get("status") || undefined,
                    priority: url.searchParams.get("priority") || undefined,
                    search: url.searchParams.get("search") || undefined,
                    slaBreached: url.searchParams.get("slaBreached") === "true",
                    limit: Number(url.searchParams.get("limit") || 200)
                };
                validateFilter(filter, tickets);
                return json(res, 200, {
                    ok: true,
                    tickets: tickets.list(filter),
                    summary: tickets.summary(filter),
                    statuses: tickets.STATUSES,
                    priorities: tickets.PRIORITIES,
                    generatedAtUtc: new Date().toISOString()
                });
            }

            const policyMatch = url.pathname.match(/^\/api\/tickets\/policy\/([a-z0-9][a-z0-9._:-]{1,127})$/);
            if (policyMatch && req.method === "GET") {
                if (!canRead(actor) || !portalAllowed(app, actor, policyMatch[1])) return json(res, 403, { ok: false, error: "Permission denied." });
                requireKnownPortal(app, policyMatch[1]);
                portalAssignment(app, policyMatch[1]);
                return json(res, 200, { ok: true, portalId: policyMatch[1], policy: tickets.getPolicy(policyMatch[1]) });
            }
            if (policyMatch && req.method === "PUT") {
                if (!canWrite(actor) || !portalAllowed(app, actor, policyMatch[1])) return json(res, 403, { ok: false, error: "Permission denied." });
                if (!csrfAccepted(req, config)) return json(res, 403, { ok: false, error: "CSRF validation failed." });
                requireKnownPortal(app, policyMatch[1]);
                portalAssignment(app, policyMatch[1]);
                const policy = tickets.setPolicy(policyMatch[1], await readBody(req, 32768));
                audit(app, "ticket.policy_updated", actor, req, { portalId: policyMatch[1], mode: policy.mode }, "success", config);
                return json(res, 200, { ok: true, policy });
            }

            const ticketMatch = url.pathname.match(/^\/api\/tickets\/([a-z0-9][a-z0-9._:-]{1,127})\/([a-z0-9][a-z0-9._:-]{1,127})$/);
            if (ticketMatch && req.method === "GET") {
                if (!canRead(actor) || !portalAllowed(app, actor, ticketMatch[1])) return json(res, 403, { ok: false, error: "Permission denied." });
                const ticket = tickets.get(ticketMatch[1], ticketMatch[2]);
                return ticket ? json(res, 200, { ok: true, ticket }) : json(res, 404, { ok: false, error: "Ticket not found." });
            }
            if (ticketMatch && req.method === "PATCH") {
                if (!canWrite(actor) || !portalAllowed(app, actor, ticketMatch[1])) return json(res, 403, { ok: false, error: "Permission denied." });
                if (!csrfAccepted(req, config)) return json(res, 403, { ok: false, error: "CSRF validation failed." });
                const policy = tickets.getPolicy(ticketMatch[1]);
                if (!policy.allowCentralChanges) return json(res, 409, { ok: false, code: "PORTAL_POLICY_READ_ONLY", error: "Portal policy does not permit Central-side ticket changes." });
                const ticket = tickets.updateCentral(ticketMatch[1], ticketMatch[2], await readBody(req, 65536), actor);
                audit(app, "ticket.central_change", actor, req, { portalId: ticket.portalId, ticketId: ticket.ticketId, status: ticket.status }, "success", config);
                return json(res, 200, { ok: true, ticket });
            }
            return json(res, 404, { ok: false, error: "Not found." });
        } catch (error) {
            const status = Number.isInteger(error.statusCode) ? error.statusCode : 500;
            const message = status >= 500 ? "Internal server error." : error.message || "Request failed.";
            if (!res.headersSent) return json(res, status, { ok: false, code: error.code || (status >= 500 ? "INTERNAL_ERROR" : "REQUEST_REJECTED"), error: message });
            res.destroy(error);
        }
    });
    server.requestTimeout = 30000;
    server.headersTimeout = 15000;
    server.keepAliveTimeout = 5000;
    server.on("upgrade", (req, socket, head) => upgradeGuard.handle(req, socket, head, (forwardReq, forwardSocket, forwardHead) => app.server.emit("upgrade", forwardReq, forwardSocket, forwardHead)));
    server.on("close", () => { if (runtimeLock) runtimeLock.release(); });
    return Object.assign({}, app, { server, version: VERSION, ticketProjections: tickets, ssoReplay: ssoCallback.replay, runtimeLock, portalUpgradeGuard: upgradeGuard });
}

if (require.main === module) {
    const config = loadConfig(process.env);
    const app = createTicketRuntime(config);
    const shutdown = signal => {
        process.stdout.write("SIRK Central received " + signal + "; closing.\n");
        app.server.close(() => process.exit(0));
        setTimeout(() => process.exit(1), 15000).unref();
    };
    process.once("SIGTERM", () => shutdown("SIGTERM"));
    process.once("SIGINT", () => shutdown("SIGINT"));
    app.server.listen(config.port, config.bindHost, () => process.stdout.write("SIRK Central v15 listening on " + config.bindHost + ":" + config.port + "\n"));
}

module.exports = { createTicketRuntime, VERSION, canRead, canWrite, portalAllowed, visiblePortalIds, portalAssignment, validateFilter, eventErrorResult };
