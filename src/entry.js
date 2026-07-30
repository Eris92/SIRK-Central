"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { loadConfig, createApp } = require("./server");

const WORKSPACES = Object.freeze({
    "/permissions": "permissions",
    "/security": "security",
    "/settings": "settings",
    "/break-glass": "break-glass",
    "/update": "update"
});

const UPDATE_FILES = Object.freeze({
    "/system-update.js": ["system-update.js", "text/javascript; charset=utf-8"],
    "/system-update.css": ["system-update.css", "text/css; charset=utf-8"]
});

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const CSRF_COOKIE = "sirk_central_csrf";
const CSRF_HEADER = "x-sirk-csrf";

function isExactBreakGlass(identity) {
    return Boolean(identity && identity.ok && identity.builtIn === true && identity.source === "local" && identity.role === "BreakGlass");
}

function canManageUpdates(identity) {
    return Boolean(identity && identity.ok && (isExactBreakGlass(identity) || (identity.role === "Admin" && identity.builtIn !== true)));
}

function allowedWorkspaces(identity) {
    if (!identity || !identity.ok) return ["portals"];
    if (isExactBreakGlass(identity)) return ["portals", "permissions", "security", "settings", "break-glass", "update"];
    const result = ["portals"];
    if (identity.role === "Admin") result.push("permissions", "settings", "update");
    if (identity.role === "SecAdmin") result.push("permissions", "security", "settings");
    return result;
}

function parseCookies(req) {
    const result = {};
    for (const part of String(req.headers.cookie || "").split(";")) {
        const index = part.indexOf("=");
        if (index > 0) result[part.slice(0, index).trim()] = part.slice(index + 1).trim();
    }
    return result;
}

function validCsrfToken(value) {
    return /^[A-Za-z0-9_-]{32,128}$/.test(String(value || ""));
}

function csrfCookie(token) {
    return CSRF_COOKIE + "=" + token + "; Path=/; Secure; SameSite=Strict; Max-Age=28800";
}

