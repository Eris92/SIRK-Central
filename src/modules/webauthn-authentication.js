"use strict";

const { parseCookies, json, readBody, requestIp, csrfAccepted } = require("../http/transport");

const crypto = require("node:crypto");
const passkeyStoreFactory = require("../passkey-store");
const webauthn = require("../webauthn-es256");
const continuityPolicy = require("../mfa-continuity-policy");
const { verifySecret, verifyAccessKey } = require("../security");
const { permissionsFor } = require("../rbac");
const { digest } = require("../login-transaction-store");

const { VERSION } = require("../version");

function requestContext(req, config) {
    return { ip: requestIp(req, config), userAgent: String(req.headers["user-agent"] || "").slice(0, 1024) };
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

function sessionCookie(token, hours) {
    return "sirk_central_session=" + token + "; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=" + (hours * 3600);
}

function issueSession(app, config, identity, req) {
    const issued = app.sessions.issue(Object.assign({}, identity, {
        permissions: permissionsFor(identity.role, identity.builtIn)
    }), requestContext(req, config));
    return issued.token;
}

function breakGlassActor(app, req) {
    const token = parseCookies(req).sirk_central_session || "";
    const actor = token && app.sessions ? app.sessions.get(token, true) : null;
    if (!actor || actor.builtIn !== true || actor.source !== "local" || actor.role !== "BreakGlass") return null;
    return actor;
}

function parseClientChallenge(encoded) {
    const raw = Buffer.from(String(encoded || ""), "base64url");
    if (raw.length < 8 || raw.length > 16384) throw new Error("clientDataJSON is invalid.");
    const parsed = JSON.parse(raw.toString("utf8"));
    if (!parsed || typeof parsed.challenge !== "string") throw new Error("WebAuthn challenge is missing.");
    return parsed.challenge;
}

function rpConfiguration(config) {
    const origin = new URL(config.publicOrigin);
    if (origin.protocol !== "https:") throw new Error("WebAuthn requires an HTTPS public origin.");
    return { origin: origin.origin, rpId: origin.hostname };
}

function registerWebAuthnAuthentication(app, config) {
    const passkeys = passkeyStoreFactory.create({ dataDir: config.dataDir });
    const failures = new Map();
    const rp = rpConfiguration(config);

    const handler = async (req, res) => {
        try {
            const url = new URL(req.url, "http://central.local");
            const context = requestContext(req, config);

            if (req.method === "GET" && url.pathname === "/readyz") {
                return json(res, 200, { ok: true, version: VERSION, checks: { passkeyStore: Boolean(passkeys.filePath), webauthnChallenges: Boolean(app.webauthnChallenges && app.webauthnChallenges.filePath), loginTransactions: Boolean(app.loginTransactions && app.loginTransactions.filePath) } });
            }

            if (req.method === "POST" && url.pathname === "/api/login") {
                if (!verifyAccessKey(bearerCredential(req), effectiveSecurity(app, config).accessKeyHash)) return json(res, 404, { ok: false, error: "Not found." });
                const origin = String(req.headers.origin || "");
                if (origin && origin !== config.publicOrigin) return json(res, 403, { ok: false, error: "Origin rejected." });
                const failure = failures.get(context.ip);
                if (failure && failure.blockedUntil > Date.now()) return json(res, 429, { ok: false, error: "Too many login attempts. Try again later." });
                const body = await readBody(req);
                let identity = null;
                if (String(body.username || "") === config.adminUsername && verifySecret(String(body.password || ""), effectiveSecurity(app, config).passwordHash)) {
                    identity = { username: config.adminUsername, displayName: config.adminUsername, identityKey: "breakglass:" + config.adminUsername, source: "local", role: "BreakGlass", builtIn: true, status: "active" };
                } else identity = app.userStore.authenticateLocal(body.username, body.password);
                if (!identity) {
                    const attempts = failure && failure.expiresAt > Date.now() ? failure.attempts + 1 : 1;
                    failures.set(context.ip, { attempts, expiresAt: Date.now() + 900000, blockedUntil: attempts >= 5 ? Date.now() + 900000 : 0 });
                    app.securityCenter.audit("authentication.local.failure", null, { username: String(body.username || ""), ip: context.ip });
                    return json(res, 401, { ok: false, error: "Invalid username or password." });
                }
                failures.delete(context.ip);
                const methods = [];
                if (identity.builtIn === true && passkeys.activeCount(identity) > 0) methods.push("passkey");
                if (identity.builtIn === true && app.recoveryCodes.status(identity).configured) methods.push("recovery-code");
                if (methods.length) {
                    const transaction = app.loginTransactions.issue(identity, context);
                    app.securityCenter.audit("authentication.breakglass.mfa_required", identity, { ip: context.ip, methods });
                    return json(res, 202, { ok: true, mfaRequired: true, methods, preferredMethod: methods.includes("passkey") ? "passkey" : methods[0], transactionToken: transaction.token, expiresAtUtc: transaction.expiresAtUtc });
                }
                const token = issueSession(app, config, identity, req);
                app.securityCenter.audit("authentication.local.success", identity, { ip: context.ip, mfa: false });
                if (identity.builtIn) app.securityCenter.recordBreakGlassUse(context.ip, identity);
                return json(res, 200, { ok: true, mfaRequired: false }, { "Set-Cookie": sessionCookie(token, config.sessionAbsoluteHours) });
            }

            if (url.pathname.startsWith("/api/break-glass/passkeys")) {
                if (!csrfAccepted(req, config)) return json(res, 403, { ok: false, error: "CSRF validation failed." });
                const actor = breakGlassActor(app, req);
                if (!actor) return json(res, 403, { ok: false, error: "Break-Glass session required." });

                if (req.method === "GET" && url.pathname === "/api/break-glass/passkeys") {
                    return json(res, 200, { ok: true, passkeys: passkeys.list(actor), rpId: rp.rpId });
                }
                if (req.method === "POST" && url.pathname === "/api/break-glass/passkeys/begin-registration") {
                    const challenge = app.webauthnChallenges.issue("registration", actor, { rpId: rp.rpId, origin: rp.origin });
                    const userId = crypto.createHash("sha256").update(actor.identityKey, "utf8").digest("base64url");
                    return json(res, 200, { ok: true, challengeId: challenge.id, publicKey: { challenge: challenge.challenge, rp: { id: rp.rpId, name: "SIRK Central" }, user: { id: userId, name: actor.username, displayName: actor.displayName || actor.username }, pubKeyCredParams: [{ type: "public-key", alg: -7 }], timeout: 120000, authenticatorSelection: { authenticatorAttachment: "cross-platform", residentKey: "discouraged", userVerification: "required" }, attestation: "none", excludeCredentials: passkeys.list(actor).filter(item => item.status === "active").map(item => ({ type: "public-key", id: item.credentialId, transports: item.transports })) } });
                }
                if (req.method === "POST" && url.pathname === "/api/break-glass/passkeys/finish-registration") {
                    const body = await readBody(req);
                    const challengeValue = parseClientChallenge(body.credential && body.credential.clientDataJSON);
                    const challengeContext = app.webauthnChallenges.consume(body.challengeId, challengeValue, "registration", actor);
                    const verified = webauthn.registration(body.credential || {}, { challenge: challengeValue, origin: challengeContext.origin, rpId: challengeContext.rpId, requireUV: true });
                    const record = passkeys.register(Object.assign({}, verified, { displayName: body.displayName || "YubiKey", aaguid: body.credential && body.credential.aaguid }), actor);
                    app.securityCenter.audit("breakglass.passkey.registered", actor, { credentialId: record.credentialId, transports: record.transports });
                    return json(res, 200, { ok: true, passkey: passkeys.list(actor).find(item => item.credentialId === record.credentialId) });
                }
                const revokeMatch = url.pathname.match(/^\/api\/break-glass\/passkeys\/([A-Za-z0-9_-]{16,512})$/);
                if (req.method === "DELETE" && revokeMatch) {
                    continuityPolicy.assertCanRevokePasskey(passkeys, app.recoveryCodes, actor, revokeMatch[1]);
                    const record = passkeys.revoke(revokeMatch[1], actor);
                    app.securityCenter.audit("breakglass.passkey.revoked", actor, { credentialId: record.credentialId });
                    return json(res, 200, { ok: true });
                }
                return json(res, 404, { ok: false, error: "Not found." });
            }

            if (req.method === "POST" && url.pathname === "/api/login/mfa/passkey/begin") {
                if (!csrfAccepted(req, config)) return json(res, 403, { ok: false, error: "CSRF validation failed." });
                const body = await readBody(req);
                const identity = app.loginTransactions.inspect(body.transactionToken, context);
                if (!identity || identity.builtIn !== true) return json(res, 401, { ok: false, error: "MFA transaction is invalid or expired." });
                const active = passkeys.list(identity).filter(item => item.status === "active");
                if (!active.length) return json(res, 409, { ok: false, error: "No active passkey is registered." });
                const challenge = app.webauthnChallenges.issue("authentication", identity, { rpId: rp.rpId, origin: rp.origin, transactionHash: digest(body.transactionToken) });
                return json(res, 200, { ok: true, challengeId: challenge.id, publicKey: { challenge: challenge.challenge, rpId: rp.rpId, timeout: 120000, userVerification: "required", allowCredentials: active.map(item => ({ type: "public-key", id: item.credentialId, transports: item.transports })) } });
            }

            if (req.method === "POST" && url.pathname === "/api/login/mfa/passkey/finish") {
                if (!csrfAccepted(req, config)) return json(res, 403, { ok: false, error: "CSRF validation failed." });
                const body = await readBody(req);
                const identity = app.loginTransactions.inspect(body.transactionToken, context);
                if (!identity || identity.builtIn !== true) return json(res, 401, { ok: false, error: "MFA transaction is invalid or expired." });
                const challengeValue = parseClientChallenge(body.credential && body.credential.clientDataJSON);
                const challengeContext = app.webauthnChallenges.consume(body.challengeId, challengeValue, "authentication", identity);
                if (challengeContext.transactionHash !== digest(body.transactionToken)) return json(res, 401, { ok: false, error: "MFA transaction binding failed." });
                const credential = passkeys.getActive(body.credential && body.credential.credentialId, identity);
                const verified = webauthn.authentication(body.credential || {}, credential, { challenge: challengeValue, origin: challengeContext.origin, rpId: challengeContext.rpId, requireUV: true });
                const consumedIdentity = app.loginTransactions.consume(body.transactionToken, context);
                if (!consumedIdentity) return json(res, 401, { ok: false, error: "MFA transaction is invalid or expired." });
                passkeys.verifyUse(credential.credentialId, consumedIdentity, verified.counter, verified);
                const token = issueSession(app, config, consumedIdentity, req);
                app.securityCenter.audit("authentication.breakglass.mfa_success", consumedIdentity, { ip: context.ip, method: "passkey", credentialId: credential.credentialId });
                app.securityCenter.recordBreakGlassUse(context.ip, consumedIdentity);
                return json(res, 200, { ok: true, mfaRequired: false, method: "passkey" }, { "Set-Cookie": sessionCookie(token, config.sessionAbsoluteHours) });
            }

            return false;
        } catch (error) {
            const status = Number.isInteger(error.statusCode) ? error.statusCode : 400;
            if (!res.headersSent) return json(res, status, { ok: false, code: error.code || "REQUEST_REJECTED", error: error.message || "Request failed." });
            res.destroy(error);
        }
    };
    app.router.prepend(handler);
    Object.assign(app, { passkeys, version: VERSION });
    return app;
}

module.exports = { registerWebAuthnAuthentication, VERSION };
