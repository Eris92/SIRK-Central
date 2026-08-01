"use strict";

const { VERSION } = require("./version");

const fs = require("node:fs");
const http = require("node:http");
const routerFactory = require("./http/router");
const path = require("node:path");
const { WebSocketServer } = require("ws");
const { verifySecret, verifyAccessKey, randomToken, hashAccessKey } = require("./security");
const { verify: verifySsoTicket } = require("./sso-ticket");
const { permissionsFor, hasPermission, ASSIGNABLE_ROLES, ROLE_PERMISSIONS } = require("./rbac");
const portalStoreFactory = require("./portal-store");
const userStoreFactory = require("./user-store");
const providerStoreFactory = require("./identity-provider-store");
const accessStoreFactory = require("./access-store");
const tunnelBrokerFactory = require("./tunnel-broker");
const securityCenterFactory = require("./security-center-store");
const sessionStoreFactory = require("./session-store");
const organizationStoreFactory = require("./organization-store");
const approvalStoreFactory = require("./approval-store");
const portalAssignmentStoreFactory = require("./portal-assignment-store");
const organizationApiFactory = require("./organization-api");
const portalAssignmentApiFactory = require("./portal-assignment-api");

function loadConfig(env = process.env) {
    const config = {
        bindHost: env.SIRK_BIND_HOST || "127.0.0.1",
        port: Number(env.SIRK_PORT || 8080),
        publicOrigin: String(env.SIRK_PUBLIC_ORIGIN || "").replace(/\/+$/, ""),
        authOrigin: String(env.SIRK_AUTH_ORIGIN || "").replace(/\/+$/, ""),
        ssoSharedSecret: String(env.SIRK_SSO_SHARED_SECRET || ""),
        adminUsername: String(env.SIRK_ADMIN_USERNAME || "admin"),
        adminPasswordHash: String(env.SIRK_ADMIN_PASSWORD_HASH || ""),
        accessKeyHash: String(env.SIRK_ACCESS_KEY_HASH || ""),
        dataDir: path.resolve(env.SIRK_DATA_DIR || path.join(process.cwd(), "data")),
        sessionIdleMinutes: Math.max(5, Math.min(1440, Number(env.SIRK_SESSION_IDLE_MINUTES || 30))),
        sessionAbsoluteHours: Math.max(1, Math.min(168, Number(env.SIRK_SESSION_ABSOLUTE_HOURS || 8))),
        trustProxy: String(env.SIRK_TRUST_PROXY || "").toLowerCase() === "true",
        env
    };
    if (env.NODE_ENV === "production" && !config.publicOrigin.startsWith("https://")) throw new Error("SIRK_PUBLIC_ORIGIN must use HTTPS in production.");
    if (!config.adminPasswordHash.startsWith("scrypt$")) throw new Error("SIRK_ADMIN_PASSWORD_HASH is required.");
    if (!config.accessKeyHash.startsWith("sha256$")) throw new Error("SIRK_ACCESS_KEY_HASH is required.");
    if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) throw new Error("SIRK_PORT is invalid.");
    if ((config.authOrigin && !config.ssoSharedSecret) || (!config.authOrigin && config.ssoSharedSecret)) throw new Error("SIRK_AUTH_ORIGIN and SIRK_SSO_SHARED_SECRET must be configured together.");
    return config;
}

