"use strict";

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const publicDir = path.join(root, "public");
const scripts = [
    "passkey-attestation-bridge.js",
    "passkey-ui.js",
    "passkey-ui-polish.js",
    "passkey-list-cleanup.js",
    "operations-ui.js",
    "operations-actions.js",
    "central-ux.js",
    "operations-bootstrap.js",
    "update-status-resilience.js",
    "audit-ui.js",
    "dashboard-css-loader.js",
    "dashboard-ui.js",
    "admin-tools-css-loader.js",
    "admin-tools-ui.js",
    "security-sessions-ui.js",
    "approval-center-ui.js",
    "portal-operations-ui.js",
    "portal-monitoring-ui.js",
    "tickets-ui.js"
];
const csrf = "abcdefghijklmnopqrstuvwxyzABCDEFGH12345678";
let sequence = 1;
let approvals = [{
    id: "apr-e2e",
    type: "operation.high-risk",
    state: "pending",
    title: "Test approval",
    reason: "Browser test",
    requestedBy: "other-user",
    requestedAtUtc: new Date().toISOString(),
    expiresAtUtc: new Date(Date.now() + 3600000).toISOString(),
    requiredApprovals: 1,
    decisions: [],
    scope: { portalId: "test-portal" },
    payload: { operation: "restart" },
    execution: null
}];
let commands = [];
let backups = [{ name: "sirk-central-20260731T100000+0200.tar.gz", size: 1024, createdAtUtc: new Date().toISOString() }];
let tickets = [{
    ticketId: "e2e-100",
    portalId: "test-portal",
    tenantId: "tenant-e2e",
    customerId: "customer-e2e",
    siteId: "site-e2e",
    externalSystem: "local",
    externalId: "E2E-100",
    title: "Test ticket",
    description: "Deterministic browser ticket",
    status: "new",
    priority: "high",
    category: "test",
    requester: { id: "user-e2e", displayName: "E2E User", email: "" },
    assignee: null,
    deviceId: "",
    createdAtUtc: new Date().toISOString(),
    updatedAtUtc: new Date().toISOString(),
    sourceUpdatedAtUtc: new Date().toISOString(),
    receivedAtUtc: new Date().toISOString(),
    sla: { breached: false, responseDueAtUtc: null, resolutionDueAtUtc: null },
    sync: { state: "synchronized", lastSyncAtUtc: new Date().toISOString(), lastError: "" },
    central: {}
}];
let ticketPolicy = {
    mode: "open",
    includeStatuses: [],
    includePriorities: [],
    includeDescription: true,
    includeRequester: true,
    allowCentralChanges: true
};

function securityHeaders(extra = {}) {
    return Object.assign({
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
        "Referrer-Policy": "no-referrer"
    }, extra);
}
function json(res, status, body, headers) {
    const data = Buffer.from(JSON.stringify(body));
    res.writeHead(status, securityHeaders(Object.assign({ "Content-Type": "application/json; charset=utf-8", "Content-Length": String(data.length) }, headers || {})));
    res.end(data);
}
function readBody(req, limit = 1024 * 1024) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        let settled = false;
        req.on("data", chunk => {
            if (settled) return;
            size += chunk.length;
            if (size > limit) {
                settled = true;
                reject(new Error("body too large"));
                req.resume();
            } else chunks.push(chunk);
        });
        req.on("end", () => {
            if (settled) return;
            try { resolve(JSON.parse(Buffer.concat(chunks).toString() || "{}")); }
            catch (_) { reject(new Error("invalid json")); }
        });
        req.on("error", reject);
    });
}
function staticFile(res, filePath, type, method = "GET") {
    if (!fs.existsSync(filePath)) return json(res, 404, { error: "Not found" });
    const data = fs.readFileSync(filePath);
    res.writeHead(200, securityHeaders({ "Content-Type": type, "Content-Length": String(data.length) }));
    res.end(method === "HEAD" ? undefined : data);
}
function ticketSummary(items) {
    const counts = { new: 0, accepted: 0, in_progress: 0, waiting_for_user: 0, waiting_for_external: 0, resolved: 0, closed: 0, cancelled: 0 };
    for (const item of items) counts[item.status] = (counts[item.status] || 0) + 1;
    return {
        total: items.length,
        counts,
        critical: items.filter(item => item.priority === "critical" && !["closed", "cancelled"].includes(item.status)).length,
        slaBreached: items.filter(item => item.sla && item.sla.breached).length,
        syncFailed: items.filter(item => ["failed", "conflict"].includes(item.sync && item.sync.state)).length
    };
}
function csrfAccepted(req) {
    return String(req.headers["x-sirk-csrf"] || "") === csrf;
}
function requireCsrf(req, res) {
    if (csrfAccepted(req)) return true;
    json(res, 403, { ok: false, error: "CSRF validation failed." });
    return false;
}

