"use strict";

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { WebSocketServer } = require("ws");
const { verifySecret, verifyAccessKey, randomToken } = require("./security");
const { verify: verifySsoTicket } = require("./sso-ticket");
const portalStoreFactory = require("./portal-store");
const tunnelBrokerFactory = require("./tunnel-broker");

function loadConfig(env) {
    const config = {
        bindHost: env.SIRK_BIND_HOST || "127.0.0.1",
        port: Number(env.SIRK_PORT || 8080),
        publicOrigin: String(env.SIRK_PUBLIC_ORIGIN || "").replace(/\/+$/, ""),
        authOrigin: String(env.SIRK_AUTH_ORIGIN || "").replace(/\/+$/, ""),
        ssoSharedSecret: String(env.SIRK_SSO_SHARED_SECRET || ""),
        adminUsername: env.SIRK_ADMIN_USERNAME || "admin",
        adminPasswordHash: env.SIRK_ADMIN_PASSWORD_HASH || "",
        accessKeyHash: env.SIRK_ACCESS_KEY_HASH || "",
        dataDir: path.resolve(env.SIRK_DATA_DIR || path.join(process.cwd(), "data")),
        sessionHours: Math.max(1, Math.min(24, Number(env.SIRK_SESSION_HOURS || 8)))
    };
    if (!config.publicOrigin.startsWith("https://") && env.NODE_ENV === "production") {
        throw new Error("SIRK_PUBLIC_ORIGIN must use HTTPS in production.");
    }
    if (!config.adminPasswordHash.startsWith("scrypt$")) throw new Error("SIRK_ADMIN_PASSWORD_HASH is required.");
    if (!config.accessKeyHash.startsWith("sha256$")) throw new Error("SIRK_ACCESS_KEY_HASH is required.");
    if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) throw new Error("SIRK_PORT is invalid.");
    if ((config.authOrigin && !config.ssoSharedSecret) || (!config.authOrigin && config.ssoSharedSecret)) {
        throw new Error("SIRK_AUTH_ORIGIN and SIRK_SSO_SHARED_SECRET must be configured together.");
    }
    if (config.authOrigin && (!config.authOrigin.startsWith("https://") || config.ssoSharedSecret.length < 43)) {
        throw new Error("SIRK Auth Broker configuration is invalid.");
    }
    return config;
}

