"use strict";

const { json, parseCookies, readBody, csrfAccepted } = require("../http/transport");


const { VERSION } = require("../version");

function sessionActor(app, req) {
    const token = parseCookies(req).sirk_central_session || "";
    return token && app.sessions ? app.sessions.get(token, true) : null;
}
async function updaterRequest(config, path, options) {
    const origin = String(config.env.SIRK_UPDATER_ORIGIN || "http://updater:8090").replace(/\/+$/, "");
    const token = String(config.env.SIRK_UPDATER_TOKEN || "");
    if (token.length < 43) throw Object.assign(new Error("Updater is not configured."), { statusCode: 503 });
    const response = await fetch(origin + path, Object.assign({
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
        signal: AbortSignal.timeout(30000)
    }, options || {}));
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(body.error || "Updater request failed."), { statusCode: response.status });
    return body;
}

function registerMaintenance(app, config) {

    const handler = async (req, res) => {
        try {
            const url = new URL(req.url, "http://central.local");
            if (req.method === "POST" && url.pathname === "/api/settings/backup/restore") {
                if (!csrfAccepted(req, config)) return json(res, 403, { ok: false, error: "CSRF validation failed." });
                const actor = sessionActor(app, req);
                if (!actor || !(actor.builtIn === true || actor.role === "Admin" || actor.role === "SecAdmin")) {
                    return json(res, 403, { ok: false, error: "Permission denied." });
                }
                const body = await readBody(req);
                body.requestedBy = actor.username || actor.displayName || "unknown";
                return json(res, 202, await updaterRequest(config, "/backup/restore", { method: "POST", body: JSON.stringify(body) }));
            }
            return false;
        } catch (error) {
            if (!res.headersSent) return json(res, error.statusCode || 400, { ok: false, error: error.message || "Request failed." });
            res.destroy(error);
        }
    };
    app.router.prepend(handler);
    Object.assign(app, { version: VERSION });
    return app
}

module.exports = { registerMaintenance, VERSION };
