"use strict";

const crypto = require("node:crypto");
const http = require("node:http");
const recoveryCodeStoreFactory = require("./recovery-code-store");
const challengeStoreFactory = require("./webauthn-challenge-store");
const loginTransactionStoreFactory = require("./login-transaction-store");
const { verifySecret, verifyAccessKey } = require("./security");
const { permissionsFor } = require("./rbac");
const { loadConfig, createApp } = require("./server-v1");

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const CSRF_COOKIE = "sirk_central_csrf";
const CSRF_HEADER = "x-sirk-csrf";

function parseCookies(req) {
    const result = {};
    for (const part of String(req.headers.cookie || "").split(";")) {
        const index = part.indexOf("=");
        if (index > 0) result[part.slice(0, index).trim()] = part.slice(index + 1).trim();
    }
    return result;
}

function validToken(value) {
    return /^[A-Za-z0-9_-]{32,128}$/.test(String(value || ""));
}

function csrfCookie(token) {
    return CSRF_COOKIE + "=" + token + "; Path=/; Secure; SameSite=Strict; Max-Age=28800";
}

function sessionCookie(token, hours) {
    return "sirk_central_session=" + token + "; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=" + (hours * 3600);
}

function json(res, status, body, extraHeaders = {}) {
    const data = Buffer.from(JSON.stringify(body));
    res.writeHead(status, Object.assign({
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": String(data.length),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff"
    }, extraHeaders));
    res.end(data);
}

