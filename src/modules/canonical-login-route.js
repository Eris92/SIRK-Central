"use strict";

function parseCookies(req) {
    const result = {};
    for (const part of String(req.headers.cookie || "").split(";")) {
        const index = part.indexOf("=");
        if (index > 0) result[part.slice(0, index).trim()] = part.slice(index + 1).trim();
    }
    return result;
}

function redirect(res, location) {
    res.writeHead(302, {
        Location: location,
        "Cache-Control": "no-store",
        "Content-Length": "0"
    });
    res.end();
}

function registerCanonicalLoginRoute(app) {
    const handler = (req, res) => {
        if (req.method !== "GET" && req.method !== "HEAD") return false;

        const url = new URL(req.url, "http://central.local");
        if (url.pathname !== "/" && url.pathname !== "/login") return false;

        const token = parseCookies(req).sirk_central_session || "";
        const session = token && app.sessions ? app.sessions.get(token, false) : null;

        if (url.pathname === "/" && !session) {
            redirect(res, "/login" + url.search);
            return true;
        }

        if (url.pathname === "/login" && session) {
            redirect(res, "/");
            return true;
        }

        if (url.pathname === "/login") {
            req.url = "/" + url.search;
        }

        return false;
    };

    app.router.prepend(handler);
    return app;
}

module.exports = { registerCanonicalLoginRoute };
