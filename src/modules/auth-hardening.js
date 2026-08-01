"use strict";

const { parseCookies, json, readBody, securityHeaders, csrfAccepted, requestIp } = require("../http/transport");
const { VERSION } = require("../version");

const crypto = require("node:crypto");
const recoveryCodeStoreFactory = require("../recovery-code-store");
const challengeStoreFactory = require("../webauthn-challenge-store");
const loginTransactionStoreFactory = require("../login-transaction-store");
const continuityPolicy = require("../mfa-continuity-policy");
const { permissionsFor } = require("../rbac");

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const CSRF_COOKIE = "sirk_central_csrf";
const CSRF_HEADER = "x-sirk-csrf";

function validToken(value) {
    return /^[A-Za-z0-9_-]{32,128}$/.test(String(value || ""));
}

function csrfCookie(token) {
    return CSRF_COOKIE + "=" + token + "; Path=/; Secure; SameSite=Strict; Max-Age=28800";
}

function sessionCookie(token, hours) {
    return "sirk_central_session=" + token + "; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=" + (hours * 3600);
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

function csrfRequired(req, url, cookies = parseCookies(req)) {
    if (SAFE_METHODS.has(req.method)) return false;
    if (!url.pathname.startsWith("/api/")) return false;
    if (url.pathname.startsWith("/api/portal/v1/")) return false;
    if (url.pathname === "/api/login") return false;
    if (url.pathname === "/api/login/mfa/recovery") return true;
    return Boolean(cookies.sirk_central_session);
}

function breakGlassActor(app, req) {
    const token = parseCookies(req).sirk_central_session || "";
    const actor = token && app.sessions ? app.sessions.get(token, true) : null;
    if (!actor || actor.builtIn !== true || actor.source !== "local" || actor.role !== "BreakGlass") return null;
    return actor;
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

function registerAuthHardening(app, config) {
    const recoveryCodes = recoveryCodeStoreFactory.create({ dataDir: config.dataDir });
    const webauthnChallenges = challengeStoreFactory.create({ dataDir: config.dataDir });
    const loginTransactions = loginTransactionStoreFactory.create({ dataDir: config.dataDir });

    const handler = async (req, res) => {
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
                return json(res, ready ? 200 : 503, { ok: ready, version: VERSION, checks });
            }

            if (csrfRequired(req, url, cookies) && !csrfAccepted(req, config, cookies)) {
                return json(res, 403, { ok: false, error: "CSRF validation failed." });
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
                    continuityPolicy.assertCanRevokeRecoveryCodes(app.passkeys, recoveryCodes, actor);
                    const removed = recoveryCodes.revoke(actor);
                    app.securityCenter.audit("breakglass.recovery_codes.revoked", actor, { removed });
                    return json(res, 200, { ok: true, removed });
                }
                return json(res, 404, { ok: false, error: "Not found." });
            }

            return false;
        } catch (error) {
            const status = Number.isInteger(error.statusCode) ? error.statusCode : 400;
            if (!res.headersSent) return json(res, status, { ok: false, code: error.code || "REQUEST_REJECTED", error: error.message || "Request failed." });
            res.destroy(error);
        }
    };
    app.router.before(handler);
    Object.assign(app, { recoveryCodes, webauthnChallenges, loginTransactions });
    return app;
}

module.exports = { registerAuthHardening, parseCookies, validToken, csrfRequired, csrfAccepted, securityHeaders, breakGlassActor, CSRF_COOKIE, CSRF_HEADER };
