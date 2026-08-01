"use strict";

const { json, parseCookies, securityHeaders } = require("../http/transport");
const { hasPermission, identityActive } = require("../rbac");

const MAX_PROXY_BODY_BYTES = 8 * 1024 * 1024;
const PORTAL_ID_PATTERN = "[a-z0-9][a-z0-9-]{2,62}";

function sessionActor(app, req) {
    const token = String(parseCookies(req).sirk_central_session || "");
    return token && app.sessions ? app.sessions.get(token, true) : null;
}

function knownPortal(app, portalId) {
    return Boolean(app.portalStore && typeof app.portalStore.list === "function" &&
        app.portalStore.list().some(portal => portal.id === portalId));
}

function policyBlocksConnections(app) {
    const policies = app.securityCenter && typeof app.securityCenter.policies === "function"
        ? app.securityCenter.policies()
        : {};
    return policies.emergencyMode === true || policies.blockNewPortalConnections === true;
}

function portalAccess(app, actor, portalId) {
    if (!identityActive(actor) || !hasPermission(actor, "portals.connect")) {
        return { allowed: false, status: actor ? 403 : 401, error: actor ? "Permission denied." : "Authentication required." };
    }
    if (!knownPortal(app, portalId)) return { allowed: false, status: 404, error: "Portal not found." };
    const effective = app.accessStore && typeof app.accessStore.effective === "function"
        ? app.accessStore.effective(actor, portalId)
        : { allowed: false, capabilities: {} };
    if (!effective.allowed || effective.capabilities["portal.connect"] === "deny") {
        return { allowed: false, status: 403, error: "Portal access denied by team or local policy." };
    }
    if (effective.capabilities["portal.connect"] === "approval") {
        return { allowed: false, status: 409, error: "This operation requires approval.", approvalRequired: true };
    }
    return { allowed: true, effective };
}

async function readRawBody(req, limit = MAX_PROXY_BODY_BYTES) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > limit) throw Object.assign(new Error("Request body is too large."), { statusCode: 413 });
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
}

function portalCookies(req) {
    return String(req.headers.cookie || "")
        .split(";")
        .map(value => value.trim())
        .filter(value => value && !/^sirk_central_session=/i.test(value))
        .join("; ");
}

function rewriteLocation(value, prefix) {
    const location = String(value || "");
    if (!location) return "";
    if (location.startsWith("/")) return prefix + location;
    try {
        const parsed = new URL(location);
        return prefix + parsed.pathname + parsed.search + parsed.hash;
    } catch (_) {
        return location;
    }
}

function rewriteSetCookie(values, prefix) {
    const source = Array.isArray(values) ? values : values ? [values] : [];
    return source.map(value => {
        const parts = String(value)
            .split(";")
            .map(part => part.trim())
            .filter(part => part && !/^domain=/i.test(part) && !/^path=/i.test(part));
        parts.push("Path=" + prefix + "/");
        return parts.join("; ");
    });
}

