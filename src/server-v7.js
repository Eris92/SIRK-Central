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
    const bridgePath = path.join(__dirname, "..", "public", "passkey-attestation-bridge.js");
    const uiPath = path.join(__dirname, "..", "public", "passkey-ui.js");
    const uiPolishPath = path.join(__dirname, "..", "public", "passkey-ui-polish.js");
    const passkeyCleanupPath = path.join(__dirname, "..", "public", "passkey-list-cleanup.js");
    const operationsUiPath = path.join(__dirname, "..", "public", "operations-ui.js");
    const operationsActionsPath = path.join(__dirname, "..", "public", "operations-actions.js");
    const centralUxPath = path.join(__dirname, "..", "public", "central-ux.js");
    const operationsBootstrapPath = path.join(__dirname, "..", "public", "operations-bootstrap.js");
    const updateStatusResiliencePath = path.join(__dirname, "..", "public", "update-status-resilience.js");
    const auditUiPath = path.join(__dirname, "..", "public", "audit-ui.js");
    const dashboardUiPath = path.join(__dirname, "..", "public", "dashboard-ui.js");
    const server = http.createServer((req, res) => {
        try {
            const url = new URL(req.url, "http://central.local");
            if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/passkey-ui.js") {
                const data = Buffer.concat([
                    fs.readFileSync(bridgePath),
                    Buffer.from("\n"),
                    fs.readFileSync(uiPath),
                    Buffer.from("\n"),
                    fs.readFileSync(uiPolishPath),
                    Buffer.from("\n"),
                    fs.readFileSync(passkeyCleanupPath),
                    Buffer.from("\n"),
                    fs.readFileSync(operationsUiPath),
                    Buffer.from("\n"),
                    fs.readFileSync(operationsActionsPath),
                    Buffer.from("\n"),
                    fs.readFileSync(centralUxPath),
                    Buffer.from("\n"),
                    fs.readFileSync(operationsBootstrapPath),
                    Buffer.from("\n"),
                    fs.readFileSync(updateStatusResiliencePath),
                    Buffer.from("\n"),
                    fs.readFileSync(auditUiPath),
                    Buffer.from("\n"),
                    fs.readFileSync(dashboardUiPath)
                ]);
                res.writeHead(200, Object.assign(securityHeaders(), { "Content-Type": "text/javascript; charset=utf-8", "Content-Length": String(data.length), "Cache-Control": "no-store" }));
                return res.end(req.method === "HEAD" ? undefined : data);
            }
            if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/passkey-attestation-bridge.js") {
                const data = fs.readFileSync(bridgePath);
                res.writeHead(200, Object.assign(securityHeaders(), { "Content-Type": "text/javascript; charset=utf-8", "Content-Length": String(data.length), "Cache-Control": "no-store" }));
                return res.end(req.method === "HEAD" ? undefined : data);
            }
            if (req.method === "GET" && url.pathname === "/readyz") {
                const checks = { passkeyStore: Boolean(app.passkeys && app.passkeys.filePath), webauthnChallenges: Boolean(app.webauthnChallenges && app.webauthnChallenges.filePath), loginTransactions: Boolean(app.loginTransactions && app.loginTransactions.filePath), passkeyUi: fs.existsSync(uiPath) && fs.existsSync(uiPolishPath) && fs.existsSync(passkeyCleanupPath) && fs.existsSync(operationsUiPath) && fs.existsSync(operationsActionsPath) && fs.existsSync(centralUxPath) && fs.existsSync(operationsBootstrapPath) && fs.existsSync(updateStatusResiliencePath) && fs.existsSync(auditUiPath) && fs.existsSync(dashboardUiPath), attestationBridge: fs.existsSync(bridgePath), attestationParser: true };
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
