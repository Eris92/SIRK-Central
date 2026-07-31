"use strict";

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { createAttestationApp } = require("./server-v6");
const { loadConfig } = require("./server-v1");

const VERSION = "1.0.0-rc.10";

function securityHeaders() {
    return { "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer", "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Resource-Policy": "same-origin", "Strict-Transport-Security": "max-age=31536000; includeSubDomains" };
}
function json(res, status, body) {
    const data = Buffer.from(JSON.stringify(body));
    res.writeHead(status, Object.assign(securityHeaders(), { "Content-Type": "application/json; charset=utf-8", "Content-Length": String(data.length), "Cache-Control": "no-store" }));
    res.end(data);
}

function createRuntimeApp(config) {
    const app = createAttestationApp(config);
    const inner = app.server.listeners("request")[0];
    if (typeof inner !== "function") throw new Error("SIRK Central v6 request handler is unavailable.");
    const publicPath = name => path.join(__dirname, "..", "public", name);
    const bridgePath = publicPath("passkey-attestation-bridge.js");
    const scriptPaths = [
        publicPath("passkey-ui.js"),
        publicPath("passkey-ui-polish.js"),
        publicPath("passkey-list-cleanup.js"),
        publicPath("operations-ui.js"),
        publicPath("operations-actions.js"),
        publicPath("central-ux.js"),
        publicPath("operations-bootstrap.js"),
        publicPath("update-status-resilience.js"),
        publicPath("audit-ui.js"),
        publicPath("dashboard-css-loader.js"),
        publicPath("dashboard-ui.js"),
        publicPath("admin-tools-css-loader.js"),
        publicPath("admin-tools-ui.js"),
        publicPath("security-sessions-ui.js"),
        publicPath("approval-center-ui.js"),
        publicPath("portal-operations-ui.js"),
        publicPath("portal-monitoring-ui.js")
    ];
    const dashboardStylePath = publicPath("dashboard-ui.css");
    const adminToolsStylePath = publicPath("admin-tools-ui.css");
    const portalMonitoringStylePath = publicPath("portal-monitoring-ui.css");
    const server = http.createServer((req, res) => {
        try {
            const url = new URL(req.url, "http://central.local");
            if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/passkey-ui.js") {
                const chunks = [];
                for (const filePath of [bridgePath, ...scriptPaths]) {
                    if (chunks.length) chunks.push(Buffer.from("\n"));
                    chunks.push(fs.readFileSync(filePath));
                }
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
                const checks = {
                    passkeyStore: Boolean(app.passkeys && app.passkeys.filePath),
                    webauthnChallenges: Boolean(app.webauthnChallenges && app.webauthnChallenges.filePath),
                    loginTransactions: Boolean(app.loginTransactions && app.loginTransactions.filePath),
                    passkeyUi: [bridgePath, ...scriptPaths].every(fs.existsSync),
                    dashboardStyle: fs.existsSync(dashboardStylePath),
                    adminToolsStyle: fs.existsSync(adminToolsStylePath),
                    portalMonitoringStyle: fs.existsSync(portalMonitoringStylePath),
                    attestationBridge: fs.existsSync(bridgePath),
                    attestationParser: true
                };
                const ok = Object.values(checks).every(Boolean);
                return json(res, ok ? 200 : 503, { ok, version: VERSION, checks });
            }
            return inner(req, res);
        } catch (error) {
            if (!res.headersSent) return json(res, 500, { ok: false, error: error.message || "Request failed." });
            res.destroy(error);
        }
    });
    server.on("upgrade", (req, socket, head) => app.server.emit("upgrade", req, socket, head));
    return Object.assign({}, app, { server, version: VERSION });
}

if (require.main === module) {
    const config = loadConfig(process.env);
    const app = createRuntimeApp(config);
    app.server.listen(config.port, config.bindHost, () => process.stdout.write("SIRK Central v7 listening on " + config.bindHost + ":" + config.port + "\n"));
}

module.exports = { createRuntimeApp, VERSION };
