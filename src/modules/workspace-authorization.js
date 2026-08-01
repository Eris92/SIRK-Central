"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { json, parseCookies, securityHeaders, validToken } = require("../http/transport");

const WORKSPACES = Object.freeze({
    "/permissions": "permissions",
    "/security": "security",
    "/settings": "settings",
    "/break-glass": "break-glass",
    "/update": "update"
});

function isExactBreakGlass(identity) {
    return Boolean(identity && identity.status === "active" && identity.builtIn === true && identity.source === "local" && identity.role === "BreakGlass");
}

function allowedWorkspaces(identity) {
    if (!identity || identity.status !== "active") return ["portals"];
    if (isExactBreakGlass(identity)) return ["portals", "permissions", "security", "settings", "break-glass", "update"];
    if (identity.role === "Admin") return ["portals", "permissions", "settings", "update"];
    if (identity.role === "SecAdmin") return ["portals", "permissions", "security", "settings"];
    return ["portals"];
}

function sessionActor(app, req) {
    const token = String(parseCookies(req).sirk_central_session || "");
    return token && app.sessions ? app.sessions.get(token, true) : null;
}

function csrfCookie(req) {
    const current = String(parseCookies(req).sirk_central_csrf || "");
    const token = validToken(current) ? current : crypto.randomBytes(32).toString("base64url");
    return "sirk_central_csrf=" + token + "; Path=/; Secure; SameSite=Strict; Max-Age=28800";
}

function sendFile(req, res, filePath, contentType) {
    const data = fs.readFileSync(filePath);
    res.writeHead(200, Object.assign({}, securityHeaders(), {
        "Content-Type": contentType,
        "Content-Length": String(data.length),
        "Cache-Control": "no-store",
        "Content-Security-Policy": "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
        "Set-Cookie": csrfCookie(req)
    }));
    res.end(req.method === "HEAD" ? undefined : data);
}

function registerWorkspaceAuthorization(app) {
    const publicRoot = path.join(__dirname, "..", "..", "public");
    const handler = (req, res) => {
        const url = new URL(req.url, "http://central.local");
        if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/workspace-bootstrap.js") {
            const actor = sessionActor(app, req);
            const source = "window.__SIRK_WORKSPACE_BOOTSTRAP=" + JSON.stringify({
                authenticated: Boolean(actor),
                workspaces: allowedWorkspaces(actor)
            }) + ";\n";
            const data = Buffer.from(source, "utf8");
            res.writeHead(200, Object.assign({}, securityHeaders(), {
                "Content-Type": "text/javascript; charset=utf-8",
                "Content-Length": String(data.length),
                "Cache-Control": "no-store",
                "Set-Cookie": csrfCookie(req)
            }));
            res.end(req.method === "HEAD" ? undefined : data);
            return true;
        }

        const workspace = WORKSPACES[url.pathname];
        if (!workspace || (req.method !== "GET" && req.method !== "HEAD")) return false;
        const actor = sessionActor(app, req);
        if (!actor) {
            res.writeHead(302, { Location: "/", "Cache-Control": "no-store", "Content-Length": "0" });
            res.end();
            return true;
        }
        if (!allowedWorkspaces(actor).includes(workspace)) {
            return json(res, workspace === "break-glass" ? 404 : 403, {
                ok: false,
                error: workspace === "break-glass" ? "Not found." : "Workspace access denied."
            });
        }
        if (workspace === "update") return sendFile(req, res, path.join(publicRoot, "update.html"), "text/html; charset=utf-8") || true;
        return sendFile(req, res, path.join(publicRoot, "index.html"), "text/html; charset=utf-8") || true;
    };
    app.router.prepend(handler);
    return app;
}

module.exports = { registerWorkspaceAuthorization, allowedWorkspaces, isExactBreakGlass };