const server = http.createServer(async (req, res) => {
    try {
        const url = new URL(req.url, "http://127.0.0.1:4173");
        if (url.pathname === "/" || url.pathname === "/index.html") {
            res.setHeader("Set-Cookie", "sirk_central_csrf=" + csrf + "; Path=/; SameSite=Lax");
            return staticFile(res, path.join(publicDir, "index.html"), "text/html; charset=utf-8", req.method);
        }
        if (url.pathname === "/favicon.ico") return res.writeHead(204).end();
        if (url.pathname === "/passkey-ui.js") {
            const data = Buffer.from(scripts.map(name => fs.readFileSync(path.join(publicDir, name), "utf8")).join("\n"));
            res.writeHead(200, securityHeaders({ "Content-Type": "text/javascript; charset=utf-8", "Content-Length": String(data.length) }));
            return res.end(req.method === "HEAD" ? undefined : data);
        }
        if (url.pathname.endsWith(".js")) return staticFile(res, path.join(publicDir, path.basename(url.pathname)), "text/javascript; charset=utf-8", req.method);
        if (url.pathname.endsWith(".css")) return staticFile(res, path.join(publicDir, path.basename(url.pathname)), "text/css; charset=utf-8", req.method);

        if (url.pathname === "/readyz") return json(res, 200, { ok: true, version: "1.0.0-rc.21", checks: { runtime: true, security: true } });
        if (url.pathname === "/healthz") return json(res, 200, { ok: true, version: "1.0.0-rc.21" });
        if (url.pathname === "/api/session") return json(res, 200, { ok: true, username: "admin", displayName: "Administrator", source: "local", identityKey: "breakglass:admin", role: "BreakGlass", status: "active", builtIn: true, permissions: ["*"] });
        if (url.pathname === "/api/portals") return json(res, 200, { ok: true, portals: [{ id: "test-portal", name: "Test Portal", status: "online", access: { teams: [], capabilities: { "portal.connect": "allow" } } }] });
        if (url.pathname === "/api/portal-telemetry") return json(res, 200, { ok: true, portals: [{ id: "test-portal", name: "Test Portal", registered: true, status: "online", lastSeenAtUtc: new Date().toISOString(), heartbeatCount: 3, metrics: { portalVersion: "1.0.0", buildCommit: "e2e", health: "ok", agentCount: 8, onlineAgents: 7, cpuPercent: 12.5, memoryUsedBytes: 268435456, memoryTotalBytes: 1073741824, lastBackupStatus: "ok", lastBackupAtUtc: new Date().toISOString(), availableVersion: "" } }] });
        if (url.pathname === "/api/settings/roles") return json(res, 200, { ok: true, roles: ["Auditor", "OperatorL1", "SupportL2", "EngineerL3", "Admin", "SecAdmin"] });
        if (url.pathname === "/api/settings/users") return json(res, 200, { ok: true, users: [] });
        if (url.pathname === "/api/settings/identity-provider") {
            if (req.method !== "GET" && !requireCsrf(req, res)) return;
            return json(res, 200, { ok: true, editable: true, securityEditable: true, provider: { enabled: false, tenant: "organizations", clientId: "", clientSecretConfigured: false, allowedIdentities: [], redirectUri: "https://example.test/callback", logoutUrl: "https://example.test/logout" } });
        }
        if (url.pathname === "/api/settings/identity-provider/test") {
            if (!requireCsrf(req, res)) return;
            return json(res, 200, { ok: true, issuer: "https://login.microsoftonline.com/test/v2.0" });
        }
        if (url.pathname === "/api/settings/update/status") return json(res, 200, { ok: true, status: { state: "completed", running: false, startedAtUtc: new Date().toISOString(), finishedAtUtc: new Date().toISOString(), previousCommit: "11111111", targetCommit: "22222222" } });
        if (url.pathname === "/api/settings/backup/status") return json(res, 200, { ok: true, backups, restore: { state: "idle", running: false } });
        if (url.pathname === "/api/backup-management/policy") {
            if (req.method !== "GET" && !requireCsrf(req, res)) return;
            return json(res, 200, { ok: true, policy: { enabled: true, hour: 2, minute: 0, retention: 10, minimumAgeHours: 20, timeZone: "Europe/Warsaw" }, status: { nextRunAtUtc: new Date(Date.now() + 86400000).toISOString() } });
        }
        if (url.pathname === "/api/system/info") return json(res, 200, { ok: true, version: "1.0.0-rc.21", runtime: "server-v15", node: process.version, uptimeSeconds: 100, backupManager: true });
        if (url.pathname === "/api/audit" || url.pathname.startsWith("/api/audit?")) return json(res, 200, { ok: true, events: [{ id: "evt", timestampUtc: new Date().toISOString(), action: "test.event", category: "system", result: "success", actor: { username: "admin", role: "BreakGlass" }, request: { ip: "127.0.0.1" }, details: {}, hash: "hash" }], integrity: { ok: true, count: 1 } });
        if (url.pathname === "/api/security/sessions") return json(res, 200, { ok: true, sessions: [{ id: "current-session", username: "admin", displayName: "Administrator", role: "BreakGlass", source: "local", ip: "127.0.0.1", userAgent: "Playwright", createdAtUtc: new Date().toISOString(), lastSeenAtUtc: new Date().toISOString(), idleExpiresAtUtc: new Date(Date.now() + 1800000).toISOString(), absoluteExpiresAtUtc: new Date(Date.now() + 28800000).toISOString(), current: true }] });

        if (url.pathname === "/api/approval-center" && req.method === "GET") return json(res, 200, { ok: true, requests: approvals.filter(item => !url.searchParams.get("state") || item.state === url.searchParams.get("state")) });
        if (url.pathname === "/api/approval-center" && req.method === "POST") {
            if (!requireCsrf(req, res)) return;
            const input = await readBody(req);
            const request = Object.assign({ id: "apr-e2e-" + sequence++, state: "pending", requestedBy: "admin", requestedAtUtc: new Date().toISOString(), expiresAtUtc: new Date(Date.now() + 3600000).toISOString(), decisions: [], execution: null }, input);
            approvals.unshift(request);
            return json(res, 201, { ok: true, request });
        }
        const decision = url.pathname.match(/^\/api\/approval-center\/(apr-[^/]+)\/(approve|reject|cancel)$/);
        if (decision && req.method === "POST") {
            if (!requireCsrf(req, res)) return;
            const item = approvals.find(value => value.id === decision[1]);
            if (!item) return json(res, 404, { ok: false, error: "Approval request not found." });
            item.state = decision[2] === "approve" ? "approved" : decision[2] === "reject" ? "rejected" : "cancelled";
            return json(res, 200, { ok: true, request: item });
        }

        if (url.pathname === "/api/portal-operations" && req.method === "GET") return json(res, 200, { ok: true, commands, summary: { active: commands.filter(item => ["queued", "delivered", "running"].includes(item.state)).length, total: commands.length, counts: { queued: commands.filter(item => item.state === "queued").length, delivered: 0, running: 0, completed: commands.filter(item => item.state === "completed").length, failed: 0, cancelled: 0, expired: 0 } }, types: ["backup", "update", "restart", "reconnect", "sync", "diagnostics"], states: ["queued", "delivered", "running", "completed", "failed", "cancelled", "expired"] });
        if (url.pathname === "/api/portal-operations" && req.method === "POST") {
            if (!requireCsrf(req, res)) return;
            const input = await readBody(req);
            const command = Object.assign({ id: "cmd-e2e-" + sequence++, state: "queued", createdAtUtc: new Date().toISOString(), expiresAtUtc: new Date(Date.now() + 3600000).toISOString(), requestedBy: "admin", progress: 0, approvalId: "" }, input);
            commands.unshift(command);
            return json(res, 201, { ok: true, command });
        }
        if (url.pathname.startsWith("/api/portal-operations/") && req.method === "POST") {
            if (!requireCsrf(req, res)) return;
            const match = url.pathname.match(/^\/api\/portal-operations\/([^/]+)\/(cancel|retry)$/);
            const source = match && commands.find(item => item.id === match[1]);
            if (!source) return json(res, 404, { ok: false, error: "Command not found." });
            if (match[2] === "cancel") source.state = "cancelled";
            else commands.unshift(Object.assign({}, source, { id: "cmd-e2e-" + sequence++, state: "queued", createdAtUtc: new Date().toISOString() }));
            return json(res, 200, { ok: true, command: commands[0] });
        }

        if (url.pathname === "/api/tickets" && req.method === "GET") {
            let result = tickets.slice();
            const status = url.searchParams.get("status");
            const priority = url.searchParams.get("priority");
            const search = String(url.searchParams.get("search") || "").toLowerCase();
            if (status) result = result.filter(item => item.status === status);
            if (priority) result = result.filter(item => item.priority === priority);
            if (search) result = result.filter(item => (item.ticketId + " " + item.title).toLowerCase().includes(search));
            return json(res, 200, { ok: true, tickets: result, summary: ticketSummary(result), statuses: ["new", "accepted", "in_progress", "waiting_for_user", "waiting_for_external", "resolved", "closed", "cancelled"], priorities: ["low", "normal", "high", "critical"], generatedAtUtc: new Date().toISOString() });
        }
        if (url.pathname === "/api/tickets/policy/test-portal") {
            if (req.method === "PUT") {
                if (!requireCsrf(req, res)) return;
                ticketPolicy = Object.assign({}, ticketPolicy, await readBody(req));
            }
            return json(res, 200, { ok: true, portalId: "test-portal", policy: ticketPolicy });
        }
        const ticketRoute = url.pathname.match(/^\/api\/tickets\/test-portal\/([^/]+)$/);
        if (ticketRoute) {
            const ticket = tickets.find(item => item.ticketId === ticketRoute[1]);
            if (!ticket) return json(res, 404, { ok: false, error: "Ticket not found." });
            if (req.method === "PATCH") {
                if (!requireCsrf(req, res)) return;
                Object.assign(ticket, await readBody(req), { updatedAtUtc: new Date().toISOString() });
            }
            return json(res, 200, { ok: true, ticket });
        }

        if (url.pathname === "/api/settings/backup/run" && req.method === "POST") {
            if (!requireCsrf(req, res)) return;
            backups.unshift({ name: "sirk-central-20260731T120000+0200.tar.gz", size: 2048, createdAtUtc: new Date().toISOString() });
            return json(res, 201, { ok: true, backup: backups[0] });
        }
        if (url.pathname === "/api/settings/update/run" && req.method === "POST") {
            if (!requireCsrf(req, res)) return;
            return json(res, 202, { ok: true, accepted: true, startedAtUtc: new Date().toISOString() });
        }
        if (url.pathname === "/api/security/sessions/revoke-others" && req.method === "POST") {
            if (!requireCsrf(req, res)) return;
            return json(res, 200, { ok: true, revokedCount: 0 });
        }
        if (url.pathname === "/api/logout" && req.method === "POST") return json(res, 200, { ok: true });
        if (url.pathname.startsWith("/api/access") || url.pathname.startsWith("/api/teams") || url.pathname.startsWith("/api/portal-policy") || url.pathname.startsWith("/api/simulate")) return json(res, 200, { ok: true, teams: [], portals: [], users: [], capabilities: [] });

        return json(res, 404, { ok: false, error: "Mock route not found: " + req.method + " " + url.pathname });
    } catch (error) {
        return json(res, 500, { ok: false, error: error.message });
    }
});

server.requestTimeout = 10000;
server.headersTimeout = 5000;
server.listen(4173, "127.0.0.1", () => process.stdout.write("mock server ready\n"));
