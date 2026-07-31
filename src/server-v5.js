"use strict";

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { createWebAuthnApp } = require("./server-v4");
const { loadConfig } = require("./server-v1");

const VERSION = "1.0.0-rc.8";

function securityHeaders() {
    return {
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
        "Referrer-Policy": "no-referrer",
        "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Resource-Policy": "same-origin",
        "Strict-Transport-Security": "max-age=31536000; includeSubDomains"
    };
}

function parseCookies(req) {
    const result = {};
    for (const part of String(req.headers.cookie || "").split(";")) {
        const index = part.indexOf("=");
        if (index > 0) result[part.slice(0, index).trim()] = part.slice(index + 1).trim();
    }
    return result;
}

function json(res, status, body) {
    const data = Buffer.from(JSON.stringify(body));
    res.writeHead(status, Object.assign({}, securityHeaders(), {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": String(data.length),
        "Cache-Control": "no-store"
    }));
    res.end(data);
}

function createFinalApp(config) {
    const app = createWebAuthnApp(config);
    const innerHandler = app.server.listeners("request")[0];
    if (typeof innerHandler !== "function") throw new Error("SIRK Central v4 request handler is unavailable.");
    const uiPath = path.join(__dirname, "..", "public", "passkey-ui.js");

    const server = http.createServer((req, res) => {
        try {
            const url = new URL(req.url, "http://central.local");
            if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/passkey-ui.js") {
                const data = fs.readFileSync(uiPath);
                res.writeHead(200, Object.assign({}, securityHeaders(), {
                    "Content-Type": "text/javascript; charset=utf-8",
                    "Content-Length": String(data.length),
                    "Cache-Control": "no-store"
                }));
                return res.end(req.method === "HEAD" ? undefined : data);
            }

            if (req.method === "GET" && url.pathname === "/api/break-glass/passkeys") {
                const token = parseCookies(req).sirk_central_session || "";
                const actor = token && app.sessions ? app.sessions.get(token, true) : null;
                if (!actor || actor.builtIn !== true || actor.source !== "local" || actor.role !== "BreakGlass") {
                    return json(res, 403, { ok: false, error: "Break-Glass session required." });
                }
                return json(res, 200, { ok: true, passkeys: app.passkeys.list(actor), rpId: new URL(config.publicOrigin).hostname });
            }

            if (req.method === "GET" && url.pathname === "/readyz") {
                const checks = {
                    passkeyStore: Boolean(app.passkeys && app.passkeys.filePath),
                    webauthnChallenges: Boolean(app.webauthnChallenges && app.webauthnChallenges.filePath),
                    loginTransactions: Boolean(app.loginTransactions && app.loginTransactions.filePath),
                    passkeyUi: fs.existsSync(uiPath)
                };
                return json(res, Object.values(checks).every(Boolean) ? 200 : 503, { ok: Object.values(checks).every(Boolean), version: VERSION, checks });
            }

            return innerHandler(req, res);
        } catch (error) {
            if (!res.headersSent) return json(res, error.statusCode || 500, { ok: false, error: error.message || "Request failed." });
            res.destroy(error);
        }
    });

    server.on("upgrade", (req, socket, head) => app.server.emit("upgrade", req, socket, head));
    return Object.assign({}, app, { server, version: VERSION });
}

if (require.main === module) {
    const config = loadConfig(process.env);
    const app = createFinalApp(config);
    app.server.listen(config.port, config.bindHost, () => process.stdout.write("SIRK Central v5 listening on " + config.bindHost + ":" + config.port + "\n"));
}

module.exports = { createFinalApp, VERSION };
