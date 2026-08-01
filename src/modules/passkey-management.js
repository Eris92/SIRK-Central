"use strict";

const { securityHeaders, parseCookies, json } = require("../http/transport");

const fs = require("node:fs");
const path = require("node:path");

const { VERSION } = require("../version");




function registerPasskeyManagement(app, config) {
    const uiPath = path.join(__dirname, "..", "..", "public", "passkey-ui.js");

    const handler = (req, res) => {
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

module.exports = { registerPasskeyManagement, VERSION };
