"use strict";

const { securityHeaders, json } = require("../http/transport");

const fs = require("node:fs");
const path = require("node:path");

const { VERSION } = require("../version");


function registerUiAssets(app, config) {
    const publicPath = name => path.join(__dirname, "..", "..", "public", name);
    const bridgePath = publicPath("passkey-attestation-bridge.js");
    const scriptPaths = [
        publicPath("access-url-cleanup.js"),
        publicPath("passkey-ui.js"), publicPath("passkey-ui-polish.js"), publicPath("passkey-list-cleanup.js"),
        publicPath("operations-ui.js"), publicPath("operations-actions.js"), publicPath("central-ux.js"), publicPath("operations-bootstrap.js"),
        publicPath("update-status-resilience.js"), publicPath("audit-ui.js"), publicPath("dashboard-css-loader.js"), publicPath("dashboard-ui.js"),
        publicPath("admin-tools-css-loader.js"), publicPath("admin-tools-ui.js"), publicPath("security-sessions-ui.js"),
        publicPath("approval-center-ui.js"), publicPath("portal-operations-ui.js"), publicPath("portal-monitoring-ui.js"), publicPath("tickets-ui.js")
    ];
    const stylePaths = [publicPath("dashboard-ui.css"), publicPath("admin-tools-ui.css"), publicPath("portal-monitoring-ui.css"), publicPath("tickets-ui.css")];
    const handler = (req, res) => {
        try {
            const url = new URL(req.url, "http://central.local");
            if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/passkey-ui.js") {
                const chunks = [];
                for (const filePath of [bridgePath, ...scriptPaths]) { if (chunks.length) chunks.push(Buffer.from("\n")); chunks.push(fs.readFileSync(filePath)); }
                const data = Buffer.concat(chunks);
                res.writeHead(200, Object.assign(securityHeaders(), { "Content-Type": "text/javascript; charset=utf-8", "Content-Length": String(data.length), "Cache-Control": "no-store" }));
                return res.end(req.method === "HEAD" ? undefined : data);
            }
            if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/passkey-attestation-bridge.js") {
                const data = fs.readFileSync(bridgePath);
                res.writeHead(200, Object.assign(securityHeaders(), { "Content-Type": "text/javascript; charset=utf-8", "Content-Length": String(data.length), "Cache-Control": "no-store" }));
                return res.end(req.method === "HEAD" ? undefined : data);
            }
            if (req.method === "GET" && url.pathname === "/readyz") {
                const checks = { passkeyStore: Boolean(app.passkeys && app.passkeys.filePath), webauthnChallenges: Boolean(app.webauthnChallenges && app.webauthnChallenges.filePath), loginTransactions: Boolean(app.loginTransactions && app.loginTransactions.filePath), passkeyUi: [bridgePath, ...scriptPaths].every(fs.existsSync), uiStyles: stylePaths.every(fs.existsSync), attestationBridge: fs.existsSync(bridgePath), attestationParser: true };
                const ok = Object.values(checks).every(Boolean); return json(res, ok ? 200 : 503, { ok, version: VERSION, checks });
            }
            return false;
        } catch (error) {
            process.stderr.write("[central] " + String(error.stack || error) + "\n");
            if (!res.headersSent) return json(res, 500, { ok: false, error: "Internal server error." });
            res.destroy(error);
        }
    };
    app.router.prepend(handler);
    Object.assign(app, { version: VERSION });
    return app
}

module.exports = { registerUiAssets, VERSION };
