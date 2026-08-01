"use strict";

const { Readable } = require("node:stream");
const { parseCookies, csrfAccepted, json, readBody } = require("../http/transport");
const { identityActive, hasPermission } = require("../rbac");

const ENCRYPTED_BACKUP_PATTERN = /^sirk-central-\d{8}T\d{6}Z\.tar\.gz\.age$/;

function sessionActor(app, req) {
    const token = parseCookies(req).sirk_central_session || "";
    return token && app.sessions ? app.sessions.get(token, true) : null;
}
function allowed(actor) {
    if (!identityActive(actor)) return false;
    if (actor.builtIn === true) return true;
    if (["Admin", "SecAdmin", "Auditor"].includes(actor.role)) return true;
    return hasPermission(actor, "settings.read");
}
function writable(actor) {
    if (!identityActive(actor)) return false;
    if (actor.builtIn === true) return true;
    return actor.role === "Admin";
}
function updaterOrigin(config) {
    const value = String(config.env.SIRK_UPDATER_ORIGIN || "").replace(/\/+$/, "");
    const origin = new URL(value);
    const allowedHosts = new Set(String(config.env.SIRK_UPDATER_ALLOWED_HOSTS || "updater-gateway")
        .split(",").map(value => value.trim().toLowerCase()).filter(Boolean));
    if (origin.protocol !== "http:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash || !allowedHosts.has(origin.hostname.toLowerCase())) {
        throw Object.assign(new Error("Updater origin is not allowed."), { statusCode: 503 });
    }
    return origin.origin;
}
function updaterToken(config) {
    const value = String(config.env.SIRK_UPDATER_TOKEN || "");
    if (value.length < 43) throw Object.assign(new Error("Updater is not configured."), { statusCode: 503 });
    return value;
}
async function requestStatus(config) {
    const response = await fetch(updaterOrigin(config) + "/appliance/status", {
        headers: { Authorization: "Bearer " + updaterToken(config), Accept: "application/json" },
        signal: AbortSignal.timeout(30000)
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(response.status >= 500 ? "Appliance diagnostics failed." : result.error || "Appliance diagnostics rejected."), { statusCode: response.status });
    return result;
}
async function downloadBackup(config, name, res) {
    if (!ENCRYPTED_BACKUP_PATTERN.test(String(name || ""))) throw Object.assign(new Error("Encrypted backup name is invalid."), { statusCode: 400 });
    const response = await fetch(updaterOrigin(config) + "/backup/file/" + encodeURIComponent(name), {
        headers: { Authorization: "Bearer " + updaterToken(config), Accept: "application/octet-stream" },
        signal: AbortSignal.timeout(15 * 60 * 1000)
    });
    if (!response.ok || !response.body) {
        const result = await response.json().catch(() => ({}));
        throw Object.assign(new Error(response.status >= 500 ? "Backup download failed." : result.error || "Backup download was rejected."), { statusCode: response.status });
    }
    const headers = {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="${name}"`,
        "Cache-Control": "no-store, private",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
        "Referrer-Policy": "no-referrer"
    };
    const length = response.headers.get("content-length");
    if (length && /^\d+$/.test(length)) headers["Content-Length"] = length;
    res.writeHead(200, headers);
    Readable.fromWeb(response.body).on("error", error => res.destroy(error)).pipe(res);
}
async function restoreEncryptedBackup(config, body) {
    const name = String(body && body.name || "");
    const identity = String(body && body.identity || "");
    if (!ENCRYPTED_BACKUP_PATTERN.test(name)) throw Object.assign(new Error("Encrypted backup name is invalid."), { statusCode: 400 });
    if (!identity || Buffer.byteLength(identity, "utf8") > 16384 || identity.includes("\0")) throw Object.assign(new Error("Age identity is invalid."), { statusCode: 400 });
    const response = await fetch(updaterOrigin(config) + "/backup/encrypted/restore", {
        method: "POST",
        headers: {
            Authorization: "Bearer " + updaterToken(config),
            Accept: "application/json",
            "Content-Type": "application/json"
        },
        body: JSON.stringify({ name, identity, confirm: "RESTORE SIRK CENTRAL" }),
        signal: AbortSignal.timeout(30000)
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(response.status >= 500 ? "Encrypted restore failed." : result.error || "Encrypted restore was rejected."), { statusCode: response.status });
    return result;
}
function audit(app, actor, action, result, target, details) {
    if (!app.auditStore || typeof app.auditStore.append !== "function") return;
    try {
        app.auditStore.append({ actor: actor || {}, action, category: "operations", result, target: String(target || ""), details: details || {} });
    } catch (_) { /* audit failure must not expose secret material */ }
}

function registerApplianceManagement(app, config) {
    const handler = async (req, res) => {
        try {
            const url = new URL(req.url, "http://central.local");
            if (req.method === "GET" && url.pathname === "/api/settings/appliance/status") {
                const actor = sessionActor(app, req);
                if (!allowed(actor)) return json(res, 403, { ok: false, error: "Permission denied." });
                return json(res, 200, await requestStatus(config));
            }
            const download = url.pathname.match(/^\/api\/settings\/backup\/download\/([^/]+)$/);
            if (req.method === "GET" && download) {
                const actor = sessionActor(app, req);
                if (!allowed(actor)) return json(res, 403, { ok: false, error: "Permission denied." });
                const name = decodeURIComponent(download[1]);
                await downloadBackup(config, name, res);
                return true;
            }
            if (req.method === "POST" && url.pathname === "/api/settings/backup/restore-encrypted") {
                const actor = sessionActor(app, req);
                if (!writable(actor)) return json(res, 403, { ok: false, error: "Permission denied." });
                if (!csrfAccepted(req, config)) return json(res, 403, { ok: false, error: "CSRF validation failed." });
                const body = await readBody(req);
                if (body.confirm !== "RESTORE SIRK CENTRAL") return json(res, 400, { ok: false, error: "Restore confirmation is invalid." });
                const result = await restoreEncryptedBackup(config, body);
                audit(app, actor, "backup.encrypted_restore_scheduled", "success", body.name, { accepted: true });
                return json(res, 202, result);
            }
            return false;
        } catch (error) {
            if (res.headersSent) return res.destroy(error);
            return json(res, Number.isInteger(error.statusCode) ? error.statusCode : 500, {
                ok: false,
                error: Number.isInteger(error.statusCode) && error.statusCode < 500 ? error.message : "Internal service error."
            });
        }
    };
    app.router.prepend(handler);
    return app;
}

module.exports = { registerApplianceManagement, allowed, writable, updaterOrigin, updaterToken, requestStatus, downloadBackup, restoreEncryptedBackup, ENCRYPTED_BACKUP_PATTERN };
