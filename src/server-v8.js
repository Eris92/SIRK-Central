"use strict";

const http = require("node:http");
const policy = require("./mfa-continuity-policy");
const { createRuntimeApp } = require("./server-v7");
const { loadConfig } = require("./server-v1");

const VERSION = "1.0.0-rc.10";

function parseCookies(req) {
    const result = {};
    for (const part of String(req.headers.cookie || "").split(";")) {
        const index = part.indexOf("=");
        if (index > 0) result[part.slice(0, index).trim()] = part.slice(index + 1).trim();
    }
    return result;
}

function breakGlassActor(app, req) {
    const token = parseCookies(req).sirk_central_session || "";
    const actor = token && app.sessions ? app.sessions.get(token, true) : null;
    if (!actor || actor.builtIn !== true || actor.source !== "local" || actor.role !== "BreakGlass") return null;
    return actor;
}

function csrfAccepted(req, config) {
    const cookies = parseCookies(req);
    const cookie = String(cookies.sirk_central_csrf || "");
    const supplied = String(req.headers["x-sirk-csrf"] || "");
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(cookie) || supplied !== cookie) return false;
    const origin = String(req.headers.origin || "");
    if (origin && origin !== config.publicOrigin) return false;
    const site = String(req.headers["sec-fetch-site"] || "");
    return !site || site === "same-origin" || site === "none";
}

function json(res, status, body) {
    const data = Buffer.from(JSON.stringify(body));
    res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": String(data.length),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
        "Referrer-Policy": "no-referrer"
    });
    res.end(data);
}

function createContinuityApp(config) {
    const app = createRuntimeApp(config);
    const inner = app.server.listeners("request")[0];
    if (typeof inner !== "function") throw new Error("SIRK Central v7 request handler is unavailable.");

    const server = http.createServer((req, res) => {
        try {
            const url = new URL(req.url, "http://central.local");
            const passkeyDelete = url.pathname.match(/^\/api\/break-glass\/passkeys\/([A-Za-z0-9_-]{16,512})$/);
            const recoveryDelete = url.pathname === "/api/break-glass/mfa/recovery-codes";

            if (req.method === "GET" && url.pathname === "/api/break-glass/mfa/continuity") {
                const actor = breakGlassActor(app, req);
                if (!actor) return json(res, 403, { ok: false, error: "Break-Glass session required." });
                return json(res, 200, { ok: true, continuity: policy.snapshot(app.passkeys, app.recoveryCodes, actor) });
            }

            if (req.method === "DELETE" && (passkeyDelete || recoveryDelete)) {
                if (!csrfAccepted(req, config)) return json(res, 403, { ok: false, error: "CSRF validation failed." });
                const actor = breakGlassActor(app, req);
                if (!actor) return json(res, 403, { ok: false, error: "Break-Glass session required." });

                if (passkeyDelete) {
                    policy.assertCanRevokePasskey(app.passkeys, app.recoveryCodes, actor, passkeyDelete[1]);
                } else {
                    policy.assertCanRevokeRecoveryCodes(app.passkeys, app.recoveryCodes, actor);
                }
            }

            if (req.method === "GET" && url.pathname === "/readyz") {
                const continuity = Boolean(app.passkeys && app.recoveryCodes);
                if (!continuity) return json(res, 503, { ok: false, version: VERSION, checks: { mfaContinuityPolicy: false } });
            }

            return inner(req, res);
        } catch (error) {
            if (!res.headersSent) return json(res, error.statusCode || 400, { ok: false, code: error.code || "REQUEST_REJECTED", error: error.message || "Request failed." });
            res.destroy(error);
        }
    });

    server.on("upgrade", (req, socket, head) => app.server.emit("upgrade", req, socket, head));
    return Object.assign({}, app, { server, version: VERSION });
}

if (require.main === module) {
    const config = loadConfig(process.env);
    const app = createContinuityApp(config);
    app.server.listen(config.port, config.bindHost, () => process.stdout.write("SIRK Central v8 listening on " + config.bindHost + ":" + config.port + "\n"));
}

module.exports = { createContinuityApp, VERSION, parseCookies, breakGlassActor, csrfAccepted };
