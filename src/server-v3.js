"use strict";

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const {
    createHardenedApp,
    parseCookies,
    csrfAccepted,
    securityHeaders
} = require("./server-v2");
const { loadConfig } = require("./server-v1");

const VERSION = "1.0.0-rc.6";

function json(res, status, body) {
    const data = Buffer.from(JSON.stringify(body));
    res.writeHead(status, Object.assign({}, securityHeaders(), {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": String(data.length),
        "Cache-Control": "no-store"
    }));
    res.end(data);
}

function staticJavaScript(res, filePath, method) {
    const data = fs.readFileSync(filePath);
    res.writeHead(200, Object.assign({}, securityHeaders(), {
        "Content-Type": "text/javascript; charset=utf-8",
        "Content-Length": String(data.length),
        "Cache-Control": "no-store"
    }));
    res.end(method === "HEAD" ? undefined : data);
}

function createProductionApp(config) {
    const app = createHardenedApp(config);
    const innerHandler = app.server.listeners("request")[0];
    if (typeof innerHandler !== "function") throw new Error("SIRK Central v2 request handler is unavailable.");

    const mfaUiPath = path.join(__dirname, "..", "public", "break-glass-mfa.js");
    const server = http.createServer((req, res) => {
        try {
            const url = new URL(req.url, "http://central.local");

            if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/break-glass-mfa.js") {
                return staticJavaScript(res, mfaUiPath, req.method);
            }

            if (req.method === "GET" && url.pathname === "/readyz") {
                const checks = {
                    sessionStore: Boolean(app.sessions && app.sessions.filePath),
                    organizations: Boolean(app.organizations && app.organizations.filePath),
                    approvals: Boolean(app.approvals && app.approvals.filePath),
                    portalAssignments: Boolean(app.portalAssignments && app.portalAssignments.filePath),
                    recoveryCodes: Boolean(app.recoveryCodes && app.recoveryCodes.filePath),
                    webauthnChallenges: Boolean(app.webauthnChallenges && app.webauthnChallenges.filePath),
                    loginTransactions: Boolean(app.loginTransactions && app.loginTransactions.filePath),
                    mfaUi: fs.existsSync(mfaUiPath)
                };
                const ready = Object.values(checks).every(Boolean);
                return json(res, ready ? 200 : 503, { ok: ready, version: VERSION, checks });
            }

            if (req.method === "POST" && url.pathname === "/api/login/mfa/recovery") {
                const cookies = parseCookies(req);
                if (!csrfAccepted(req, config, cookies)) {
                    return json(res, 403, { ok: false, error: "CSRF validation failed." });
                }
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
    const app = createProductionApp(config);
    app.server.listen(config.port, config.bindHost, () => {
        process.stdout.write("SIRK Central v3 listening on " + config.bindHost + ":" + config.port + "\n");
    });
}

module.exports = { createProductionApp, VERSION };
