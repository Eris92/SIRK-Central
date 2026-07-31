"use strict";

const http = require("node:http");
const policy = require("./mfa-continuity-policy");
const auditStoreFactory = require("./audit-store");
const { createRuntimeApp } = require("./server-v7");
const { loadConfig } = require("./server-v1");
const { hasPermission } = require("./rbac");

const VERSION = "1.0.0-rc.14";

function parseCookies(req) {
    const result = {};
    for (const part of String(req.headers.cookie || "").split(";")) {
        const index = part.indexOf("=");
        if (index > 0) result[part.slice(0, index).trim()] = part.slice(index + 1).trim();
    }
    return result;
}
function sessionActor(app, req) {
    const token = parseCookies(req).sirk_central_session || "";
    return token && app.sessions ? app.sessions.get(token, true) : null;
}
function breakGlassActor(app, req) {
    const actor = sessionActor(app, req);
    if (!actor || actor.builtIn !== true || actor.source !== "local" || actor.role !== "BreakGlass") return null;
    return actor;
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
function json(res, status, body) {
    const data = Buffer.from(JSON.stringify(body));
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": String(data.length), "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer" });
    res.end(data);
}
function readBody(req, limit = 65536) {
    return new Promise((resolve, reject) => {
        const chunks = []; let size = 0;
        req.on("data", chunk => { size += chunk.length; if (size > limit) { reject(Object.assign(new Error("Request body is too large."), { statusCode: 413 })); req.destroy(); } else chunks.push(chunk); });
        req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); } catch (_) { reject(Object.assign(new Error("Invalid JSON body."), { statusCode: 400 })); } });
        req.on("error", reject);
    });
}
function providerAccess(app, req) {
    const actor = sessionActor(app, req);
    if (!actor) return { actor: null, editable: false, securityEditable: false };
    return { actor, editable: hasPermission(actor, "identity.manage"), securityEditable: actor.builtIn === true || actor.role === "SecAdmin" };
}
async function testProvider(provider) {
    if (!provider.clientId) throw new Error("Application Client ID is required.");
    const tenant = String(provider.tenant || "organizations");
    const endpoint = "https://login.microsoftonline.com/" + encodeURIComponent(tenant) + "/v2.0/.well-known/openid-configuration";
    const response = await fetch(endpoint, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15000) });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.issuer || !result.authorization_endpoint || !result.token_endpoint) throw new Error("Microsoft Entra discovery failed: " + String(result.error_description || result.error || response.status));
    return { issuer: result.issuer, authorizationEndpoint: result.authorization_endpoint, tokenEndpoint: result.token_endpoint };
}
async function updaterRequest(config, requestPath, options) {
    const origin = String(config.env.SIRK_UPDATER_ORIGIN || "http://updater:8090").replace(/\/+$/, "");
    const token = String(config.env.SIRK_UPDATER_TOKEN || "");
    if (token.length < 43) throw Object.assign(new Error("Updater is not configured."), { statusCode: 503 });
    const response = await fetch(origin + requestPath, Object.assign({ headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, signal: AbortSignal.timeout(30000) }, options || {}));
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(body.error || "Updater request failed."), { statusCode: response.status });
    return body;
}
function operationsActor(app, req, write) {
    const actor = sessionActor(app, req);
    if (!actor) return null;
    if (actor.builtIn === true) return actor;
    if (write) return actor.role === "Admin" || actor.role === "SecAdmin" ? actor : null;
    return hasPermission(actor, "settings.read") ? actor : null;
}
function auditActor(app, req) {
    const actor = sessionActor(app, req);
    if (!actor) return null;
    if (actor.builtIn === true || ["Admin", "SecAdmin", "Auditor"].includes(actor.role)) return actor;
    return hasPermission(actor, "settings.read") ? actor : null;
}
function requestMetadata(req) {
    const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
    return {
        ip: forwarded || String(req.socket && req.socket.remoteAddress || ""),
        userAgent: String(req.headers["user-agent"] || ""),
        method: String(req.method || ""),
        path: String(req.url || "")
    };
}
function audit(app, req, event) {
    try {
        return app.auditStore.append(Object.assign({ actor: sessionActor(app, req) || {}, request: requestMetadata(req) }, event || {}));
    } catch (error) {
        process.stderr.write("[audit] " + String(error.stack || error) + "\n");
        return null;
    }
}
function deny(app, req, res, action, category, message) {
    audit(app, req, { action, category, result: "denied", details: { reason: message } });
    return json(res, 403, { ok: false, error: message });
}

