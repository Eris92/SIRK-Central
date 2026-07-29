"use strict";

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { WebSocketServer } = require("ws");
const { verifySecret, verifyAccessKey, randomToken } = require("./security");
const portalStoreFactory = require("./portal-store");
const tunnelBrokerFactory = require("./tunnel-broker");

function loadConfig(env) {
    const config = {
        bindHost: env.SIRK_BIND_HOST || "127.0.0.1",
        port: Number(env.SIRK_PORT || 8080),
        publicOrigin: String(env.SIRK_PUBLIC_ORIGIN || "").replace(/\/+$/, ""),
        adminUsername: env.SIRK_ADMIN_USERNAME || "admin",
        adminPasswordHash: env.SIRK_ADMIN_PASSWORD_HASH || "",
        accessKeyHash: env.SIRK_ACCESS_KEY_HASH || "",
        dataDir: path.resolve(env.SIRK_DATA_DIR || path.join(process.cwd(), "data")),
        sessionHours: Math.max(1, Math.min(24, Number(env.SIRK_SESSION_HOURS || 8)))
    };
    if (!config.publicOrigin.startsWith("https://") && env.NODE_ENV === "production") {
        throw new Error("SIRK_PUBLIC_ORIGIN must use HTTPS in production.");
    }
    if (!config.adminPasswordHash.startsWith("scrypt$")) {
        throw new Error("SIRK_ADMIN_PASSWORD_HASH is required. Run npm run hash-password.");
    }
    if (!config.accessKeyHash.startsWith("sha256$")) {
        throw new Error("SIRK_ACCESS_KEY_HASH is required. Run npm run generate-access-key.");
    }
    if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
        throw new Error("SIRK_PORT is invalid.");
    }
    return config;
}

