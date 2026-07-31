"use strict";

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const publicDir = path.join(root, "public");
const scripts = [
    "passkey-attestation-bridge.js", "passkey-ui.js", "passkey-ui-polish.js", "passkey-list-cleanup.js",
    "operations-ui.js", "operations-actions.js", "central-ux.js", "operations-bootstrap.js",
    "update-status-resilience.js", "audit-ui.js", "dashboard-css-loader.js", "dashboard-ui.js",
    "admin-tools-css-loader.js", "admin-tools-ui.js", "security-sessions-ui.js", "approval-center-ui.js",
    "portal-operations-ui.js"
];
const csrf = "abcdefghijklmnopqrstuvwxyzABCDEFGH12345678";
let approvals = [{ id: "apr-e2e", type: "operation.high-risk", state: "pending", title: "Test approval", reason: "Browser test", requestedBy: "other-user", requestedAtUtc: new Date().toISOString(), expiresAtUtc: new Date(Date.now() + 3600000).toISOString(), requiredApprovals: 1, decisions: [], scope: { portalId: "test-portal" }, payload: { operation: "restart" }, execution: null }];
let commands = [];
let backups = [{ name: "sirk-central-20260731T100000+0200.tar.gz", size: 1024, createdAtUtc: new Date().toISOString() }];