function createApp(config) {
    const store = portalStoreFactory.create({ dataDir: config.dataDir });
    const broker = tunnelBrokerFactory.create();
    const sessions = new Map();
    const loginFailures = new Map();
    const usedSsoTickets = new Map();
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

    function redirect(res, location, headers) {
        res.writeHead(302, Object.assign({ Location: location, "Cache-Control": "no-store", "Content-Length": "0" }, headers || {}));
        res.end();
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

    function createSession(identity) {
        const token = randomToken(32);
        sessions.set(token, Object.assign({}, identity, { expiresAt: Date.now() + config.sessionHours * 3600000 }));
        return token;
    }

    function sessionCookie(token) {
        return "sirk_central_session=" + token + "; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=" + (config.sessionHours * 3600);
    }

    function sameOrigin(req) {
        const origin = String(req.headers.origin || "");
        return !origin || origin === config.publicOrigin;
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
            return separator < 1 ? null : { id: decoded.slice(0, separator), token: decoded.slice(separator + 1) };
        } catch (_) { return null; }
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
                } else chunks.push(chunk);
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

    function portalCookies(req) {
        return String(req.headers.cookie || "").split(";").map((value) => value.trim())
            .filter((value) => value && !/^sirk_central_session=/i.test(value)).join("; ");
    }

    function rewriteLocation(value, prefix) {
        value = String(value || "");
        if (!value) return "";
        if (value.startsWith("/")) return prefix + value;
        try {
            const parsed = new URL(value);
            return prefix + parsed.pathname + parsed.search + parsed.hash;
        } catch (_) { return value; }
    }

    function rewriteSetCookie(values, prefix) {
        return (Array.isArray(values) ? values : []).map((value) => {
            const parts = String(value).split(";").map((part) => part.trim())
                .filter((part) => !/^domain=/i.test(part) && !/^path=/i.test(part));
            parts.push("Path=" + prefix + "/");
            return parts.join("; ");
        });
    }

    function rewritePortalBody(body, contentType, prefix) {
        if (!/^(?:text\/|application\/(?:javascript|json))/i.test(String(contentType || ""))) return body;
        let text = body.toString("utf8");
        text = text.replace(/(["'`])\/(?!\/)/g, (_, quote) => quote + prefix + "/");
        text = text.replace(/(\b(?:href|src|action)=)\/(?!\/)/gi, (_, attribute) => attribute + prefix + "/");
        text = text.replace(/(url\(\s*)\/(?!\/)/gi, (_, opening) => opening + prefix + "/");
        return Buffer.from(text);
    }

    async function handler(req, res) {
        try {
            const url = new URL(req.url, "http://central.local");
            if (req.method === "GET" && url.pathname === "/healthz") return json(res, 200, { ok: true });

            if (req.method === "GET" && url.pathname === "/auth/sso/callback") {
                if (!config.authOrigin) return json(res, 404, { ok: false, error: "Not found." });
                for (const [jti, expiresAt] of usedSsoTickets) if (expiresAt < Date.now()) usedSsoTickets.delete(jti);
                const ticket = verifySsoTicket(url.searchParams.get("ticket"), config.ssoSharedSecret, {
                    issuer: config.authOrigin,
                    audience: config.publicOrigin
                });
                if (usedSsoTickets.has(ticket.jti)) throw Object.assign(new Error("SSO ticket was already used."), { statusCode: 401 });
                usedSsoTickets.set(ticket.jti, ticket.exp * 1000);
                const token = createSession({
                    username: ticket.username || ticket.name,
                    displayName: ticket.name,
                    identityKey: ticket.tid + ":" + ticket.oid,
                    tenantId: ticket.tid,
                    objectId: ticket.oid,
                    source: "entra"
                });
                return redirect(res, "/", { "Set-Cookie": sessionCookie(token) });
            }

            if (req.method === "GET" && url.pathname === "/api/access") {
                if (!verifyAccessKey(bearerCredential(req), config.accessKeyHash)) return json(res, 404, { ok: false, error: "Not found." });
                return json(res, 200, { ok: true });
            }

            if (req.method === "POST" && url.pathname === "/api/login") {
                if (!verifyAccessKey(bearerCredential(req), config.accessKeyHash)) return json(res, 404, { ok: false, error: "Not found." });
                if (!sameOrigin(req)) return json(res, 403, { ok: false, error: "Origin rejected." });
                const address = String(req.socket.remoteAddress || "unknown");
                const failure = loginFailures.get(address);
                if (failure && failure.blockedUntil > Date.now()) return json(res, 429, { ok: false, error: "Too many login attempts. Try again later." });
                const body = await readBody(req, 16 * 1024);
                if (String(body.username || "") !== config.adminUsername || !verifySecret(String(body.password || ""), config.adminPasswordHash)) {
                    const attempts = failure && failure.expiresAt > Date.now() ? failure.attempts + 1 : 1;
                    loginFailures.set(address, { attempts, expiresAt: Date.now() + 15 * 60000, blockedUntil: attempts >= 5 ? Date.now() + 15 * 60000 : 0 });
                    return json(res, 401, { ok: false, error: "Invalid username or password." });
                }
                loginFailures.delete(address);
                const token = createSession({ username: config.adminUsername, displayName: config.adminUsername, source: "local" });
                return json(res, 200, { ok: true, username: config.adminUsername, source: "local" }, { "Set-Cookie": sessionCookie(token) });
            }

            if (req.method === "POST" && url.pathname === "/api/logout") {
                const token = parseCookies(req).sirk_central_session;
                const value = token && sessions.get(token);
                if (token) sessions.delete(token);
                return json(res, 200, { ok: true, logoutUrl: value && value.source === "entra" && config.authOrigin ? config.authOrigin + "/logout" : "" }, {
                    "Set-Cookie": "sirk_central_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0"
                });
            }

            if (req.method === "GET" && url.pathname === "/api/session") {
                const value = session(req);
                return json(res, value ? 200 : 401, value ? {
                    ok: true,
                    username: value.username,
                    displayName: value.displayName,
                    source: value.source
                } : { ok: false, error: "Authentication required." });
            }

            if (url.pathname === "/api/portals" && req.method === "GET") {
                if (!requireSession(req, res)) return;
                return json(res, 200, { ok: true, portals: broker.list(store.list()) });
            }
            if (url.pathname === "/api/portals" && req.method === "POST") {
                if (!requireSession(req, res)) return;
                if (!sameOrigin(req)) return json(res, 403, { ok: false, error: "Origin rejected." });
                return json(res, 201, { ok: true, portal: store.createPortal(await readBody(req, 16 * 1024)) });
            }
            const connectMatch = url.pathname.match(/^\/api\/portals\/([a-z0-9-]+)\/connect$/);
            if (connectMatch && req.method === "POST") {
                if (!requireSession(req, res)) return;
                if (!sameOrigin(req)) return json(res, 403, { ok: false, error: "Origin rejected." });
                const response = await broker.request(connectMatch[1], { kind: "portal-info" });
                return json(res, 200, { ok: true, portal: response.portal, url: "/connect/" + connectMatch[1] + "/" });
            }

            const proxyMatch = url.pathname.match(/^\/connect\/([a-z0-9-]+)(\/.*)?$/);
            if (proxyMatch) {
                if (!requireSession(req, res)) return;
                const chunks = [];
                let size = 0;
                for await (const chunk of req) {
                    size += chunk.length;
                    if (size > 8 * 1024 * 1024) throw Object.assign(new Error("Request body is too large."), { statusCode: 413 });
                    chunks.push(chunk);
                }
                const response = await broker.request(proxyMatch[1], {
                    method: req.method,
                    path: (proxyMatch[2] || "/") + url.search,
                    headers: {
                        accept: req.headers.accept || "*/*",
                        "content-type": req.headers["content-type"] || "",
                        cookie: portalCookies(req),
                        origin: req.headers.origin || "",
                        host: req.headers.host || "",
                        "accept-language": req.headers["accept-language"] || "",
                        "x-sirk-csrf": req.headers["x-sirk-csrf"] || ""
                    },
                    bodyBase64: Buffer.concat(chunks).toString("base64")
                });
                const prefix = "/connect/" + proxyMatch[1];
                const contentType = response.contentType || "application/octet-stream";
                const responseBody = rewritePortalBody(Buffer.from(response.bodyBase64 || "", "base64"), contentType, prefix);
                const headers = {
                    "Content-Type": contentType,
                    "Content-Length": responseBody.length,
                    "Cache-Control": "no-store",
                    "X-Content-Type-Options": "nosniff",
                    "Content-Security-Policy": "frame-ancestors 'none'; object-src 'none'; base-uri 'self'"
                };
                const location = rewriteLocation(response.location, prefix);
                const setCookie = rewriteSetCookie(response.setCookie, prefix);
                if (location) headers.Location = location;
                if (setCookie.length) headers["Set-Cookie"] = setCookie;
                res.writeHead(Number(response.statusCode) || 502, headers);
                res.end(responseBody);
                return;
            }

            if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/app.js" || url.pathname === "/styles.css")) {
                const fileName = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
                const contentType = fileName.endsWith(".html") ? "text/html; charset=utf-8" : fileName.endsWith(".js") ? "text/javascript; charset=utf-8" : "text/css; charset=utf-8";
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
            return json(res, 404, { ok: false, error: "Not found." });
        } catch (error) {
            return json(res, error.statusCode || 500, { ok: false, error: error.statusCode ? error.message : "Internal server error." });
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
        process.stdout.write("SIRK Central listening on " + config.bindHost + ":" + config.port + "\n");
    });
}

module.exports = { loadConfig, createApp };