function readBody(req, limit = 16384) {
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

function securityHeaders() {
    return {
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
        "Referrer-Policy": "no-referrer",
        "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Resource-Policy": "same-origin",
        "Strict-Transport-Security": "max-age=31536000; includeSubDomains"
    };
}

function csrfBootstrapSource() {
    return `"use strict";\n(function(){\n  function cookie(name){for(const part of document.cookie.split(";")){const p=part.trim();if(p.startsWith(name+"="))return p.slice(name.length+1);}return "";}\n  const original=window.fetch.bind(window);\n  window.fetch=function(input,init){\n    init=Object.assign({},init||{});\n    const method=String(init.method||((input&&input.method)||"GET")).toUpperCase();\n    let same=true;try{const u=new URL(typeof input==="string"?input:input.url,location.href);same=u.origin===location.origin;}catch(_){same=true;}\n    if(same&&!(["GET","HEAD","OPTIONS"].includes(method))){\n      const token=cookie("${CSRF_COOKIE}");\n      const headers=new Headers(init.headers||((input&&input.headers)||undefined));\n      if(token)headers.set("X-SIRK-CSRF",token);\n      init.headers=headers;\n    }\n    init.credentials=init.credentials||"same-origin";\n    return original(input,init);\n  };\n}());\n`;
}

function appendSetCookie(existing, value) {
    if (!existing) return value;
    if (Array.isArray(existing)) return existing.concat(value);
    return [existing, value];
}

function decorateResponse(res, token) {
    const originalWriteHead = res.writeHead.bind(res);
    res.writeHead = function patchedWriteHead(statusCode, reasonOrHeaders, maybeHeaders) {
        let headers;
        if (reasonOrHeaders && typeof reasonOrHeaders === "object") headers = reasonOrHeaders;
        else if (maybeHeaders && typeof maybeHeaders === "object") headers = maybeHeaders;
        else headers = {};
        const merged = Object.assign({}, securityHeaders(), headers);
        const existingCookie = merged["Set-Cookie"] || merged["set-cookie"] || res.getHeader("Set-Cookie");
        delete merged["set-cookie"];
        merged["Set-Cookie"] = appendSetCookie(existingCookie, csrfCookie(token));
        if (reasonOrHeaders && typeof reasonOrHeaders === "string") return originalWriteHead(statusCode, reasonOrHeaders, merged);
        return originalWriteHead(statusCode, merged);
    };
}

function csrfRequired(req, url) {
    if (SAFE_METHODS.has(req.method)) return false;
    if (!url.pathname.startsWith("/api/")) return false;
    return url.pathname !== "/api/login" && url.pathname !== "/api/login/mfa/recovery";
}

function csrfAccepted(req, config, cookies) {
    const cookie = String(cookies[CSRF_COOKIE] || "");
    const supplied = String(req.headers[CSRF_HEADER] || "");
    if (!validToken(cookie) || supplied !== cookie) return false;
    const origin = String(req.headers.origin || "");
    if (origin && origin !== config.publicOrigin) return false;
    const site = String(req.headers["sec-fetch-site"] || "");
    return !site || site === "same-origin" || site === "none";
}

function breakGlassActor(app, req) {
    const token = parseCookies(req).sirk_central_session || "";
    const actor = token && app.sessions ? app.sessions.get(token, true) : null;
    if (!actor || actor.builtIn !== true || actor.source !== "local" || actor.role !== "BreakGlass") return null;
    return actor;
}

function requestIp(req, config) {
    if (config.trustProxy) {
        const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
        if (forwarded) return forwarded.slice(0, 128);
    }
    return String(req.socket.remoteAddress || "unknown").slice(0, 128);
}

function bearerCredential(req) {
    const match = String(req.headers.authorization || "").match(/^Bearer ([A-Za-z0-9_-]+)$/);
    return match ? match[1] : "";
}

function effectiveSecurity(app, config) {
    const overrides = app.userStore.securityOverrides();
    return {
        passwordHash: overrides.breakGlassPasswordHash || config.adminPasswordHash,
        accessKeyHash: overrides.accessKeyHash || config.accessKeyHash
    };
}

function issueFullSession(app, config, identity, req) {
    const issued = app.sessions.issue(Object.assign({}, identity, {
        permissions: permissionsFor(identity.role, identity.builtIn)
    }), {
        ip: requestIp(req, config),
        userAgent: String(req.headers["user-agent"] || "")
    });
    return issued.token;
}

function createHardenedApp(config) {
    const app = createApp(config);
    const innerHandler = app.server.listeners("request")[0];
    if (typeof innerHandler !== "function") throw new Error("SIRK Central v1 request handler is unavailable.");
    const recoveryCodes = recoveryCodeStoreFactory.create({ dataDir: config.dataDir });
    const webauthnChallenges = challengeStoreFactory.create({ dataDir: config.dataDir });
    const loginTransactions = loginTransactionStoreFactory.create({ dataDir: config.dataDir });
    const loginFailures = new Map();

    const server = http.createServer(async (req, res) => {
        try {
            const url = new URL(req.url, "http://central.local");
            const cookies = parseCookies(req);
            const token = validToken(cookies[CSRF_COOKIE]) ? cookies[CSRF_COOKIE] : crypto.randomBytes(32).toString("base64url");
            decorateResponse(res, token);

            if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/csrf-bootstrap.js") {
                const data = Buffer.from(csrfBootstrapSource());
                res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Content-Length": String(data.length), "Cache-Control": "no-store" });
                return res.end(req.method === "HEAD" ? undefined : data);
            }

            if (req.method === "GET" && url.pathname === "/readyz") {
                const checks = {
                    sessionStore: Boolean(app.sessions && app.sessions.filePath),
                    organizations: Boolean(app.organizations && app.organizations.filePath),
                    approvals: Boolean(app.approvals && app.approvals.filePath),
                    portalAssignments: Boolean(app.portalAssignments && app.portalAssignments.filePath),
                    recoveryCodes: Boolean(recoveryCodes.filePath),
                    webauthnChallenges: Boolean(webauthnChallenges.filePath),
                    loginTransactions: Boolean(loginTransactions.filePath)
                };
                const ready = Object.values(checks).every(Boolean);
                return json(res, ready ? 200 : 503, { ok: ready, version: "1.0.0-rc.4", checks });
            }

            if (csrfRequired(req, url) && !csrfAccepted(req, config, cookies)) {
                return json(res, 403, { ok: false, error: "CSRF validation failed." });
            }

            if (req.method === "POST" && url.pathname === "/api/login") {
                if (!verifyAccessKey(bearerCredential(req), effectiveSecurity(app, config).accessKeyHash)) return json(res, 404, { ok: false, error: "Not found." });
                const origin = String(req.headers.origin || "");
                if (origin && origin !== config.publicOrigin) return json(res, 403, { ok: false, error: "Origin rejected." });
                const address = requestIp(req, config);
                const failure = loginFailures.get(address);
                if (failure && failure.blockedUntil > Date.now()) return json(res, 429, { ok: false, error: "Too many login attempts. Try again later." });
                const body = await readBody(req);
                let identity = null;
                if (String(body.username || "") === config.adminUsername && verifySecret(String(body.password || ""), effectiveSecurity(app, config).passwordHash)) {
                    identity = { username: config.adminUsername, displayName: config.adminUsername, identityKey: "breakglass:" + config.adminUsername, source: "local", role: "BreakGlass", builtIn: true, status: "active" };
                } else {
                    identity = app.userStore.authenticateLocal(body.username, body.password);
                }
                if (!identity) {
                    const attempts = failure && failure.expiresAt > Date.now() ? failure.attempts + 1 : 1;
                    loginFailures.set(address, { attempts, expiresAt: Date.now() + 900000, blockedUntil: attempts >= 5 ? Date.now() + 900000 : 0 });
                    app.securityCenter.audit("authentication.local.failure", null, { username: String(body.username || ""), ip: address });
                    return json(res, 401, { ok: false, error: "Invalid username or password." });
                }
                loginFailures.delete(address);
                if (identity.builtIn === true && recoveryCodes.status(identity).configured) {
                    const transaction = loginTransactions.issue(identity, { ip: address, userAgent: String(req.headers["user-agent"] || "") });
                    app.securityCenter.audit("authentication.breakglass.mfa_required", identity, { ip: address });
                    return json(res, 202, { ok: true, mfaRequired: true, methods: ["recovery-code"], transactionToken: transaction.token, expiresAtUtc: transaction.expiresAtUtc });
                }
                const sessionToken = issueFullSession(app, config, identity, req);
                app.securityCenter.audit("authentication.local.success", identity, { ip: address, mfa: false });
                if (identity.builtIn) app.securityCenter.recordBreakGlassUse(address, identity);
                return json(res, 200, { ok: true, mfaRequired: false }, { "Set-Cookie": sessionCookie(sessionToken, config.sessionAbsoluteHours) });
            }

            if (req.method === "POST" && url.pathname === "/api/login/mfa/recovery") {
                const origin = String(req.headers.origin || "");
                if (origin && origin !== config.publicOrigin) return json(res, 403, { ok: false, error: "Origin rejected." });
                const body = await readBody(req);
                const context = { ip: requestIp(req, config), userAgent: String(req.headers["user-agent"] || "") };
                const identity = loginTransactions.consume(body.transactionToken, context);
                if (!identity || identity.builtIn !== true) {
                    app.securityCenter.audit("authentication.breakglass.mfa_transaction_rejected", null, { ip: context.ip });
                    return json(res, 401, { ok: false, error: "MFA transaction is invalid or expired." });
                }
                try {
                    const result = recoveryCodes.verify(identity, body.recoveryCode);
                    const sessionToken = issueFullSession(app, config, identity, req);
                    app.securityCenter.audit("authentication.breakglass.mfa_success", identity, { ip: context.ip, method: "recovery-code", remaining: result.remaining });
                    app.securityCenter.recordBreakGlassUse(context.ip, identity);
                    return json(res, 200, { ok: true, mfaRequired: false, recoveryCodesRemaining: result.remaining }, { "Set-Cookie": sessionCookie(sessionToken, config.sessionAbsoluteHours) });
                } catch (error) {
                    app.securityCenter.audit("authentication.breakglass.mfa_failure", identity, { ip: context.ip, method: "recovery-code" });
                    return json(res, 401, { ok: false, error: error.message || "Recovery code verification failed." });
                }
            }

            if (url.pathname.startsWith("/api/break-glass/mfa")) {
                const actor = breakGlassActor(app, req);
                if (!actor) return json(res, 403, { ok: false, error: "Break-Glass session required." });
                if (req.method === "GET" && url.pathname === "/api/break-glass/mfa/status") {
                    return json(res, 200, { ok: true, recoveryCodes: recoveryCodes.status(actor), passkeys: { configured: false, active: 0, enforcement: "not-enabled" } });
                }
                if (req.method === "POST" && url.pathname === "/api/break-glass/mfa/recovery-codes/rotate") {
                    const body = await readBody(req);
                    const count = Math.max(5, Math.min(20, Number(body.count || 10)));
                    const codes = recoveryCodes.generate(actor, count);
                    const currentToken = cookies.sirk_central_session || "";
                    const revokedSessions = app.sessions.revokeWhere(record => record.builtIn === true && record.source === "local", currentToken);
                    app.securityCenter.audit("breakglass.recovery_codes.rotated", actor, { count: codes.length, revokedSessions });
                    return json(res, 200, { ok: true, codes, shownOnce: true, revokedSessions });
                }
                if (req.method === "DELETE" && url.pathname === "/api/break-glass/mfa/recovery-codes") {
                    const removed = recoveryCodes.revoke(actor);
                    app.securityCenter.audit("breakglass.recovery_codes.revoked", actor, { removed });
                    return json(res, 200, { ok: true, removed });
                }
                return json(res, 404, { ok: false, error: "Not found." });
            }

            return innerHandler(req, res);
        } catch (error) {
            if (!res.headersSent) return json(res, error.statusCode || 400, { ok: false, error: error.message || "Request failed." });
            res.destroy(error);
        }
    });

    server.on("upgrade", (req, socket, head) => app.server.emit("upgrade", req, socket, head));
    return Object.assign({}, app, { server, recoveryCodes, webauthnChallenges, loginTransactions });
}

if (require.main === module) {
    const config = loadConfig(process.env);
    const app = createHardenedApp(config);
    app.server.listen(config.port, config.bindHost, () => process.stdout.write("SIRK Central v2 listening on " + config.bindHost + ":" + config.port + "\n"));
}

module.exports = { createHardenedApp, parseCookies, validToken, csrfRequired, csrfAccepted, securityHeaders, breakGlassActor };
