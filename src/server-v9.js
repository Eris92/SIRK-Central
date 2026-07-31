"use strict";

const http = require("node:http");
const { createContinuityApp, parseCookies } = require("./server-v8");
const { loadConfig } = require("./server-v1");

const VERSION = "1.0.0-rc.13";

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
function readBody(req, limit = 65536) {
    return new Promise((resolve, reject) => {
        const chunks = []; let size = 0;
        req.on("data", chunk => {
            size += chunk.length;
            if (size > limit) {
                reject(Object.assign(new Error("Request body is too large."), { statusCode: 413 }));
                req.destroy();
            } else chunks.push(chunk);
        });
        req.on("end", () => {
            try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
            catch (_) { reject(Object.assign(new Error("Invalid JSON body."), { statusCode: 400 })); }
        });
        req.on("error", reject);
    });
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
function sessionActor(app, req) {
    const token = parseCookies(req).sirk_central_session || "";
    return token && app.sessions ? app.sessions.get(token, true) : null;
}
async function updaterRequest(config, path, options) {
    const origin = String(config.env.SIRK_UPDATER_ORIGIN || "http://updater:8090").replace(/\/+$/, "");
    const token = String(config.env.SIRK_UPDATER_TOKEN || "");
    if (token.length < 43) throw Object.assign(new Error("Updater is not configured."), { statusCode: 503 });
    const response = await fetch(origin + path, Object.assign({
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
        signal: AbortSignal.timeout(30000)
    }, options || {}));
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(body.error || "Updater request failed."), { statusCode: response.status });
    return body;
}

function createRestoreApp(config) {
    const app = createContinuityApp(config);
    const inner = app.server.listeners("request")[0];
    if (typeof inner !== "function") throw new Error("SIRK Central v8 request handler is unavailable.");

    const server = http.createServer(async (req, res) => {
        try {
            const url = new URL(req.url, "http://central.local");
            if (req.method === "POST" && url.pathname === "/api/settings/backup/restore") {
                if (!csrfAccepted(req, config)) return json(res, 403, { ok: false, error: "CSRF validation failed." });
                const actor = sessionActor(app, req);
                if (!actor || !(actor.builtIn === true || actor.role === "Admin" || actor.role === "SecAdmin")) {
                    return json(res, 403, { ok: false, error: "Permission denied." });
                }
                const body = await readBody(req);
                body.requestedBy = actor.username || actor.displayName || "unknown";
                return json(res, 202, await updaterRequest(config, "/backup/restore", { method: "POST", body: JSON.stringify(body) }));
            }
            return inner(req, res);
        } catch (error) {
            if (!res.headersSent) return json(res, error.statusCode || 400, { ok: false, error: error.message || "Request failed." });
            res.destroy(error);
        }
    });
    server.on("upgrade", (req, socket, head) => app.server.emit("upgrade", req, socket, head));
    return Object.assign({}, app, { server, version: VERSION });
}

if (require.main === module) {
    const config = loadConfig(process.env);
    const app = createRestoreApp(config);
    app.server.listen(config.port, config.bindHost, () => process.stdout.write("SIRK Central v9 listening on " + config.bindHost + ":" + config.port + "\n"));
}

module.exports = { createRestoreApp, VERSION };
