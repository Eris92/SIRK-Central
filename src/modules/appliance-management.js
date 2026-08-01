"use strict";

const { parseCookies, json } = require("../http/transport");
const { identityActive, hasPermission } = require("../rbac");

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
async function requestStatus(config) {
    const token = String(config.env.SIRK_UPDATER_TOKEN || "");
    if (token.length < 43) throw Object.assign(new Error("Updater is not configured."), { statusCode: 503 });
    const response = await fetch(updaterOrigin(config) + "/appliance/status", {
        headers: { Authorization: "Bearer " + token, Accept: "application/json" },
        signal: AbortSignal.timeout(30000)
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(response.status >= 500 ? "Appliance diagnostics failed." : result.error || "Appliance diagnostics rejected."), { statusCode: response.status });
    return result;
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
            return false;
        } catch (error) {
            return json(res, Number.isInteger(error.statusCode) ? error.statusCode : 500, {
                ok: false,
                error: Number.isInteger(error.statusCode) && error.statusCode < 500 ? error.message : "Internal service error."
            });
        }
    };
    app.router.prepend(handler);
    return app;
}

module.exports = { registerApplianceManagement, allowed, updaterOrigin, requestStatus };
