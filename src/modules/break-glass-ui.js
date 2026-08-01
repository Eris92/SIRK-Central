"use strict";

const { json, securityHeaders, parseCookies, csrfAccepted } = require("../http/transport");

const fs = require("node:fs");
const path = require("node:path");

const { VERSION } = require("../version");


function staticJavaScript(res, filePath, method) {
    const data = fs.readFileSync(filePath);
    res.writeHead(200, Object.assign({}, securityHeaders(), {
        "Content-Type": "text/javascript; charset=utf-8",
        "Content-Length": String(data.length),
        "Cache-Control": "no-store"
    }));
    res.end(method === "HEAD" ? undefined : data);
}

function registerBreakGlassUi(app, config) {

    const mfaUiPath = path.join(__dirname, "..", "..", "public", "break-glass-mfa.js");
    const handler = (req, res) => {
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

            return false;
        } catch (error) {
            if (!res.headersSent) return json(res, error.statusCode || 500, { ok: false, error: error.message || "Request failed." });
            res.destroy(error);
        }
    };
    app.router.prepend(handler);
    Object.assign(app, { version: VERSION });
    return app
}

module.exports = { registerBreakGlassUi, VERSION };