function csrfScript() {
    return `"use strict";\n(function(){\n  function cookie(name){for(const part of document.cookie.split(";")){const p=part.trim();if(p.startsWith(name+"="))return p.slice(name.length+1);}return "";}\n  const original=window.fetch.bind(window);\n  window.fetch=function(input,init){\n    init=Object.assign({},init||{});\n    const method=String(init.method||((input&&input.method)||"GET")).toUpperCase();\n    let same=true;try{const u=new URL(typeof input==="string"?input:input.url,location.href);same=u.origin===location.origin;}catch(_){same=true;}\n    if(same&&!(["GET","HEAD","OPTIONS"].includes(method))){const token=cookie("${CSRF_COOKIE}");const headers=new Headers(init.headers||((input&&input.headers)||undefined));if(token)headers.set("X-SIRK-CSRF",token);init.headers=headers;}\n    init.credentials=init.credentials||"same-origin";\n    return original(input,init);\n  };\n}());\n`;
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

function sendJson(res, status, body, headOnly, extraHeaders) {
    const data = Buffer.from(JSON.stringify(body));
    res.writeHead(status, Object.assign({
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": String(data.length),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff"
    }, extraHeaders || {}));
    res.end(headOnly ? undefined : data);
}

function sendScript(res, source, headOnly, extraHeaders) {
    const data = Buffer.from(source, "utf8");
    res.writeHead(200, Object.assign({
        "Content-Type": "text/javascript; charset=utf-8",
        "Content-Length": String(data.length),
        "Cache-Control": "no-store, no-cache, must-revalidate",
        "Pragma": "no-cache",
        "X-Content-Type-Options": "nosniff"
    }, extraHeaders || {}));
    res.end(headOnly ? undefined : data);
}

function sendFile(res, filePath, contentType, headOnly, extraHeaders) {
    const data = fs.readFileSync(filePath);
    res.writeHead(200, Object.assign({
        "Content-Type": contentType,
        "Content-Length": String(data.length),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
    }, extraHeaders || {}));
    res.end(headOnly ? undefined : data);
}

function redirect(res, location) {
    res.writeHead(302, { Location: location, "Cache-Control": "no-store", "Content-Length": "0" });
    res.end();
}

function forwardCaptured(res, captured, body, extraHeaders) {
    const headers = Object.assign({}, captured.headers, extraHeaders || {});
    delete headers["content-length"];
    headers["content-length"] = String(body.length);
    res.writeHead(captured.statusCode, headers);
    res.end(body);
}

async function readIdentity(requestHandler, req) {
    const result = await capture(requestHandler, cloneRequest(req, "/api/session", "GET"));
    if (result.statusCode !== 200) return null;
    try { return JSON.parse(result.body.toString("utf8")); }
    catch (_) { return null; }
}

function sameOrigin(req, publicOrigin) {
    const origin = String(req.headers.origin || "");
    return !origin || origin === publicOrigin;
}

function redactSessionSecrets(value) {
    if (Array.isArray(value)) return value.map(redactSessionSecrets);
    if (!value || typeof value !== "object") return value;
    const output = {};
    for (const [key, child] of Object.entries(value)) {
        if (key === "token" || key === "sessionToken" || key === "cookie") continue;
        output[key] = redactSessionSecrets(child);
    }
    return output;
}

async function callUpdater(updaterOrigin, updaterToken, route, method, body) {
    if (!updaterOrigin || updaterToken.length < 43) {
        const error = new Error("Web updater is not configured.");
        error.statusCode = 503;
        throw error;
    }
    const response = await fetch(updaterOrigin + route, {
        method,
        headers: {
            Accept: "application/json",
            Authorization: "Bearer " + updaterToken,
            "Content-Type": "application/json"
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(10000)
    });
    const payload = await response.json().catch(() => ({ ok: false, error: "Updater returned an invalid response." }));
    if (!response.ok) {
        const error = new Error(payload.error || "Updater request failed.");
        error.statusCode = response.status;
        throw error;
    }
    return payload;
}

async function main() {
    const config = loadConfig(process.env);
    const app = createApp(config);
    const requestHandler = app.server.listeners("request")[0];
    const publicRoot = path.join(__dirname, "..", "public");
    const routingScript = Buffer.concat([
        fs.readFileSync(path.join(publicRoot, "workspace-routing.js")),
        Buffer.from("\n"),
        fs.readFileSync(path.join(publicRoot, "update-link.js"))
    ]);
    const updaterOrigin = String(process.env.SIRK_UPDATER_ORIGIN || "").replace(/\/+$/, "");
    const updaterToken = String(process.env.SIRK_UPDATER_TOKEN || "");
    if (typeof requestHandler !== "function") throw new Error("SIRK Central request handler is unavailable.");

    const server = http.createServer(async (req, res) => {
        try {
            const url = new URL(req.url, "http://central.local");
            const workspace = WORKSPACES[url.pathname];
            const headOnly = req.method === "HEAD";
            const cookies = parseCookies(req);
            let csrfToken = cookies[CSRF_COOKIE];
            if (!validCsrfToken(csrfToken)) csrfToken = crypto.randomBytes(32).toString("base64url");
            const csrfHeaders = { "Set-Cookie": csrfCookie(csrfToken) };

            if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/csrf-bootstrap.js") {
                return sendScript(res, csrfScript(), headOnly, csrfHeaders);
            }

            if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/workspace-routing.js") {
                res.writeHead(200, {
                    "Content-Type": "text/javascript; charset=utf-8",
                    "Content-Length": String(routingScript.length),
                    "Cache-Control": "no-store",
                    "X-Content-Type-Options": "nosniff",
                    "Set-Cookie": csrfCookie(csrfToken)
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
                return sendScript(res, "window.__SIRK_WORKSPACE_BOOTSTRAP=" + JSON.stringify(bootstrap) + ";\n", headOnly, csrfHeaders);
            }

            if (!SAFE_METHODS.has(req.method) && url.pathname.startsWith("/api/") && url.pathname !== "/api/login") {
                const supplied = String(req.headers[CSRF_HEADER] || "");
                const origin = String(req.headers.origin || "");
                const site = String(req.headers["sec-fetch-site"] || "");
                if (!validCsrfToken(cookies[CSRF_COOKIE]) || supplied !== cookies[CSRF_COOKIE]) {
                    return sendJson(res, 403, { ok: false, error: "CSRF validation failed." }, false, csrfHeaders);
                }
                if (origin && origin !== config.publicOrigin) {
                    return sendJson(res, 403, { ok: false, error: "Origin rejected." }, false, csrfHeaders);
                }
                if (site && site !== "same-origin" && site !== "none") {
                    return sendJson(res, 403, { ok: false, error: "Cross-site request rejected." }, false, csrfHeaders);
                }
            }

            if (UPDATE_FILES[url.pathname] && (req.method === "GET" || req.method === "HEAD")) {
                const identity = await readIdentity(requestHandler, req);
                if (!identity) return redirect(res, "/");
                if (!canManageUpdates(identity)) return sendJson(res, 403, { ok: false, error: "Update access denied." }, headOnly, csrfHeaders);
                const [fileName, contentType] = UPDATE_FILES[url.pathname];
                return sendFile(res, path.join(publicRoot, fileName), contentType, headOnly, csrfHeaders);
            }

            if (workspace && (req.method === "GET" || req.method === "HEAD")) {
                const identity = await readIdentity(requestHandler, req);
                if (!identity) return redirect(res, "/");
                if (!allowedWorkspaces(identity).includes(workspace)) {
                    if (workspace === "break-glass") return sendJson(res, 404, { ok: false, error: "Not found." }, headOnly, csrfHeaders);
                    return sendJson(res, 403, { ok: false, error: "Workspace access denied." }, headOnly, csrfHeaders);
                }
                if (workspace === "update") {
                    let html = fs.readFileSync(path.join(publicRoot, "update.html"), "utf8");
                    if (!html.includes("/csrf-bootstrap.js")) html = html.replace("</head>", "<script src=\"/csrf-bootstrap.js\"></script></head>");
                    const body = Buffer.from(html, "utf8");
                    res.writeHead(200, {
                        "Content-Type": "text/html; charset=utf-8",
                        "Content-Length": String(body.length),
                        "Cache-Control": "no-store",
                        "X-Content-Type-Options": "nosniff",
                        "Set-Cookie": csrfCookie(csrfToken),
                        "Content-Security-Policy": "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
                    });
                    return res.end(headOnly ? undefined : body);
                }
                const captured = await capture(requestHandler, cloneRequest(req, "/" + url.search, headOnly ? "HEAD" : "GET"));
                let body = captured.body;
                if (!headOnly && /text\/html/i.test(String(captured.headers["content-type"] || ""))) {
                    let html = body.toString("utf8");
                    if (!html.includes("/csrf-bootstrap.js")) html = html.replace("</head>", "<script src=\"/csrf-bootstrap.js\"></script></head>");
                    body = Buffer.from(html, "utf8");
                }
                return forwardCaptured(res, captured, body, csrfHeaders);
            }

            if (url.pathname === "/api/system-update/status" && req.method === "GET") {
                const identity = await readIdentity(requestHandler, req);
                if (!canManageUpdates(identity)) return sendJson(res, 403, { ok: false, error: "Update access denied." }, false, csrfHeaders);
                const result = await callUpdater(updaterOrigin, updaterToken, "/status", "GET");
                return sendJson(res, 200, result, false, csrfHeaders);
            }

            if (url.pathname === "/api/system-update/run" && req.method === "POST") {
                const identity = await readIdentity(requestHandler, req);
                if (!canManageUpdates(identity)) return sendJson(res, 403, { ok: false, error: "Update access denied." }, false, csrfHeaders);
                if (!sameOrigin(req, config.publicOrigin)) return sendJson(res, 403, { ok: false, error: "Origin rejected." }, false, csrfHeaders);
                if (String(req.headers["x-sirk-update-confirm"] || "") !== "UPDATE SIRK CENTRAL") return sendJson(res, 400, { ok: false, error: "Update confirmation is invalid." }, false, csrfHeaders);
                const requestedBy = [identity.source, identity.identityKey || identity.username || "unknown"].filter(Boolean).join(":");
                const result = await callUpdater(updaterOrigin, updaterToken, "/run", "POST", { confirm: "UPDATE SIRK CENTRAL", requestedBy });
                if (app.securityCenter && typeof app.securityCenter.audit === "function") app.securityCenter.audit("system.update.requested", identity, { requestedBy });
                return sendJson(res, 202, result, false, csrfHeaders);
            }

            if (url.pathname.startsWith("/api/break-glass/")) {
                const identity = await readIdentity(requestHandler, req);
                if (!isExactBreakGlass(identity)) return sendJson(res, 404, { ok: false, error: "Not found." }, headOnly, csrfHeaders);
            }

            if (req.method === "GET" && (url.pathname === "/api/security/overview" || url.pathname === "/api/security/sessions")) {
                const captured = await capture(requestHandler, req);
                if (!/application\/json/i.test(String(captured.headers["content-type"] || ""))) return forwardCaptured(res, captured, captured.body, csrfHeaders);
                let parsed;
                try { parsed = JSON.parse(captured.body.toString("utf8")); }
                catch (_) { return forwardCaptured(res, captured, captured.body, csrfHeaders); }
                const body = Buffer.from(JSON.stringify(redactSessionSecrets(parsed)), "utf8");
                return forwardCaptured(res, captured, body, csrfHeaders);
            }

            if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/") {
                const captured = await capture(requestHandler, req);
                let body = captured.body;
                if (!headOnly && /text\/html/i.test(String(captured.headers["content-type"] || ""))) {
                    let html = body.toString("utf8");
                    if (!html.includes("/csrf-bootstrap.js")) html = html.replace("</head>", "<script src=\"/csrf-bootstrap.js\"></script></head>");
                    body = Buffer.from(html, "utf8");
                }
                return forwardCaptured(res, captured, body, csrfHeaders);
            }

            return requestHandler(req, res);
        } catch (error) {
            if (!res.headersSent) return sendJson(res, error.statusCode || 500, { ok: false, error: error.message || "Workspace authorization failed." }, req.method === "HEAD");
            res.destroy(error);
        }
    });

    server.on("upgrade", (req, socket, head) => app.server.emit("upgrade", req, socket, head));
    server.listen(config.port, config.bindHost, () => process.stdout.write("SIRK Central listening on " + config.bindHost + ":" + config.port + "\n"));
}

if (require.main === module) main().catch(error => { process.stderr.write(String(error.stack || error) + "\n"); process.exitCode = 1; });

module.exports = { allowedWorkspaces, isExactBreakGlass, canManageUpdates, redactSessionSecrets, validCsrfToken };