function rewritePortalBody(body, contentType, prefix) {
    if (!/^(?:text\/|application\/(?:javascript|json))/i.test(String(contentType || ""))) return body;
    let text = body.toString("utf8");
    text = text.replace(/(["'`])\/(?!\/)/g, (_, quote) => quote + prefix + "/");
    text = text.replace(/(\b(?:href|src|action)=)\/(?!\/)/gi, (_, attribute) => attribute + prefix + "/");
    text = text.replace(/(url\(\s*)\/(?!\/)/gi, (_, opening) => opening + prefix + "/");
    return Buffer.from(text, "utf8");
}

function proxyRequestHeaders(req) {
    return {
        accept: String(req.headers.accept || "*/*"),
        "content-type": String(req.headers["content-type"] || ""),
        cookie: portalCookies(req),
        origin: String(req.headers.origin || ""),
        host: String(req.headers.host || ""),
        "accept-language": String(req.headers["accept-language"] || ""),
        "user-agent": String(req.headers["user-agent"] || "").slice(0, 1024),
        "x-sirk-csrf": String(req.headers["x-sirk-csrf"] || "")
    };
}

function responseStatus(value) {
    const status = Number(value);
    return Number.isInteger(status) && status >= 100 && status <= 599 ? status : 502;
}

function brokerErrorStatus(error) {
    const message = String(error && error.message || "");
    if (/timed out/i.test(message)) return 504;
    if (/offline|closed|shutting down/i.test(message)) return 503;
    return Number.isInteger(error && error.statusCode) ? error.statusCode : 502;
}

function registerPortalTunnel(app) {
    const connectPattern = new RegExp("^/api/portals/(" + PORTAL_ID_PATTERN + ")/connect$");
    const proxyPattern = new RegExp("^/connect/(" + PORTAL_ID_PATTERN + ")(/.*)?$");

    const handler = async (req, res) => {
        const url = new URL(req.url, "http://central.local");
        const connect = req.method === "POST" ? url.pathname.match(connectPattern) : null;
        const proxy = url.pathname.match(proxyPattern);
        if (!connect && !proxy) return false;

        try {
            const portalId = (connect || proxy)[1];
            const actor = sessionActor(app, req);
            const access = portalAccess(app, actor, portalId);
            if (!access.allowed) {
                return json(res, access.status, {
                    ok: false,
                    error: access.error,
                    approvalRequired: access.approvalRequired === true
                });
            }
            if (policyBlocksConnections(app)) {
                return json(res, 423, { ok: false, error: connect
                    ? "New Portal connections are blocked by the Central security policy."
                    : "Portal connections are blocked by the Central security policy." });
            }

            if (connect) {
                await readRawBody(req, 16384);
                const response = await app.broker.request(portalId, { kind: "portal-info" });
                const portal = response && response.portal;
                if (!portal || portal.id !== portalId) throw Object.assign(new Error("Portal identity response is invalid."), { statusCode: 502 });
                if (app.securityCenter) app.securityCenter.audit("portal.connected", actor, { portalId });
                return json(res, 200, { ok: true, portal, url: "/connect/" + portalId + "/" });
            }

            const body = await readRawBody(req);
            const portalPath = (proxy[2] || "/") + url.search;
            const response = await app.broker.request(portalId, {
                method: req.method,
                path: portalPath,
                headers: proxyRequestHeaders(req),
                bodyBase64: body.toString("base64")
            });
            if (!response || typeof response !== "object") throw Object.assign(new Error("Portal response is invalid."), { statusCode: 502 });

            const prefix = "/connect/" + portalId;
            const contentType = String(response.contentType || "application/octet-stream");
            const rawBody = Buffer.from(String(response.bodyBase64 || ""), "base64");
            const responseBody = rewritePortalBody(rawBody, contentType, prefix);
            const headers = Object.assign({}, securityHeaders(), {
                "Content-Type": contentType,
                "Content-Length": String(responseBody.length),
                "Cache-Control": "no-store",
                "Content-Security-Policy": "frame-ancestors 'none'; object-src 'none'; base-uri 'self'"
            });
            const location = rewriteLocation(response.location, prefix);
            const setCookie = rewriteSetCookie(response.setCookie, prefix);
            if (location) headers.Location = location;
            if (setCookie.length) headers["Set-Cookie"] = setCookie;
            res.writeHead(responseStatus(response.statusCode), headers);
            res.end(req.method === "HEAD" ? undefined : responseBody);
            return true;
        } catch (error) {
            const status = brokerErrorStatus(error);
            const message = status >= 500 ? (status === 504 ? "Portal request timed out." : "Portal connection is unavailable.") : error.message;
            if (!res.headersSent) return json(res, status, { ok: false, code: error.code || "PORTAL_TUNNEL_FAILED", error: message });
            res.destroy(error);
            return true;
        }
    };

    app.router.prepend(handler);
    return app;
}

module.exports = {
    registerPortalTunnel,
    portalCookies,
    rewriteLocation,
    rewriteSetCookie,
    rewritePortalBody,
    portalAccess,
    readRawBody
};
