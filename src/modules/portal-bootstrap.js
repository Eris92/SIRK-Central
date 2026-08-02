"use strict";

const { json, parseCookies, csrfAccepted, readBody } = require("../http/transport");
const { hasPermission, identityActive } = require("../rbac");

function sessionActor(app, req) {
    const token = String(parseCookies(req).sirk_central_session || "");
    return token && app.sessions ? app.sessions.get(token, true) : null;
}

function canManage(actor) {
    return Boolean(identityActive(actor) && hasPermission(actor, "portals.manage"));
}

function publicOrigin(config) {
    const value = String(config.publicOrigin || config.env.SIRK_PUBLIC_ORIGIN || "").replace(/\/+$/, "");
    if (!/^https:\/\/[^/]+(?::\d+)?$/i.test(value)) {
        throw Object.assign(new Error("Central public origin is not configured."), { statusCode: 503, code: "CENTRAL_PUBLIC_ORIGIN_INVALID" });
    }
    return value;
}

function bootstrapBundle(config, portal) {
    const origin = publicOrigin(config);
    return {
        schemaVersion: 1,
        centralUrl: origin,
        tunnelUrl: origin.replace(/^https:/i, "wss:") + "/tunnel",
        configUrl: origin + "/api/portal/v1/config",
        heartbeatUrl: origin + "/api/portal/v1/heartbeat",
        portalId: portal.id,
        portalName: portal.name,
        portalToken: portal.token,
        createdAtUtc: portal.createdAtUtc || new Date().toISOString()
    };
}

function audit(app, action, actor, req, portalId) {
    if (!app.auditStore || typeof app.auditStore.append !== "function") return;
    app.auditStore.append({
        action,
        category: "portals",
        result: "success",
        actor,
        request: {
            method: req.method,
            path: req.url,
            ip: String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim()
        },
        target: portalId,
        details: { credentialReturnedOnce: true }
    });
}

function registerPortalBootstrap(app, config) {
    const handler = async (req, res) => {
        const url = new URL(req.url, "http://central.local");
        const createRoute = req.method === "POST" && url.pathname === "/api/portals/bootstrap";
        const rotateMatch = req.method === "POST" ? url.pathname.match(/^\/api\/portals\/([a-z0-9][a-z0-9-]{2,62})\/bootstrap\/rotate$/) : null;
        if (!createRoute && !rotateMatch) return false;

        try {
            const actor = sessionActor(app, req);
            if (!canManage(actor)) {
                return json(res, actor ? 403 : 401, { ok: false, error: actor ? "Permission denied." : "Authentication required." });
            }
            if (!csrfAccepted(req, config)) {
                return json(res, 403, { ok: false, error: "CSRF validation failed." });
            }

            if (createRoute) {
                const body = await readBody(req, 16384);
                const portal = app.portalStore.createPortal({ id: body.id, name: body.name });
                const bundle = bootstrapBundle(config, portal);
                audit(app, "portal.bootstrap_created", actor, req, portal.id);
                return json(res, 201, { ok: true, bootstrap: bundle });
            }

            await readBody(req, 16384);
            const portal = app.portalStore.rotateToken(rotateMatch[1]);
            const bundle = bootstrapBundle(config, portal);
            audit(app, "portal.bootstrap_rotated", actor, req, portal.id);
            return json(res, 200, { ok: true, bootstrap: bundle });
        } catch (error) {
            const status = Number.isInteger(error.statusCode) ? error.statusCode : (/already exists/i.test(error.message || "") ? 409 : 400);
            return json(res, status, { ok: false, code: error.code || "PORTAL_BOOTSTRAP_REJECTED", error: error.message || "Portal bootstrap failed." });
        }
    };

    app.router.prepend(handler);
    return app;
}

module.exports = { registerPortalBootstrap, bootstrapBundle, publicOrigin, canManage };
