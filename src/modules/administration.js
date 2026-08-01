"use strict";

const { json, parseCookies, csrfAccepted, readBody } = require("../http/transport");

const { identityActive } = require("../rbac");

const { VERSION } = require("../version");

function sessionActor(app, req) {
    const token = parseCookies(req).sirk_central_session || "";
    return token && app.sessions ? app.sessions.get(token, true) : null;
}
function canRead(actor) {
    return Boolean(identityActive(actor) && (actor.builtIn === true || ["Admin", "SecAdmin", "Auditor"].includes(actor.role)));
}
function canWrite(actor) {
    return Boolean(identityActive(actor) && (actor.builtIn === true || actor.role === "Admin"));
}
function managerOrigin(config) {
    const value = String(config.env.SIRK_BACKUP_MANAGER_ORIGIN || "http://backup-manager:8091").replace(/\/+$/, "");
    let url;
    try { url = new URL(value); }
    catch (_) { throw Object.assign(new Error("Backup manager origin is invalid."), { statusCode: 503 }); }
    if (url.protocol !== "http:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
        throw Object.assign(new Error("Backup manager origin must be an internal HTTP origin."), { statusCode: 503 });
    }
    return url.origin;
}
function managerToken(config) {
    const token = String(config.env.SIRK_UPDATER_TOKEN || "");
    if (token.length < 43) throw Object.assign(new Error("Backup manager is not configured."), { statusCode: 503 });
    return token;
}
async function managerRequest(config, requestPath, options) {
    const response = await fetch(managerOrigin(config) + requestPath, Object.assign({
        headers: { Authorization: "Bearer " + managerToken(config), "Content-Type": "application/json" },
        signal: AbortSignal.timeout(30000)
    }, options || {}));
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(body.error || "Backup manager request failed."), { statusCode: response.status });
    return body;
}
function audit(app, action, actor, req, details, result = "success") {
    if (!app.auditStore || typeof app.auditStore.append !== "function") return;
    app.auditStore.append({
        action,
        category: "operations",
        result,
        actor,
        request: {
            ip: String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim(),
            userAgent: String(req.headers["user-agent"] || ""),
            method: req.method,
            path: req.url
        },
        details
    });
}
function csvEscape(value) {
    const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
    return '"' + String(text).replace(/"/g, '""') + '"';
}

function registerAdministration(app, config) {

    const handler = async (req, res) => {
        try {
            const url = new URL(req.url, "http://central.local");
            const actor = sessionActor(app, req);

            if (req.method === "GET" && url.pathname === "/api/settings/backup/policy") {
                if (!canRead(actor)) return json(res, actor ? 403 : 401, { ok: false, error: actor ? "Permission denied." : "Authentication required." });
                return json(res, 200, await managerRequest(config, "/policy"));
            }
            if (req.method === "PUT" && url.pathname === "/api/settings/backup/policy") {
                if (!canWrite(actor)) return json(res, actor ? 403 : 401, { ok: false, error: actor ? "Permission denied." : "Authentication required." });
                if (!csrfAccepted(req, config)) return json(res, 403, { ok: false, error: "CSRF validation failed." });
                const body = await readBody(req);
                body.updatedBy = actor.username || actor.displayName || "unknown";
                const result = await managerRequest(config, "/policy", { method: "PUT", body: JSON.stringify(body) });
                audit(app, "backup.policy_updated", actor, req, { policy: result.policy, removed: result.removed });
                return json(res, 200, result);
            }

            const backupDownload = url.pathname.match(/^\/api\/settings\/backup\/([^/]+)\/download$/);
            if (req.method === "GET" && backupDownload) {
                if (!canRead(actor)) return json(res, actor ? 403 : 401, { ok: false, error: actor ? "Permission denied." : "Authentication required." });
                const name = decodeURIComponent(backupDownload[1]);
                const response = await fetch(managerOrigin(config) + "/backup/" + encodeURIComponent(name) + "/download", {
                    headers: { Authorization: "Bearer " + managerToken(config) }, signal: AbortSignal.timeout(30000)
                });
                if (!response.ok) {
                    const body = await response.json().catch(() => ({}));
                    return json(res, response.status, { ok: false, error: body.error || "Backup download failed." });
                }
                audit(app, "backup.downloaded", actor, req, { backup: name });
                const headers = {
                    "Content-Type": response.headers.get("content-type") || "application/gzip",
                    "Content-Disposition": response.headers.get("content-disposition") || `attachment; filename="${name}"`,
                    "Cache-Control": "no-store",
                    "X-Content-Type-Options": "nosniff"
                };
                const length = response.headers.get("content-length");
                const checksum = response.headers.get("x-sirk-backup-sha256");
                if (length) headers["Content-Length"] = length;
                if (checksum) headers["X-SIRK-Backup-SHA256"] = checksum;
                res.writeHead(200, headers);
                if (response.body) for await (const chunk of response.body) res.write(chunk);
                return res.end();
            }
            const logDownload = url.pathname.match(/^\/api\/settings\/update\/log\/([^/]+)\/download$/);
            if (req.method === "GET" && logDownload) {
                if (!canRead(actor)) return json(res, actor ? 403 : 401, { ok: false, error: actor ? "Permission denied." : "Authentication required." });
                const name = decodeURIComponent(logDownload[1]);
                const response = await fetch(managerOrigin(config) + "/log/" + encodeURIComponent(name) + "/download", {
                    headers: { Authorization: "Bearer " + managerToken(config) }, signal: AbortSignal.timeout(30000)
                });
                if (!response.ok) return json(res, response.status, { ok: false, error: "Update log was not found." });
                res.writeHead(200, {
                    "Content-Type": "text/plain; charset=utf-8",
                    "Content-Disposition": `attachment; filename="${name}"`,
                    "Cache-Control": "no-store",
                    "X-Content-Type-Options": "nosniff"
                });
                if (response.body) for await (const chunk of response.body) res.write(chunk);
                return res.end();
            }
            if (req.method === "GET" && url.pathname === "/api/audit/export") {
                if (!canRead(actor) || !app.auditStore) return json(res, actor ? 403 : 401, { ok: false, error: actor ? "Permission denied." : "Authentication required." });
                const events = app.auditStore.list({
                    limit: Math.min(5000, Number(url.searchParams.get("limit") || 1000)),
                    category: url.searchParams.get("category") || "",
                    result: url.searchParams.get("result") || "",
                    query: url.searchParams.get("query") || ""
                });
                const format = url.searchParams.get("format") === "json" ? "json" : "csv";
                audit(app, "audit.exported", actor, req, { format, count: events.length });
                if (format === "json") {
                    const data = Buffer.from(JSON.stringify({ exportedAtUtc: new Date().toISOString(), integrity: app.auditStore.verify(), events }, null, 2));
                    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Content-Length": String(data.length), "Content-Disposition": "attachment; filename=central-audit.json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
                    return res.end(data);
                }
                const columns = ["timestampUtc", "action", "category", "result", "actor", "role", "source", "ip", "method", "path", "target", "details", "hash"];
                const lines = [columns.map(csvEscape).join(",")];
                for (const event of events) lines.push([
                    event.timestampUtc, event.action, event.category, event.result,
                    event.actor && (event.actor.displayName || event.actor.username), event.actor && event.actor.role,
                    event.actor && event.actor.source, event.request && event.request.ip, event.request && event.request.method,
                    event.request && event.request.path, event.target, event.details, event.hash
                ].map(csvEscape).join(","));
                const data = Buffer.from("\uFEFF" + lines.join("\r\n"), "utf8");
                res.writeHead(200, { "Content-Type": "text/csv; charset=utf-8", "Content-Length": String(data.length), "Content-Disposition": "attachment; filename=central-audit.csv", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
                return res.end(data);
            }
            if (req.method === "GET" && url.pathname === "/api/system/version") {
                if (!identityActive(actor)) return json(res, actor ? 403 : 401, { ok: false, error: actor ? "Permission denied." : "Authentication required." });
                const update = await managerRequest(config, "/policy").catch(() => null);
                return json(res, 200, {
                    ok: true,
                    version: VERSION,
                    runtime: "central",
                    node: process.version,
                    uptimeSeconds: Math.floor(process.uptime()),
                    backupManager: Boolean(update),
                    generatedAtUtc: new Date().toISOString()
                });
            }
            return false;
        } catch (error) {
            const status = Number.isInteger(error.statusCode) ? error.statusCode : 500;
            const message = status >= 500 ? "Internal server error." : error.message || "Request failed.";
            if (!res.headersSent) return json(res, status, { ok: false, code: error.code || (status >= 500 ? "INTERNAL_ERROR" : "REQUEST_REJECTED"), error: message });
            res.destroy(error);
        }
    };
    app.server.requestTimeout = 30000;
    app.server.headersTimeout = 15000;
    app.server.keepAliveTimeout = 5000;
    app.router.prepend(handler);
    Object.assign(app, { version: VERSION });
    return app
}

module.exports = { registerAdministration, VERSION, canRead, canWrite, managerOrigin };
