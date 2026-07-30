"use strict";

const http = require("node:http");
const { loadConfig, createApp } = require("./server");

const WORKSPACES = Object.freeze({
    "/admin": "admin",
    "/security": "security",
    "/settings": "settings",
    "/break-glass": "break-glass"
});

function isExactBreakGlass(identity) {
    return Boolean(identity && identity.ok && identity.builtIn === true && identity.source === "local" && identity.role === "BreakGlass");
}

function allowedWorkspaces(identity) {
    if (!identity || !identity.ok) return [];
    if (isExactBreakGlass(identity)) return ["portals", "admin", "security", "settings", "break-glass"];
    const result = ["portals"];
    if (identity.role === "Admin") result.push("admin", "settings");
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

function redirect(res, location) {
    res.writeHead(302, { Location: location, "Cache-Control": "no-store", "Content-Length": "0" });
    res.end();
}

async function main() {
    const config = loadConfig(process.env);
    const app = createApp(config);
    const requestHandler = app.server.listeners("request")[0];
    if (typeof requestHandler !== "function") throw new Error("SIRK Central request handler is unavailable.");

    const server = http.createServer(async (req, res) => {
        try {
            const url = new URL(req.url, "http://central.local");
            const workspace = WORKSPACES[url.pathname];
            const headOnly = req.method === "HEAD";

            if (workspace && (req.method === "GET" || req.method === "HEAD")) {
                const sessionResult = await capture(requestHandler, cloneRequest(req, "/api/session", "GET"));
                if (sessionResult.statusCode !== 200) return redirect(res, "/");

                let identity;
                try { identity = JSON.parse(sessionResult.body.toString("utf8")); }
                catch (_) { return redirect(res, "/"); }

                if (!allowedWorkspaces(identity).includes(workspace)) {
                    if (workspace === "break-glass") return sendJson(res, 404, { ok: false, error: "Not found." }, headOnly);
                    return sendJson(res, 403, { ok: false, error: "Workspace access denied." }, headOnly);
                }

                const forwarded = cloneRequest(req, "/" + url.search, headOnly ? "HEAD" : "GET");
                return requestHandler(forwarded, res);
            }

            if (url.pathname.startsWith("/api/break-glass/")) {
                const sessionResult = await capture(requestHandler, cloneRequest(req, "/api/session", "GET"));
                let identity = null;
                if (sessionResult.statusCode === 200) {
                    try { identity = JSON.parse(sessionResult.body.toString("utf8")); } catch (_) {}
                }
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
