"use strict";

const { json, parseCookies, csrfAccepted, readBody } = require("../http/transport");
const { hasPermission, identityActive } = require("../rbac");
const { bootstrapBundle } = require("./portal-bootstrap");

function actor(app, req) {
    const token = String(parseCookies(req).sirk_central_session || "");
    return token && app.sessions ? app.sessions.get(token, true) : null;
}
function allowed(value) { return Boolean(identityActive(value) && hasPermission(value, "portals.manage")); }
function bearer(req) {
    const match = String(req.headers.authorization || "").match(/^Bearer\s+([^\s]+)$/i);
    return match ? match[1] : "";
}
function portalActor(id) { return { type: "portal", id, displayName: id }; }
function publicState(app, portal) {
    const online = app.broker && app.broker.list ? app.broker.list([portal])[0] : portal;
    return Object.assign({}, portal, {
        connected: Boolean(online && (online.connected || online.online)),
        connectionState: online && (online.connectionState || online.status) || "offline"
    });
}
function audit(app, action, value, details) {
    if (app.securityCenter && typeof app.securityCenter.audit === "function")
        app.securityCenter.audit(action, value, details || {});
}
function disconnect(app, id) {
    if (app.broker && typeof app.broker.disconnect === "function") {
        try { app.broker.disconnect(id); } catch (_) {}
    }
}

async function handleSelfService(app, config, req, res, url) {
    const selfMatch = url.pathname === "/api/portal/v1/connection";
    const selfRotate = url.pathname === "/api/portal/v1/connection/rotate";
    if (!selfMatch && !selfRotate) return false;

    const id = String(req.headers["x-sirk-portal-id"] || "").trim().toLowerCase();
    const portal = id && app.portalStore.authenticate(id, bearer(req));
    if (!portal) {
        json(res, 401, { ok: false, error: "Portal authentication failed." });
        return true;
    }

    if (req.method === "GET" && selfMatch) {
        json(res, 200, { ok: true, portal: publicState(app, portal) });
        return true;
    }
    if (req.method === "PATCH" && selfMatch) {
        const updated = app.portalStore.update(id, await readBody(req, 16384));
        audit(app, "portal.connection.self-updated", portalActor(id), { portalId: id, name: updated.name });
        json(res, 200, { ok: true, portal: publicState(app, updated) });
        return true;
    }
    if (req.method === "POST" && selfRotate) {
        await readBody(req, 16384);
        const rotated = app.portalStore.rotateToken(id);
        const bootstrap = bootstrapBundle(config, rotated);
        disconnect(app, id);
        audit(app, "portal.connection.self-rotated", portalActor(id), {
            portalId: id,
            credentialReturnedOnce: true
        });
        json(res, 200, { ok: true, bootstrap });
        return true;
    }
    if (req.method === "DELETE" && selfMatch) {
        await readBody(req, 16384);
        const removed = app.portalStore.remove(id);
        disconnect(app, id);
        audit(app, "portal.connection.self-removed", portalActor(id), { portalId: id });
        json(res, 200, { ok: true, portal: removed });
        return true;
    }

    json(res, 405, { ok: false, error: "Method not allowed." });
    return true;
}

function registerPortalConnectionAdmin(app, config) {
    const handler = async (req, res) => {
        const url = new URL(req.url, "http://central.local");
        try {
            if (await handleSelfService(app, config, req, res, url)) return true;

            const match = url.pathname.match(/^\/api\/portals\/([a-z0-9][a-z0-9-]{2,62})\/connection$/);
            const rotate = url.pathname.match(/^\/api\/portals\/([a-z0-9][a-z0-9-]{2,62})\/connection\/rotate$/);
            if (!match && !rotate) return false;

            const current = actor(app, req);
            if (!allowed(current)) {
                json(res, current ? 403 : 401, {
                    ok: false,
                    error: current ? "Permission denied." : "Authentication required."
                });
                return true;
            }

            const id = (match || rotate)[1];
            const portal = app.portalStore.get(id);
            if (!portal) {
                json(res, 404, { ok: false, error: "Portal was not found." });
                return true;
            }

            if (req.method === "GET" && match) {
                json(res, 200, { ok: true, portal: publicState(app, portal) });
                return true;
            }
            if (!csrfAccepted(req, config)) {
                json(res, 403, { ok: false, error: "CSRF validation failed." });
                return true;
            }

            if (req.method === "PATCH" && match) {
                const updated = app.portalStore.update(id, await readBody(req, 16384));
                audit(app, "portal.connection.updated", current, { portalId: id, name: updated.name });
                json(res, 200, { ok: true, portal: publicState(app, updated) });
                return true;
            }
            if (req.method === "POST" && rotate) {
                await readBody(req, 16384);
                const rotated = app.portalStore.rotateToken(id);
                const bootstrap = bootstrapBundle(config, rotated);
                disconnect(app, id);
                audit(app, "portal.connection.rotated", current, {
                    portalId: id,
                    credentialReturnedOnce: true
                });
                json(res, 200, { ok: true, bootstrap });
                return true;
            }
            if (req.method === "DELETE" && match) {
                await readBody(req, 16384);
                const removed = app.portalStore.remove(id);
                disconnect(app, id);
                audit(app, "portal.connection.removed", current, { portalId: id });
                json(res, 200, { ok: true, portal: removed });
                return true;
            }

            json(res, 405, { ok: false, error: "Method not allowed." });
            return true;
        } catch (error) {
            json(res, error.statusCode || 400, {
                ok: false,
                code: error.code || "PORTAL_CONNECTION_OPERATION_FAILED",
                error: error.message || "Portal connection operation failed."
            });
            return true;
        }
    };
    app.router.prepend(handler);
    return app;
}

module.exports = { registerPortalConnectionAdmin, allowed, bearer, handleSelfService };