function createContinuityApp(config) {
    const app = createRuntimeApp(config);
    app.auditStore = auditStoreFactory.create({ dataDir: config.dataDir, maxEvents: Number(config.env.SIRK_AUDIT_MAX_EVENTS || 10000) });
    const inner = app.server.listeners("request")[0];
    if (typeof inner !== "function") throw new Error("SIRK Central v7 request handler is unavailable.");
    const server = http.createServer(async (req, res) => {
        try {
            const url = new URL(req.url, "http://central.local");
            const passkeyDelete = url.pathname.match(/^\/api\/break-glass\/passkeys\/([A-Za-z0-9_-]{16,512})$/);
            const recoveryDelete = url.pathname === "/api/break-glass/mfa/recovery-codes";
            const backupDelete = url.pathname.match(/^\/api\/settings\/backup\/([^/]+)$/);

            if (req.method === "GET" && url.pathname === "/api/audit") {
                const actor = auditActor(app, req);
                if (!actor) return deny(app, req, res, "audit.read", "security", "Permission denied.");
                const events = app.auditStore.list({
                    limit: url.searchParams.get("limit") || 100,
                    category: url.searchParams.get("category") || "",
                    result: url.searchParams.get("result") || "",
                    query: url.searchParams.get("query") || ""
                });
                return json(res, 200, { ok: true, events, integrity: app.auditStore.verify() });
            }

            if (req.method === "GET" && url.pathname === "/api/settings/identity-provider") {
                const access = providerAccess(app, req);
                if (!access.actor) return json(res, 401, { ok: false, error: "Authentication required." });
                return json(res, 200, { ok: true, provider: app.providerStore.publicView(), editable: access.editable, securityEditable: access.securityEditable });
            }
            if (req.method === "PUT" && url.pathname === "/api/settings/identity-provider") {
                if (!csrfAccepted(req, config)) return deny(app, req, res, "identity_provider.update", "identity", "CSRF validation failed.");
                const access = providerAccess(app, req);
                if (!access.actor) return json(res, 401, { ok: false, error: "Authentication required." });
                if (!access.editable) return deny(app, req, res, "identity_provider.update", "identity", "Permission denied.");
                const provider = app.providerStore.update(await readBody(req), { allowSecurity: access.securityEditable });
                if (app.securityCenter) app.securityCenter.audit("identity_provider.updated", access.actor, { enabled: provider.enabled, tenant: provider.tenant, clientId: provider.clientId, securityFieldsUpdated: access.securityEditable });
                audit(app, req, { action: "identity_provider.updated", category: "identity", result: "success", target: provider.clientId, details: { enabled: provider.enabled, tenant: provider.tenant, securityFieldsUpdated: access.securityEditable } });
                return json(res, 200, { ok: true, provider });
            }
            if (req.method === "POST" && url.pathname === "/api/settings/identity-provider/test") {
                if (!csrfAccepted(req, config)) return deny(app, req, res, "identity_provider.test", "identity", "CSRF validation failed.");
                const access = providerAccess(app, req);
                if (!access.actor) return json(res, 401, { ok: false, error: "Authentication required." });
                if (!access.editable) return deny(app, req, res, "identity_provider.test", "identity", "Permission denied.");
                const result = await testProvider(app.providerStore.read());
                audit(app, req, { action: "identity_provider.tested", category: "identity", result: "success", details: { issuer: result.issuer } });
                return json(res, 200, Object.assign({ ok: true }, result));
            }

            if (req.method === "GET" && url.pathname === "/api/settings/update/status") {
                if (!operationsActor(app, req, false)) return deny(app, req, res, "update.status.read", "operations", "Permission denied.");
                return json(res, 200, await updaterRequest(config, "/status"));
            }
            if (req.method === "POST" && url.pathname === "/api/settings/update/run") {
                if (!csrfAccepted(req, config)) return deny(app, req, res, "update.run", "operations", "CSRF validation failed.");
                const actor = operationsActor(app, req, true);
                if (!actor) return deny(app, req, res, "update.run", "operations", "Permission denied.");
                const body = await readBody(req);
                body.requestedBy = actor.username || actor.displayName || "unknown";
                const result = await updaterRequest(config, "/run", { method: "POST", body: JSON.stringify(body) });
                audit(app, req, { action: "update.started", category: "operations", result: "success", details: { startedAtUtc: result.startedAtUtc } });
                return json(res, 202, result);
            }
            if (req.method === "GET" && url.pathname === "/api/settings/backup/status") {
                if (!operationsActor(app, req, false)) return deny(app, req, res, "backup.status.read", "operations", "Permission denied.");
                return json(res, 200, await updaterRequest(config, "/backup/status"));
            }
            if (req.method === "POST" && url.pathname === "/api/settings/backup/run") {
                if (!csrfAccepted(req, config)) return deny(app, req, res, "backup.create", "operations", "CSRF validation failed.");
                if (!operationsActor(app, req, true)) return deny(app, req, res, "backup.create", "operations", "Permission denied.");
                const result = await updaterRequest(config, "/backup/run", { method: "POST", body: JSON.stringify(await readBody(req)) });
                audit(app, req, { action: "backup.created", category: "operations", result: "success", target: result.backup && result.backup.name, details: { size: result.backup && result.backup.size } });
                return json(res, 201, result);
            }
            if (req.method === "POST" && url.pathname === "/api/settings/backup/restore") {
                if (!csrfAccepted(req, config)) return deny(app, req, res, "backup.restore", "operations", "CSRF validation failed.");
                if (!operationsActor(app, req, true)) return deny(app, req, res, "backup.restore", "operations", "Permission denied.");
                const body = await readBody(req);
                const result = await updaterRequest(config, "/backup/restore", { method: "POST", body: JSON.stringify(body) });
                audit(app, req, { action: "backup.restore_scheduled", category: "operations", result: "success", target: body.name, details: { safetyBackup: result.safetyBackup } });
                return json(res, 202, result);
            }
            if (req.method === "DELETE" && backupDelete) {
                if (!csrfAccepted(req, config)) return deny(app, req, res, "backup.delete", "operations", "CSRF validation failed.");
                if (!operationsActor(app, req, true)) return deny(app, req, res, "backup.delete", "operations", "Permission denied.");
                const name = decodeURIComponent(backupDelete[1]);
                const result = await updaterRequest(config, "/backup/" + encodeURIComponent(name), { method: "DELETE", body: JSON.stringify(await readBody(req)) });
                audit(app, req, { action: "backup.deleted", category: "operations", result: "success", target: name });
                return json(res, 200, result);
            }

            if (req.method === "GET" && url.pathname === "/api/break-glass/mfa/continuity") {
                const actor = breakGlassActor(app, req);
                if (!actor) return deny(app, req, res, "breakglass.continuity.read", "security", "Break-Glass session required.");
                return json(res, 200, { ok: true, continuity: policy.snapshot(app.passkeys, app.recoveryCodes, actor) });
            }
            if (req.method === "DELETE" && (passkeyDelete || recoveryDelete)) {
                if (!csrfAccepted(req, config)) return deny(app, req, res, passkeyDelete ? "passkey.revoke" : "recovery_codes.revoke", "security", "CSRF validation failed.");
                const actor = breakGlassActor(app, req);
                if (!actor) return deny(app, req, res, passkeyDelete ? "passkey.revoke" : "recovery_codes.revoke", "security", "Break-Glass session required.");
                if (passkeyDelete) policy.assertCanRevokePasskey(app.passkeys, app.recoveryCodes, actor, passkeyDelete[1]);
                else policy.assertCanRevokeRecoveryCodes(app.passkeys, app.recoveryCodes, actor);
                audit(app, req, { action: passkeyDelete ? "passkey.revocation_authorized" : "recovery_codes.revocation_authorized", category: "security", result: "success", target: passkeyDelete ? passkeyDelete[1] : actor.identityKey });
            }
            if (req.method === "POST" && url.pathname === "/api/logout") {
                audit(app, req, { action: "session.logout", category: "authentication", result: "success" });
            }
            if (req.method === "GET" && url.pathname === "/readyz") {
                const continuity = Boolean(app.passkeys && app.recoveryCodes && app.providerStore && app.auditStore);
                if (!continuity) return json(res, 503, { ok: false, version: VERSION, checks: { mfaContinuityPolicy: false, identityProviderStore: Boolean(app.providerStore), auditStore: Boolean(app.auditStore) } });
            }
            return inner(req, res);
        } catch (error) {
            audit(app, req, { action: "request.failed", category: "system", result: "failure", details: { code: error.code || "REQUEST_REJECTED", error: error.message || "Request failed." } });
            if (!res.headersSent) return json(res, error.statusCode || 400, { ok: false, code: error.code || "REQUEST_REJECTED", error: error.message || "Request failed." });
            res.destroy(error);
        }
    });
    server.on("upgrade", (req, socket, head) => app.server.emit("upgrade", req, socket, head));
    return Object.assign({}, app, { server, version: VERSION });
}

if (require.main === module) {
    const config = loadConfig(process.env);
    const app = createContinuityApp(config);
    app.server.listen(config.port, config.bindHost, () => process.stdout.write("SIRK Central v8 listening on " + config.bindHost + ":" + config.port + "\n"));
}
module.exports = { createContinuityApp, VERSION, parseCookies, breakGlassActor, csrfAccepted, providerAccess, testProvider };
