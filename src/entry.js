"use strict";

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { loadConfig, createApp } = require("./server");

const WORKSPACES = Object.freeze({
    "/permissions": "admin",
    "/security": "security",
    "/settings": "settings",
    "/break-glass": "break-glass"
});

function isExactBreakGlass(identity) {
    return Boolean(identity && identity.ok && identity.builtIn === true && identity.source === "local" && identity.role === "BreakGlass");
}

function allowedWorkspaces(identity) {
    if (!identity || !identity.ok) return ["portals"];
    if (isExactBreakGlass(identity)) return ["portals", "admin", "security", "settings", "break-glass"];
    const result = ["portals"];
    if (identity.role === "Admin" || identity.role === "SysAdmin") result.push("admin", "settings");
    if (identity.role === "SecAdmin") result.push("security", "settings");
    return result;
}

function cloneRequest(req, url, method) {
    const clone = Object.create(req);
    Object.defineProperty(clone, "url", { value: url, writable: true, configurable: true });
    Object.defineProperty(clone, "method", { value: method || req.method, writable: true, configurable: true });
    return clone;
}

async function capture(handler, req) {
    let statusCode = 200;
    const headers = {};
    const chunks = [];
    let resolveFinished;
    const finished = new Promise(resolve => { resolveFinished = resolve; });
    const response = {
        statusCode: 200,
        headersSent: false,
        writableEnded: false,
        setHeader(name, value) { headers[String(name).toLowerCase()] = value; },
        getHeader(name) { return headers[String(name).toLowerCase()]; },
        removeHeader(name) { delete headers[String(name).toLowerCase()]; },
        writeHead(status, reasonOrHeaders, possibleHeaders) {
            statusCode = Number(status) || 200;
            this.statusCode = statusCode;
            const supplied = typeof reasonOrHeaders === "object" ? reasonOrHeaders : possibleHeaders;
            if (supplied) for (const [name, value] of Object.entries(supplied)) headers[String(name).toLowerCase()] = value;
            this.headersSent = true;
            return this;
        },
        write(chunk) {
            if (chunk !== undefined) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
            return true;
        },
        end(chunk) {
            if (chunk !== undefined) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
            this.writableEnded = true;
            resolveFinished();
        },
        on() { return this; },
        once() { return this; },
        emit() { return false; }
    };
    await Promise.resolve(handler(req, response));
    if (!response.writableEnded) await finished;
    return { statusCode, headers, body: Buffer.concat(chunks) };
}

function sendJson(res, status, body, headOnly) {
    const data = Buffer.from(JSON.stringify(body));
    res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": String(data.length),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff"
    });
    res.end(headOnly ? undefined : data);
}

function sendScript(res, source, headOnly) {
    const data = Buffer.from(source, "utf8");
    res.writeHead(200, {
        "Content-Type": "text/javascript; charset=utf-8",
        "Content-Length": String(data.length),
        "Cache-Control": "no-store, no-cache, must-revalidate",
        "Pragma": "no-cache",
        "X-Content-Type-Options": "nosniff"
    });
    res.end(headOnly ? undefined : data);
}

function redirect(res, location) {
    res.writeHead(302, { Location: location, "Cache-Control": "no-store", "Content-Length": "0" });
    res.end();
}

async function readIdentity(requestHandler, req) {
    const result = await capture(requestHandler, cloneRequest(req, "/api/session", "GET"));
    if (result.statusCode !== 200) return null;
    try { return JSON.parse(result.body.toString("utf8")); }
    catch (_) { return null; }
}

async function main() {
    const config = loadConfig(process.env);
    const app = createApp(config);
    const requestHandler = app.server.listeners("request")[0];
    const routingScript = fs.readFileSync(path.join(__dirname, "..", "public", "workspace-routing.js"));
    if (typeof requestHandler !== "function") throw new Error("SIRK Central request handler is unavailable.");

    const server = http.createServer(async (req, res) => {
        try {
            const url = new URL(req.url, "http://central.local");
            const workspace = WORKSPACES[url.pathname];
            const headOnly = req.method === "HEAD";

            if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/admin") {
                return redirect(res, "/permissions" + url.search);
            }

            if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/workspace-routing.js") {
                res.writeHead(200, {
                    "Content-Type": "text/javascript; charset=utf-8",
                    "Content-Length": String(routingScript.length),
                    "Cache-Control": "no-store",
                    "X-Content-Type-Options": "nosniff"
                });
                res.end(headOnly ? undefined : routingScript);
                return;
            }

            if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/workspace-bootstrap.js") {
                const identity = await readIdentity(requestHandler, req);
                const bootstrap = {
                    authenticated: Boolean(identity && identity.ok),
                    workspaces: allowedWorkspaces(identity)
                };
                return sendScript(res, "window.__SIRK_WORKSPACE_BOOTSTRAP=" + JSON.stringify(bootstrap) + ";\n", headOnly);
            }

            if (workspace && (req.method === "GET" || req.method === "HEAD")) {
                const identity = await readIdentity(requestHandler, req);
                if (!identity) return redirect(res, "/");

                if (!allowedWorkspaces(identity).includes(workspace)) {
                    if (workspace === "break-glass") return sendJson(res, 404, { ok: false, error: "Not found." }, headOnly);
                    return sendJson(res, 403, { ok: false, error: "Workspace access denied." }, headOnly);
                }

                return requestHandler(cloneRequest(req, "/" + url.search, headOnly ? "HEAD" : "GET"), res);
            }

            if (url.pathname.startsWith("/api/break-glass/")) {
                const identity = await readIdentity(requestHandler, req);
                if (!isExactBreakGlass(identity)) return sendJson(res, 404, { ok: false, error: "Not found." }, headOnly);
            }

            return requestHandler(req, res);
        } catch (error) {
            if (!res.headersSent) return sendJson(res, 500, { ok: false, error: "Workspace authorization failed." }, req.method === "HEAD");
            res.destroy(error);
        }
    });

    server.on("upgrade", (req, socket, head) => app.server.emit("upgrade", req, socket, head));
    server.listen(config.port, config.bindHost, () => process.stdout.write("SIRK Central listening on " + config.bindHost + ":" + config.port + "\n"));
}

if (require.main === module) main().catch(error => { process.stderr.write(String(error.stack || error) + "\n"); process.exitCode = 1; });

module.exports = { allowedWorkspaces, isExactBreakGlass };