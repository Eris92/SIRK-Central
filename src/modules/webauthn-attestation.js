"use strict";

const { parseCookies: cookies, json, readBody } = require("../http/transport");

const { verifyRegistration } = require("../webauthn-attestation");

const { VERSION } = require("../version");

function headers() {
    return { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer" };
}
function actor(app, req) {
    const token = cookies(req).sirk_central_session || "";
    const value = token && app.sessions ? app.sessions.get(token, true) : null;
    return value && value.builtIn === true && value.source === "local" && value.role === "BreakGlass" ? value : null;
}
function csrf(req, config) {
    const token = String(cookies(req).sirk_central_csrf || "");
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(token) || String(req.headers["x-sirk-csrf"] || "") !== token) return false;
    const origin = String(req.headers.origin || "");
    return !origin || origin === config.publicOrigin;
}
function challengeFrom(clientDataJSON) {
    const raw = Buffer.from(String(clientDataJSON || ""), "base64url");
    const parsed = JSON.parse(raw.toString("utf8"));
    if (!parsed || typeof parsed.challenge !== "string") throw new Error("WebAuthn challenge is missing.");
    return parsed.challenge;
}

function registerWebAuthnAttestation(app, config) {
    const rpOrigin = new URL(config.publicOrigin);
    if (rpOrigin.protocol !== "https:") throw new Error("WebAuthn requires HTTPS.");

    const handler = async (req, res) => {
        try {
            const url = new URL(req.url, "http://central.local");
            if (req.method === "POST" && url.pathname === "/api/break-glass/passkeys/finish-registration") {
                if (!csrf(req, config)) return json(res, 403, { ok: false, error: "CSRF validation failed." });
                const current = actor(app, req);
                if (!current) return json(res, 403, { ok: false, error: "Break-Glass session required." });
                const body = await readBody(req);
                const credential = body.credential || {};
                const challenge = challengeFrom(credential.clientDataJSON);
                const context = app.webauthnChallenges.consume(body.challengeId, challenge, "registration", current);
                const verified = verifyRegistration(credential, { challenge, origin: context.origin, rpId: context.rpId, requireUV: true });
                const record = app.passkeys.register(Object.assign({}, verified, { displayName: String(body.displayName || "YubiKey").slice(0, 120) }), current);
                app.securityCenter.audit("breakglass.passkey.registered", current, { credentialId: record.credentialId, aaguid: record.aaguid, transports: record.transports, attestationFormat: "none" });
                return json(res, 200, { ok: true, passkey: app.passkeys.list(current).find(item => item.credentialId === record.credentialId) });
            }
            if (req.method === "GET" && url.pathname === "/readyz") {
                const checks = { passkeyStore: Boolean(app.passkeys && app.passkeys.filePath), attestationParser: true, webauthnChallenges: Boolean(app.webauthnChallenges && app.webauthnChallenges.filePath), loginTransactions: Boolean(app.loginTransactions && app.loginTransactions.filePath) };
                const ok = Object.values(checks).every(Boolean);
                return json(res, ok ? 200 : 503, { ok, version: VERSION, checks });
            }
            return false;
        } catch (error) {
            if (!res.headersSent) return json(res, error.statusCode || 400, { ok: false, error: error.message || "Request failed." });
            res.destroy(error);
        }
    };
    app.router.prepend(handler);
    Object.assign(app, { version: VERSION });
    return app
}

module.exports = { registerWebAuthnAttestation, VERSION };