function createApp(config) {
    const store = portalStoreFactory.create({ dataDir: config.dataDir });
    const broker = tunnelBrokerFactory.create();
    const sessions = new Map();
    const loginFailures = new Map();
    const webRoot = path.join(__dirname, "..", "public");
    const wsServer = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });

    function json(res, status, body, headers) {
        const data = Buffer.from(JSON.stringify(body));
        res.writeHead(status, Object.assign({
            "Content-Type": "application/json; charset=utf-8",
            "Content-Length": data.length,
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff"
        }, headers || {}));
        res.end(data);
    }

    function parseCookies(req) {
        const result = {};
        for (const part of String(req.headers.cookie || "").split(";")) {
            const index = part.indexOf("=");
            if (index > 0) result[part.slice(0, index).trim()] = part.slice(index + 1).trim();
        }
        return result;
    }

    function session(req) {
        const token = parseCookies(req).sirk_central_session;
        const value = token && sessions.get(token);
        if (!value || value.expiresAt < Date.now()) {
            if (token) sessions.delete(token);
            return null;
        }
        return value;
    }

    function sameOrigin(req) {
        const origin = String(req.headers.origin || "");
        if (!origin) return true;
        return origin === config.publicOrigin;
    }

    function bearerCredential(req) {
        const match = String(req.headers.authorization || "").match(/^Bearer ([A-Za-z0-9_-]+)$/);
        return match ? match[1] : "";
    }

    function portalCredentials(req) {
        const match = String(req.headers.authorization || "").match(/^SIRK-Portal ([A-Za-z0-9_-]+)$/);
        if (!match) return null;
        try {
            const decoded = Buffer.from(match[1], "base64url").toString("utf8");
            const separator = decoded.indexOf(":");
            if (separator < 1) return null;
            return { id: decoded.slice(0, separator), token: decoded.slice(separator + 1) };
        } catch (_) {
            return null;
        }
    }

    function readBody(req, limit) {
        return new Promise((resolve, reject) => {
            const chunks = [];
            let size = 0;
            req.on("data", (chunk) => {
                size += chunk.length;
                if (size > limit) {
                    reject(Object.assign(new Error("Request body is too large."), { statusCode: 413 }));
                    req.destroy();
                    return;
                }
                chunks.push(chunk);
            });
            req.on("end", () => {
                try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
                catch (_) { reject(Object.assign(new Error("Invalid JSON body."), { statusCode: 400 })); }
            });
            req.on("error", reject);
        });
    }

    function requireSession(req, res) {
        const value = session(req);
        if (!value) json(res, 401, { ok: false, error: "Authentication required." });
        return value;
    }

    async function handler(req, res) {
        try {
            const url = new URL(req.url, "http://central.local");
            if (req.method === "GET" && url.pathname === "/healthz") {
                json(res, 200, { ok: true });
                return;
            }
            if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/connect/")) {
                if (!verifyAccessKey(bearerCredential(req), config.accessKeyHash)) {
                    return json(res, 404, { ok: false, error: "Not found." });
                }
            }
            if (req.method === "GET" && url.pathname === "/api/access") {
                json(res, 200, { ok: true });
                return;
            }
            if (req.method === "POST" && url.pathname === "/api/login") {
                if (!sameOrigin(req)) return json(res, 403, { ok: false, error: "Origin rejected." });
                const address = String(req.socket.remoteAddress || "unknown");
                const failure = loginFailures.get(address);
                if (failure && failure.blockedUntil > Date.now()) {
                    return json(res, 429, { ok: false, error: "Too many login attempts. Try again later." });
                }
                const body = await readBody(req, 16 * 1024);
                if (String(body.username || "") !== config.adminUsername ||
                    !verifySecret(String(body.password || ""), config.adminPasswordHash)) {
                    const attempts = failure && failure.expiresAt > Date.now() ? failure.attempts + 1 : 1;
                    loginFailures.set(address, {
                        attempts,
                        expiresAt: Date.now() + 15 * 60000,
                        blockedUntil: attempts >= 5 ? Date.now() + 15 * 60000 : 0
                    });
                    return json(res, 401, { ok: false, error: "Invalid username or password." });
                }
                loginFailures.delete(address);
                const token = randomToken(32);
                sessions.set(token, { username: config.adminUsername, expiresAt: Date.now() + config.sessionHours * 3600000 });
                const secureCookie = config.publicOrigin.startsWith("https://") ? "; Secure" : "";
                json(res, 200, { ok: true, username: config.adminUsername }, {
                    "Set-Cookie": "sirk_central_session=" + token + "; Path=/; HttpOnly; SameSite=Strict" +
                        secureCookie + "; Max-Age=" + (config.sessionHours * 3600)
                });
                return;
            }
            if (req.method === "POST" && url.pathname === "/api/logout") {
                const token = parseCookies(req).sirk_central_session;
                if (token) sessions.delete(token);
                json(res, 200, { ok: true }, {
                    "Set-Cookie": "sirk_central_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0"
                });
                return;
            }
            if (req.method === "GET" && url.pathname === "/api/session") {
                const value = session(req);
                return json(res, value ? 200 : 401, value
                    ? { ok: true, username: value.username }
                    : { ok: false, error: "Authentication required." });
            }
            if (url.pathname === "/api/portals" && req.method === "GET") {
                if (!requireSession(req, res)) return;
                return json(res, 200, { ok: true, portals: broker.list(store.list()) });
            }
            if (url.pathname === "/api/portals" && req.method === "POST") {
                if (!requireSession(req, res)) return;
                if (!sameOrigin(req)) return json(res, 403, { ok: false, error: "Origin rejected." });
                const created = store.createPortal(await readBody(req, 16 * 1024));
                return json(res, 201, { ok: true, portal: created });
            }
            const connectMatch = url.pathname.match(/^\/api\/portals\/([a-z0-9-]+)\/connect$/);
            if (connectMatch && req.method === "POST") {
                if (!requireSession(req, res)) return;
                if (!sameOrigin(req)) return json(res, 403, { ok: false, error: "Origin rejected." });
                const response = await broker.request(connectMatch[1], { kind: "portal-info" });
                return json(res, 200, { ok: true, portal: response.portal });
            }
            const proxyMatch = url.pathname.match(/^\/connect\/([a-z0-9-]+)(\/.*)?$/);
            if (proxyMatch) {
                if (!requireSession(req, res)) return;
                const bodyChunks = [];
                let bodySize = 0;
                for await (const chunk of req) {
                    bodySize += chunk.length;
                    if (bodySize > 8 * 1024 * 1024) throw Object.assign(new Error("Request body is too large."), { statusCode: 413 });
                    bodyChunks.push(chunk);
                }
                const response = await broker.request(proxyMatch[1], {
                    method: req.method,
                    path: (proxyMatch[2] || "/") + url.search,
                    headers: {
                        accept: req.headers.accept || "*/*",
                        "content-type": req.headers["content-type"] || "",
                        cookie: req.headers.cookie || ""
                    },
                    bodyBase64: Buffer.concat(bodyChunks).toString("base64")
                });
                const responseBody = Buffer.from(response.bodyBase64 || "", "base64");
                res.writeHead(Number(response.statusCode) || 502, {
                    "Content-Type": response.contentType || "application/octet-stream",
                    "Content-Length": responseBody.length,
                    "Cache-Control": "no-store",
                    "X-Content-Type-Options": "nosniff"
                });
                res.end(responseBody);
                return;
            }
            if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/app.js" || url.pathname === "/styles.css")) {
                const fileName = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
                const contentType = fileName.endsWith(".html") ? "text/html; charset=utf-8"
                    : fileName.endsWith(".js") ? "text/javascript; charset=utf-8" : "text/css; charset=utf-8";
                const data = fs.readFileSync(path.join(webRoot, fileName));
                res.writeHead(200, {
                    "Content-Type": contentType,
                    "Content-Length": data.length,
                    "Cache-Control": "no-store",
                    "X-Content-Type-Options": "nosniff",
                    "Content-Security-Policy": "default-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
                });
                res.end(data);
                return;
            }
            json(res, 404, { ok: false, error: "Not found." });
        } catch (error) {
            json(res, error.statusCode || 500, {
                ok: false,
                error: error.statusCode ? error.message : "Internal server error."
            });
        }
    }

    const server = http.createServer(handler);
    server.on("upgrade", (req, socket, head) => {
        const url = new URL(req.url, "http://central.local");
        if (url.pathname !== "/tunnel") return socket.destroy();
        const credentials = portalCredentials(req);
        const portal = credentials && store.authenticate(credentials.id, credentials.token);
        if (!portal) {
            socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
            return socket.destroy();
        }
        wsServer.handleUpgrade(req, socket, head, (webSocket) => broker.attach(portal, webSocket));
    });

    return { server, store, broker };
}

if (require.main === module) {
    const config = loadConfig(process.env);
    const app = createApp(config);
    app.server.listen(config.port, config.bindHost, () => {
        process.stdout.write("SIRK Portal Central listening on " + config.bindHost + ":" + config.port + "\n");
    });
}

module.exports = { loadConfig, createApp };