function createApplication(config) {
    const portalStore = portalStoreFactory.create({ dataDir: config.dataDir });
    const userStore = userStoreFactory.create({ dataDir: config.dataDir });
    const providerStore = providerStoreFactory.create({ dataDir: config.dataDir, authOrigin: config.authOrigin, env: config.env });
    const accessStore = accessStoreFactory.create({ dataDir: config.dataDir });
    const securityCenter = securityCenterFactory.create({ dataDir: config.dataDir });
    const sessions = sessionStoreFactory.create({ dataDir: config.dataDir, idleMinutes: config.sessionIdleMinutes, absoluteHours: config.sessionAbsoluteHours });
    const organizations = organizationStoreFactory.create({ dataDir: config.dataDir });
    const approvals = approvalStoreFactory.create({ dataDir: config.dataDir });
    const portalAssignments = portalAssignmentStoreFactory.create({ dataDir: config.dataDir });
    const broker = tunnelBrokerFactory.create();
    const loginFailures = new Map();
    const usedSsoTickets = new Map();
    const webRoot = path.join(__dirname, "..", "public");
    const wsServer = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });

    function json(res, status, body, headers = {}) {
        const data = Buffer.from(JSON.stringify(body));
        res.writeHead(status, Object.assign({
            "Content-Type": "application/json; charset=utf-8",
            "Content-Length": String(data.length),
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff"
        }, headers));
        res.end(data);
    }

    function redirect(res, location, headers = {}) {
        res.writeHead(302, Object.assign({ Location: location, "Cache-Control": "no-store", "Content-Length": "0" }, headers));
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

    function currentSessionToken(req) { return parseCookies(req).sirk_central_session || ""; }
    function requestIp(req) {
        if (config.trustProxy) {
            const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
            if (forwarded) return forwarded.slice(0, 128);
        }
        return String(req.socket.remoteAddress || "unknown").slice(0, 128);
    }
    function currentSession(req, touch = true) {
        const token = currentSessionToken(req);
        return token ? sessions.get(token, touch) : null;
    }
    function issueSession(identity, req) {
        return sessions.issue(Object.assign({}, identity, { permissions: permissionsFor(identity.role, identity.builtIn) }), {
            ip: requestIp(req),
            userAgent: String(req.headers["user-agent"] || "")
        }).token;
    }
    function invalidateIdentitySessions(identityKey) {
        if (!identityKey) return 0;
        return sessions.revokeWhere(record => record.identityKey === identityKey);
    }
    function invalidateBreakGlassSessions(exceptToken = "") {
        return sessions.revokeWhere(record => record.builtIn === true && record.source === "local", exceptToken);
    }
    function sessionCookie(token) {
        return "sirk_central_session=" + token + "; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=" + (config.sessionAbsoluteHours * 3600);
    }
    function clearSessionCookie() { return "sirk_central_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0"; }
    function sameOrigin(req) {
        const origin = String(req.headers.origin || "");
        return !origin || origin === config.publicOrigin;
    }
    function bearerCredential(req) {
        const match = String(req.headers.authorization || "").match(/^Bearer ([A-Za-z0-9_-]+)$/);
        return match ? match[1] : "";
    }
    function effectiveSecurity() {
        const overrides = userStore.securityOverrides();
        return {
            passwordHash: overrides.breakGlassPasswordHash || config.adminPasswordHash,
            accessKeyHash: overrides.accessKeyHash || config.accessKeyHash
        };
    }
    function requireSession(req, res) {
        const actor = currentSession(req);
        if (!actor) json(res, 401, { ok: false, error: "Authentication required." });
        return actor;
    }
    function requirePermission(req, res, permission) {
        const actor = requireSession(req, res);
        if (!actor) return null;
        if (!hasPermission(actor, permission)) {
            json(res, 403, { ok: false, error: "Permission denied." });
            return null;
        }
        return actor;
    }
    function readBody(req, limit = 65536) {
        return new Promise((resolve, reject) => {
            const chunks = [];
            let size = 0;
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
    function publicSessions() {
        return sessions.list().map(value => ({
            id: value.id,
            username: value.username,
            displayName: value.displayName,
            identityKey: value.identityKey || null,
            source: value.source,
            role: value.builtIn ? "BreakGlass" : value.role,
            status: value.status || "active",
            ip: value.ip || "",
            userAgent: value.userAgent || "",
            createdAtUtc: new Date(value.createdAt).toISOString(),
            lastSeenAtUtc: new Date(value.lastSeenAt).toISOString(),
            idleExpiresAtUtc: new Date(value.idleExpiresAt).toISOString(),
            absoluteExpiresAtUtc: new Date(value.absoluteExpiresAt).toISOString()
        }));
    }
    function portalCredentials(req) {
        const match = String(req.headers.authorization || "").match(/^SIRK-Portal ([A-Za-z0-9_-]+)$/);
        if (!match) return null;
        try {
            const decoded = Buffer.from(match[1], "base64url").toString("utf8");
            const index = decoded.indexOf(":");
            return index < 1 ? null : { id: decoded.slice(0, index), token: decoded.slice(index + 1) };
        } catch (_) { return null; }
    }

    const readIdentity = async req => {
        const value = currentSession(req, false);
        return value ? Object.assign({ ok: true }, value) : null;
    };
    const readPortals = async () => broker.list(portalStore.list());
    const organizationApi = organizationApiFactory.create({ store: organizations, readIdentity, securityCenter });
    const assignmentApi = portalAssignmentApiFactory.create({ store: portalAssignments, organizations, readIdentity, readPortals });

    async function handler(req, res) {
        try {
            const url = new URL(req.url, "http://central.local");
            if (req.method === "GET" && url.pathname === "/healthz") return json(res, 200, { ok: true, version: VERSION });

            if (await organizationApi(req, res, url)) return;
            if (await assignmentApi(req, res, url)) return;

            if (req.method === "GET" && url.pathname === "/auth/sso/callback") {
                if (!config.authOrigin) return json(res, 404, { ok: false, error: "Not found." });
                for (const [jti, expiresAt] of usedSsoTickets) if (expiresAt < Date.now()) usedSsoTickets.delete(jti);
                const ticket = verifySsoTicket(url.searchParams.get("ticket"), config.ssoSharedSecret, { issuer: config.authOrigin, audience: config.publicOrigin });
                if (usedSsoTickets.has(ticket.jti)) throw Object.assign(new Error("SSO ticket was already used."), { statusCode: 401 });
                usedSsoTickets.set(ticket.jti, ticket.exp * 1000);
                const identityKey = ticket.tid + ":" + ticket.oid;
                const state = userStore.resolveEntra(identityKey, { username: ticket.username, displayName: ticket.name }, ticket.roles);
                const identity = { username: ticket.username || ticket.name, displayName: ticket.name, identityKey, tenantId: ticket.tid, objectId: ticket.oid, source: "entra", role: state.role, status: state.status, requestedRole: state.requestedRole, claimedRoles: state.claimedRoles, roleSource: state.roleSource, builtIn: false };
                const token = issueSession(identity, req);
                securityCenter.audit("authentication.entra.success", identity, { ip: requestIp(req), claimedRoles: state.claimedRoles, status: state.status });
                return redirect(res, "/", { "Set-Cookie": sessionCookie(token) });
            }

            if (req.method === "GET" && url.pathname === "/api/access") {
                if (!verifyAccessKey(bearerCredential(req), effectiveSecurity().accessKeyHash)) return json(res, 404, { ok: false, error: "Not found." });
                return json(res, 200, { ok: true });
            }

            if (req.method === "POST" && url.pathname === "/api/login") {
                if (!verifyAccessKey(bearerCredential(req), effectiveSecurity().accessKeyHash)) return json(res, 404, { ok: false, error: "Not found." });
                if (!sameOrigin(req)) return json(res, 403, { ok: false, error: "Origin rejected." });
                const address = requestIp(req);
                const failure = loginFailures.get(address);
                if (failure && failure.blockedUntil > Date.now()) return json(res, 429, { ok: false, error: "Too many login attempts. Try again later." });
                const body = await readBody(req, 16384);
                let identity = null;
                if (String(body.username || "") === config.adminUsername && verifySecret(String(body.password || ""), effectiveSecurity().passwordHash)) {
                    identity = { username: config.adminUsername, displayName: config.adminUsername, identityKey: "breakglass:" + config.adminUsername, source: "local", role: "BreakGlass", builtIn: true, status: "active" };
                } else identity = userStore.authenticateLocal(body.username, body.password);
                if (!identity) {
                    const attempts = failure && failure.expiresAt > Date.now() ? failure.attempts + 1 : 1;
                    loginFailures.set(address, { attempts, expiresAt: Date.now() + 900000, blockedUntil: attempts >= 5 ? Date.now() + 900000 : 0 });
                    securityCenter.audit("authentication.local.failure", null, { username: String(body.username || ""), ip: address });
                    return json(res, 401, { ok: false, error: "Invalid username or password." });
                }
                loginFailures.delete(address);
                const token = issueSession(identity, req);
                securityCenter.audit("authentication.local.success", identity, { ip: address });
                if (identity.builtIn) securityCenter.recordBreakGlassUse(address, identity);
                return json(res, 200, Object.assign({ ok: true }, identity, { permissions: permissionsFor(identity.role, identity.builtIn) }), { "Set-Cookie": sessionCookie(token) });
            }

            if (req.method === "POST" && url.pathname === "/api/logout") {
                const token = currentSessionToken(req);
                const value = token ? sessions.get(token, false) : null;
                if (value) securityCenter.audit("authentication.logout", value, {});
                if (token) sessions.revokeToken(token);
                return json(res, 200, { ok: true, logoutUrl: value && value.source === "entra" && config.authOrigin ? config.authOrigin + "/logout" : "" }, { "Set-Cookie": clearSessionCookie() });
            }

            if (req.method === "GET" && url.pathname === "/api/session") {
                const value = currentSession(req);
                return json(res, value ? 200 : 401, value ? {
                    ok: true, username: value.username, displayName: value.displayName, source: value.source, identityKey: value.identityKey,
                    role: value.role, status: value.status, requestedRole: value.requestedRole, claimedRoles: value.claimedRoles || [],
                    roleSource: value.roleSource, builtIn: Boolean(value.builtIn), permissions: value.permissions
                } : { ok: false, error: "Authentication required." });
            }

            if (req.method === "GET" && url.pathname === "/api/settings/roles") {
                if (!requireSession(req, res)) return;
                return json(res, 200, { ok: true, roles: ASSIGNABLE_ROLES, permissions: ROLE_PERMISSIONS });
            }
            if (req.method === "GET" && url.pathname === "/api/settings/users") {
                const actor = requirePermission(req, res, "users.manage");
                if (!actor) return;
                return json(res, 200, { ok: true, users: userStore.listUsers(actor) });
            }
            if (req.method === "POST" && url.pathname === "/api/settings/users") {
                const actor = requirePermission(req, res, "users.manage");
                if (!actor) return;
                const user = userStore.createLocalUser(await readBody(req, 32768), actor);
                securityCenter.audit("user.local.created", actor, { username: user.username, role: user.role });
                return json(res, 201, { ok: true, user });
            }
            const roleMatch = url.pathname.match(/^\/api\/settings\/users\/(local|entra)\/(.+)\/role$/);
            if (roleMatch && req.method === "PATCH") {
                const actor = requirePermission(req, res, "users.manage");
                if (!actor) return;
                const key = decodeURIComponent(roleMatch[2]);
                const body = await readBody(req, 16384);
                const result = userStore.updateRole({ source: roleMatch[1], key }, body.role, actor);
                invalidateIdentitySessions(key);
                securityCenter.audit("role.changed", actor, { source: roleMatch[1], key, role: body.role });
                return json(res, 200, { ok: true, result });
            }

            if (req.method === "GET" && url.pathname === "/api/security/overview") {
                const actor = requirePermission(req, res, "security.manage");
                if (!actor) return;
                const users = userStore.listUsers(actor);
                return json(res, 200, { ok: true, pendingRoles: users.filter(item => item.source === "entra" && item.requestedRole), sessions: publicSessions(), policies: securityCenter.policies(), breakGlass: securityCenter.breakGlassStatus(), incidents: securityCenter.incidents(), audit: securityCenter.listAudit(50) });
            }
            if (req.method === "GET" && url.pathname === "/api/security/sessions") {
                if (!requirePermission(req, res, "security.sessions")) return;
                return json(res, 200, { ok: true, sessions: publicSessions() });
            }
            const sessionMatch = url.pathname.match(/^\/api\/security\/sessions\/([A-Za-z0-9_-]+)$/);
            if (sessionMatch && req.method === "DELETE") {
                const actor = requirePermission(req, res, "security.sessions");
                if (!actor) return;
                const own = currentSession(req, false);
                if (own && own.id === sessionMatch[1]) return json(res, 409, { ok: false, error: "Use Sign out to close your current session." });
                const target = publicSessions().find(item => item.id === sessionMatch[1]);
                if (!target || !sessions.revokeById(sessionMatch[1])) return json(res, 404, { ok: false, error: "Session not found." });
                securityCenter.audit("session.revoked", actor, { username: target.username, identityKey: target.identityKey, sessionId: target.id });
                return json(res, 200, { ok: true });
            }
            if (req.method === "POST" && url.pathname === "/api/security/sessions/revoke-all") {
                const actor = requirePermission(req, res, "security.sessions");
                if (!actor) return;
                const count = sessions.revokeWhere(() => true, currentSessionToken(req));
                securityCenter.audit("sessions.revoked_all", actor, { count });
                return json(res, 200, { ok: true, count });
            }

            if (req.method === "POST" && url.pathname === "/api/break-glass/password") {
                const actor = requireSession(req, res);
                if (!actor) return;
                if (!(actor.builtIn === true && actor.source === "local")) return json(res, 403, { ok: false, error: "Break-Glass account required." });
                const body = await readBody(req, 16384);
                if (!verifySecret(String(body.currentPassword || ""), effectiveSecurity().passwordHash)) return json(res, 401, { ok: false, error: "Current password is invalid." });
                userStore.setBreakGlassPassword(body.newPassword);
                const revoked = invalidateBreakGlassSessions();
                securityCenter.audit("breakglass.password.changed", actor, { revokedSessions: revoked });
                return json(res, 200, { ok: true, reauthenticationRequired: true, revokedSessions: revoked }, { "Set-Cookie": clearSessionCookie() });
            }
            if (req.method === "POST" && url.pathname === "/api/break-glass/access") {
                const actor = requireSession(req, res);
                if (!actor) return;
                if (!(actor.builtIn === true && actor.source === "local")) return json(res, 403, { ok: false, error: "Break-Glass account required." });
                const key = randomToken(32);
                userStore.setAccessKeyHash(hashAccessKey(key));
                const revoked = invalidateBreakGlassSessions();
                securityCenter.recordBreakGlassRotation(actor);
                securityCenter.audit("breakglass.access.rotated", actor, { revokedSessions: revoked });
                return json(res, 200, { ok: true, accessUrl: config.publicOrigin + "/#access=" + key, reauthenticationRequired: true, revokedSessions: revoked }, { "Set-Cookie": clearSessionCookie() });
            }

            if (url.pathname === "/api/portals" && req.method === "GET") {
                const actor = requirePermission(req, res, "portals.read");
                if (!actor) return;
                const visible = broker.list(portalStore.list()).filter(portal => accessStore.effective(actor, portal.id).allowed).map(portal => Object.assign({}, portal, { access: accessStore.effective(actor, portal.id), assignment: portalAssignments.get(portal.id) }));
                return json(res, 200, { ok: true, portals: visible });
            }
            if (url.pathname === "/api/portals" && req.method === "POST") {
                const actor = requirePermission(req, res, "portals.manage");
                if (!actor) return;
                const portal = portalStore.createPortal(await readBody(req, 16384));
                securityCenter.audit("portal.created", actor, { portalId: portal.id });
                return json(res, 201, { ok: true, portal });
            }

            const staticFiles = new Set(["/", "/app.js", "/i18n.js", "/styles.css", "/permissions-layout.js", "/permissions-layout.css"]);
            if ((req.method === "GET" || req.method === "HEAD") && staticFiles.has(url.pathname)) {
                const fileName = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
                const contentType = fileName.endsWith(".html") ? "text/html; charset=utf-8" : fileName.endsWith(".js") ? "text/javascript; charset=utf-8" : "text/css; charset=utf-8";
                const data = fs.readFileSync(path.join(webRoot, fileName));
                res.writeHead(200, {
                    "Content-Type": contentType,
                    "Content-Length": String(data.length),
                    "Cache-Control": "no-store",
                    "X-Content-Type-Options": "nosniff",
                    "Content-Security-Policy": "default-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
                });
                res.end(req.method === "HEAD" ? undefined : data);
                return;
            }
            return json(res, 404, { ok: false, error: "Not found." });
        } catch (error) {
            return json(res, error.statusCode || 400, { ok: false, error: error.message || "Internal server error." });
        }
    }

    const router = routerFactory.create(handler);
    const server = http.createServer((req, res) => {
        router.dispatch(req, res).catch(error => {
            if (!res.headersSent) return json(res, 500, { ok: false, code: "INTERNAL_ERROR", error: "Internal server error." });
            res.destroy(error);
        });
    });

    let upgradeHandler = (req, socket, head) => {
        const url = new URL(req.url, "http://central.local");
        if (url.pathname !== "/tunnel") return socket.destroy();
        const credentials = portalCredentials(req);
        const portal = credentials && portalStore.authenticate(credentials.id, credentials.token);
        if (!portal) {
            socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
            return socket.destroy();
        }
        wsServer.handleUpgrade(req, socket, head, webSocket => broker.attach(portal, webSocket));
    };
    server.on("upgrade", (req, socket, head) => upgradeHandler(req, socket, head));

    const app = {
        server, router, store: portalStore, portalStore, userStore, providerStore, accessStore, securityCenter,
        sessions, organizations, approvals, portalAssignments, broker,
        wrapUpgrade(wrapper) {
            if (typeof wrapper !== "function") throw new TypeError("Upgrade wrapper must be a function.");
            const previous = upgradeHandler;
            upgradeHandler = (req, socket, head) => wrapper(req, socket, head, previous);
        }
    };
    return app;
}

module.exports = { loadConfig, createApplication };
