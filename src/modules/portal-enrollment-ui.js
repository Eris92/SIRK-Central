"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { parseCookies, securityHeaders } = require("../http/transport");
const { hasPermission, identityActive } = require("../rbac");

function sessionActor(app, req) {
    const token = String(parseCookies(req).sirk_central_session || "");
    return token && app.sessions ? app.sessions.get(token, true) : null;
}

function canManage(actor) {
    return Boolean(identityActive(actor) && hasPermission(actor, "portals.manage"));
}

function sendFile(res, method, filePath, contentType) {
    const data = fs.readFileSync(filePath);
    res.writeHead(200, Object.assign({}, securityHeaders(), {
        "Content-Type": contentType,
        "Content-Length": String(data.length),
        "Cache-Control": "no-store",
        "Content-Security-Policy": "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
    }));
    res.end(method === "HEAD" ? undefined : data);
}

function registerPortalEnrollmentUi(app) {
    const publicRoot = path.resolve(__dirname, "..", "..", "public");
    const files = {
        "/portal-enrollment": ["portal-enrollment.html", "text/html; charset=utf-8"],
        "/portal-enrollment.js": ["portal-enrollment.js", "text/javascript; charset=utf-8"],
        "/portal-enrollment.css": ["portal-enrollment.css", "text/css; charset=utf-8"]
    };

    const handler = async (req, res) => {
        if (req.method !== "GET" && req.method !== "HEAD") return false;
        const url = new URL(req.url, "http://central.local");
        const file = files[url.pathname];
        if (!file) return false;

        const actor = sessionActor(app, req);
        if (!actor) {
            res.writeHead(302, Object.assign({}, securityHeaders(), {
                "Location": "/login",
                "Cache-Control": "no-store",
                "Content-Length": "0"
            }));
            res.end();
            return true;
        }
        if (!canManage(actor)) {
            const body = Buffer.from("Permission denied.");
            res.writeHead(403, Object.assign({}, securityHeaders(), {
                "Content-Type": "text/plain; charset=utf-8",
                "Content-Length": String(body.length),
                "Cache-Control": "no-store"
            }));
            res.end(req.method === "HEAD" ? undefined : body);
            return true;
        }

        sendFile(res, req.method, path.join(publicRoot, file[0]), file[1]);
        return true;
    };

    app.router.prepend(handler);
    return app;
}

module.exports = { registerPortalEnrollmentUi, canManage };