function json(res, status, body, headers) {
    const data = Buffer.from(JSON.stringify(body));
    res.writeHead(status, Object.assign({ "Content-Type": "application/json", "Content-Length": data.length, "Cache-Control": "no-store" }, headers || {}));
    res.end(data);
}
function body(req) {
    return new Promise(resolve => { const chunks = []; req.on("data", c => chunks.push(c)); req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString() || "{}")); } catch (_) { resolve({}); } }); });
}
function staticFile(res, filePath, type) {
    if (!fs.existsSync(filePath)) return json(res, 404, { error: "Not found" });
    const data = fs.readFileSync(filePath);
    res.writeHead(200, { "Content-Type": type, "Content-Length": data.length, "Cache-Control": "no-store" });
    res.end(data);
}

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1:4173");
    if (url.pathname === "/" || url.pathname === "/index.html") {
        res.setHeader("Set-Cookie", "sirk_central_csrf=" + csrf + "; Path=/; SameSite=Lax");
        return staticFile(res, path.join(publicDir, "index.html"), "text/html; charset=utf-8");
    }
    if (url.pathname === "/passkey-ui.js") {
        const data = Buffer.from(scripts.map(name => fs.readFileSync(path.join(publicDir, name), "utf8")).join("\n"));
        res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Content-Length": data.length }); return res.end(data);
    }
    if (url.pathname.endsWith(".js")) return staticFile(res, path.join(publicDir, path.basename(url.pathname)), "text/javascript; charset=utf-8");
    if (url.pathname.endsWith(".css")) return staticFile(res, path.join(publicDir, path.basename(url.pathname)), "text/css; charset=utf-8");

    if (url.pathname === "/api/session") return json(res, 200, { ok: true, username: "admin", displayName: "Administrator", source: "local", identityKey: "breakglass:admin", role: "BreakGlass", status: "active", builtIn: true, permissions: ["*"] });
    if (url.pathname === "/api/portals") return json(res, 200, { ok: true, portals: [{ id: "test-portal", name: "Test Portal", status: "online", access: { teams: [], capabilities: { "portal.connect": "allow" } } }] });
    if (url.pathname === "/api/settings/roles") return json(res, 200, { ok: true, roles: ["Auditor", "OperatorL1", "SupportL2", "EngineerL3", "Admin", "SecAdmin"] });
    if (url.pathname === "/api/settings/users") return json(res, 200, { ok: true, users: [] });
    if (url.pathname === "/api/settings/identity-provider") return json(res, 200, { ok: true, editable: true, securityEditable: true, provider: { enabled: false, tenant: "organizations", clientId: "", clientSecretConfigured: false, allowedIdentities: [], redirectUri: "https://example.test/callback", logoutUrl: "https://example.test/logout" } });
    if (url.pathname === "/api/settings/update/status") return json(res, 200, { ok: true, status: { state: "completed", running: false, startedAtUtc: new Date().toISOString(), finishedAtUtc: new Date().toISOString(), previousCommit: "11111111", targetCommit: "22222222" } });
    if (url.pathname === "/api/settings/backup/status") return json(res, 200, { ok: true, backups, restore: { state: "idle", running: false } });
    if (url.pathname === "/api/backup-management/policy") return req.method === "GET" ? json(res, 200, { ok: true, policy: { enabled: true, hour: 2, minute: 0, retention: 10, timeZone: "Europe/Warsaw" }, status: { nextRunAtUtc: new Date(Date.now() + 86400000).toISOString() } }) : json(res, 200, { ok: true });
    if (url.pathname === "/api/system/info") return json(res, 200, { ok: true, version: "1.0.0-rc.18", runtime: "server-v14", node: process.version, uptimeSeconds: 100, backupManager: true });
    if (url.pathname === "/readyz") return json(res, 200, { ok: true, checks: { runtime: true, security: true } });
    if (url.pathname === "/api/audit" || url.pathname.startsWith("/api/audit?")) return json(res, 200, { ok: true, events: [{ id: "evt", timestampUtc: new Date().toISOString(), action: "test.event", category: "system", result: "success", actor: { username: "admin", role: "BreakGlass" }, request: { ip: "127.0.0.1" }, details: {}, hash: "hash" }], integrity: { ok: true, count: 1 } });
    if (url.pathname === "/api/security/sessions") return json(res, 200, { ok: true, sessions: [{ id: "current-session", username: "admin", displayName: "Administrator", role: "BreakGlass", source: "local", ip: "127.0.0.1", userAgent: "Playwright", createdAtUtc: new Date().toISOString(), lastSeenAtUtc: new Date().toISOString(), idleExpiresAtUtc: new Date(Date.now() + 1800000).toISOString(), absoluteExpiresAtUtc: new Date(Date.now() + 28800000).toISOString(), current: true }] });
    if (url.pathname === "/api/approval-center" && req.method === "GET") return json(res, 200, { ok: true, requests: approvals.filter(item => !url.searchParams.get("state") || item.state === url.searchParams.get("state")) });
    if (url.pathname === "/api/approval-center" && req.method === "POST") { const input = await body(req); approvals.unshift(Object.assign({ id: "apr-new", state: "pending", requestedBy: "admin", requestedAtUtc: new Date().toISOString(), expiresAtUtc: new Date(Date.now() + 3600000).toISOString(), decisions: [] }, input)); return json(res, 201, { ok: true, request: approvals[0] }); }
    const decision = url.pathname.match(/^\/api\/approval-center\/(apr-[^/]+)\/(approve|reject|cancel)$/);
    if (decision) { const item = approvals.find(x => x.id === decision[1]); if (item) item.state = decision[2] === "approve" ? "approved" : decision[2] === "reject" ? "rejected" : "cancelled"; return json(res, 200, { ok: true, request: item }); }
    if (url.pathname === "/api/portal-operations" && req.method === "GET") return json(res, 200, { ok: true, commands, summary: { active: 0, total: commands.length, counts: { queued: 0, delivered: 0, running: 0, completed: commands.length, failed: 0, cancelled: 0, expired: 0 } } });
    if (url.pathname === "/api/portal-operations" && req.method === "POST") { const input = await body(req); const command = Object.assign({ id: "cmd-e2e", state: "queued", createdAtUtc: new Date().toISOString(), requestedBy: "admin", progress: 0 }, input); commands.unshift(command); return json(res, 201, { ok: true, command }); }
    if (url.pathname.startsWith("/api/portal-operations/") || url.pathname === "/api/security/sessions/revoke-others") return json(res, 200, { ok: true, revokedCount: 0 });
    if (url.pathname === "/api/settings/backup/run") { backups.unshift({ name: "sirk-central-20260731T120000+0200.tar.gz", size: 2048, createdAtUtc: new Date().toISOString() }); return json(res, 201, { ok: true }); }
    if (url.pathname.startsWith("/api/settings/backup/") || url.pathname === "/api/settings/update/run" || url.pathname === "/api/logout" || url.pathname.startsWith("/api/settings/identity-provider")) return json(res, 200, { ok: true });
    if (url.pathname.startsWith("/api/access") || url.pathname.startsWith("/api/teams") || url.pathname.startsWith("/api/portal-policy") || url.pathname.startsWith("/api/simulate")) return json(res, 200, { ok: true, teams: [], portals: [], users: [], capabilities: [] });
    return json(res, 404, { ok: false, error: "Mock route not found: " + url.pathname });
});

server.listen(4173, "127.0.0.1", () => process.stdout.write("mock server ready\n"));
