"use strict";

const { json, parseCookies, csrfAccepted, readBody } = require("../http/transport");
const { hasPermission, identityActive } = require("../rbac");
const { bootstrapBundle } = require("./portal-bootstrap");

function actor(app, req) {
    const token = String(parseCookies(req).sirk_central_session || "");
    return token && app.sessions ? app.sessions.get(token, true) : null;
}
function allowed(value) { return Boolean(identityActive(value) && hasPermission(value, "portals.manage")); }
function publicState(app, portal) {
    const online = app.broker && app.broker.list ? app.broker.list([portal])[0] : portal;
    return Object.assign({}, portal, {
        connected: Boolean(online && (online.connected || online.online)),
        connectionState: online && (online.connectionState || online.status) || "offline"
    });
}
function audit(app, action, value, details) {
    if (app.securityCenter && typeof app.securityCenter.audit === "function") app.securityCenter.audit(action, value, details || {});
}

function registerPortalConnectionAdmin(app, config) {
    const handler = async (req, res) => {
        const url = new URL(req.url, "http://central.local");
        const match = url.pathname.match(/^\/api\/portals\/([a-z0-9][a-z0-9-]{2,62})\/connection$/);
        const rotate = url.pathname.match(/^\/api\/portals\/([a-z0-9][a-z0-9-]{2,62})\/connection\/rotate$/);
        if (!match && !rotate) return false;
        try {
            const current = actor(app, req);
            if (!allowed(current)) return json(res, current ? 403 : 401, { ok: false, error: current ? "Permission denied." : "Authentication required." });
            const id = (match || rotate)[1];
            const portal = app.portalStore.get(id);
            if (!portal) return json(res, 404, { ok: false, error: "Portal was not found." });

            if (req.method === "GET" && match) return json(res, 200, { ok: true, portal: publicState(app, portal) });
            if (!csrfAccepted(req, config)) return json(res, 403, { ok: false, error: "CSRF validation failed." });

            if (req.method === "PATCH" && match) {
                const updated = app.portalStore.update(id, await readBody(req, 16384));
                audit(app, "portal.connection.updated", current, { portalId: id, name: updated.name });
                return json(res, 200, { ok: true, portal: publicState(app, updated) });
            }
            if (req.method === "POST" && rotate) {
                await readBody(req, 16384);
                const rotated = app.portalStore.rotateToken(id);
                const bootstrap = bootstrapBundle(config, rotated);
                audit(app, "portal.connection.rotated", current, { portalId: id, credentialReturnedOnce: true });
                return json(res, 200, { ok: true, bootstrap });
            }
            if (req.method === "DELETE" && match) {
                await readBody(req, 16384);
                const removed = app.portalStore.remove(id);
                if (!removed) return json(res, 404, { ok: false, error: "Portal was not found." });
                if (app.broker && typeof app.broker.disconnect === "function") {
                    try { app.broker.disconnect(id); } catch (_) {}
                }
                audit(app, "portal.connection.removed", current, { portalId: id });
                return json(res, 200, { ok: true, portal: removed });
            }
            return json(res, 405, { ok: false, error: "Method not allowed." });
        } catch (error) {
            return json(res, error.statusCode || 400, { ok: false, code: error.code || "PORTAL_CONNECTION_OPERATION_FAILED", error: error.message || "Portal connection operation failed." });
        }
    };
    app.router.prepend(handler);
    return app;
}

module.exports = { registerPortalConnectionAdmin, allowed };
