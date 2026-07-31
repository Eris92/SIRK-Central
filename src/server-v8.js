"use strict";

const http = require("node:http");
const policy = require("./mfa-continuity-policy");
const { createRuntimeApp } = require("./server-v7");
const { loadConfig } = require("./server-v1");
const { hasPermission } = require("./rbac");

const VERSION = "1.0.0-rc.13";

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

function createContinuityApp(config) {
    const app = createRuntimeApp(config);
    const inner = app.server.listeners("request")[0];
    if (typeof inner !== "function") throw new Error("SIRK Central v7 request handler is unavailable.");
    const server = http.createServer(async (req, res) => {
        try {
            const url = new URL(req.url, "http://central.local");
            const passkeyDelete = url.pathname.match(/^\/api\/break-glass\/passkeys\/([A-Za-z0-9_-]{16,512})$/);
            const recoveryDelete = url.pathname === "/api/break-glass/mfa/recovery-codes";
            const backupDelete = url.pathname.match(/^\/api\/settings\/backup\/([^/]+)$/);

            if (req.method === "GET" && url.pathname === "/api/settings/identity-provider") {
                const access = providerAccess(app, req);
                if (!access.actor) return json(res, 401, { ok: false, error: "Authentication required." });
                return json(res, 200, { ok: true, provider: app.providerStore.publicView(), editable: access.editable, securityEditable: access.securityEditable });
            }
            if (req.method === "PUT" && url.pathname === "/api/settings/identity-provider") {
                if (!csrfAccepted(req, config)) return json(res, 403, { ok: false, error: "CSRF validation failed." });
                const access = providerAccess(app, req);
                if (!access.actor) return json(res, 401, { ok: false, error: "Authentication required." });
                if (!access.editable) return json(res, 403, { ok: false, error: "Permission denied." });
                const provider = app.providerStore.update(await readBody(req), { allowSecurity: access.securityEditable });
                if (app.securityCenter) app.securityCenter.audit("identity_provider.updated", access.actor, { enabled: provider.enabled, tenant: provider.tenant, clientId: provider.clientId, securityFieldsUpdated: access.securityEditable });
                return json(res, 200, { ok: true, provider });
            }
            if (req.method === "POST" && url.pathname === "/api/settings/identity-provider/test") {
                if (!csrfAccepted(req, config)) return json(res, 403, { ok: false, error: "CSRF validation failed." });
                const access = providerAccess(app, req);
                if (!access.actor) return json(res, 401, { ok: false, error: "Authentication required." });
                if (!access.editable) return json(res, 403, { ok: false, error: "Permission denied." });
                return json(res, 200, Object.assign({ ok: true }, await testProvider(app.providerStore.read())));
            }

            if (req.method === "GET" && url.pathname === "/api/settings/update/status") {
                if (!operationsActor(app, req, false)) return json(res, 403, { ok: false, error: "Permission denied." });
                return json(res, 200, await updaterRequest(config, "/status"));
            }
            if (req.method === "POST" && url.pathname === "/api/settings/update/run") {
                if (!csrfAccepted(req, config)) return json(res, 403, { ok: false, error: "CSRF validation failed." });
                const actor = operationsActor(app, req, true);
                if (!actor) return json(res, 403, { ok: false, error: "Permission denied." });
                const body = await readBody(req);
                body.requestedBy = actor.username || actor.displayName || "unknown";
                return json(res, 202, await updaterRequest(config, "/run", { method: "POST", body: JSON.stringify(body) }));
            }
            if (req.method === "GET" && url.pathname === "/api/settings/backup/status") {
                if (!operationsActor(app, req, false)) return json(res, 403, { ok: false, error: "Permission denied." });
                return json(res, 200, await updaterRequest(config, "/backup/status"));
            }
            if (req.method === "POST" && url.pathname === "/api/settings/backup/run") {
                if (!csrfAccepted(req, config)) return json(res, 403, { ok: false, error: "CSRF validation failed." });
                if (!operationsActor(app, req, true)) return json(res, 403, { ok: false, error: "Permission denied." });
                return json(res, 201, await updaterRequest(config, "/backup/run", { method: "POST", body: JSON.stringify(await readBody(req)) }));
            }
            if (req.method === "POST" && url.pathname === "/api/settings/backup/restore") {
                if (!csrfAccepted(req, config)) return json(res, 403, { ok: false, error: "CSRF validation failed." });
                if (!operationsActor(app, req, true)) return json(res, 403, { ok: false, error: "Permission denied." });
                return json(res, 202, await updaterRequest(config, "/backup/restore", { method: "POST", body: JSON.stringify(await readBody(req)) }));
            }
            if (req.method === "DELETE" && backupDelete) {
                if (!csrfAccepted(req, config)) return json(res, 403, { ok: false, error: "CSRF validation failed." });
                if (!operationsActor(app, req, true)) return json(res, 403, { ok: false, error: "Permission denied." });
                const name = decodeURIComponent(backupDelete[1]);
                return json(res, 200, await updaterRequest(config, "/backup/" + encodeURIComponent(name), { method: "DELETE", body: JSON.stringify(await readBody(req)) }));
            }

            if (req.method === "GET" && url.pathname === "/api/break-glass/mfa/continuity") {
                const actor = breakGlassActor(app, req);
                if (!actor) return json(res, 403, { ok: false, error: "Break-Glass session required." });
                return json(res, 200, { ok: true, continuity: policy.snapshot(app.passkeys, app.recoveryCodes, actor) });
            }
            if (req.method === "DELETE" && (passkeyDelete || recoveryDelete)) {
                if (!csrfAccepted(req, config)) return json(res, 403, { ok: false, error: "CSRF validation failed." });
                const actor = breakGlassActor(app, req);
                if (!actor) return json(res, 403, { ok: false, error: "Break-Glass session required." });
                if (passkeyDelete) policy.assertCanRevokePasskey(app.passkeys, app.recoveryCodes, actor, passkeyDelete[1]);
                else policy.assertCanRevokeRecoveryCodes(app.passkeys, app.recoveryCodes, actor);
            }
            if (req.method === "GET" && url.pathname === "/readyz") {
                const continuity = Boolean(app.passkeys && app.recoveryCodes && app.providerStore);
                if (!continuity) return json(res, 503, { ok: false, version: VERSION, checks: { mfaContinuityPolicy: false, identityProviderStore: Boolean(app.providerStore) } });
            }
            return inner(req, res);
        } catch (error) {
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
