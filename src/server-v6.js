"use strict";

const http = require("node:http");
const { verifyRegistration } = require("./webauthn-attestation");
const { createFinalApp } = require("./server-v5");
const { loadConfig } = require("./server-v1");

const VERSION = "1.0.0-rc.9";

function cookies(req) {
    const result = {};
    for (const part of String(req.headers.cookie || "").split(";")) {
        const index = part.indexOf("=");
        if (index > 0) result[part.slice(0, index).trim()] = part.slice(index + 1).trim();
    }
    return result;
}
function headers() {
    return { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer" };
}
function json(res, status, body) {
    const data = Buffer.from(JSON.stringify(body));
    res.writeHead(status, Object.assign(headers(), { "Content-Length": String(data.length) }));
    res.end(data);
}
function readBody(req, limit = 131072) {
    return new Promise((resolve, reject) => {
        const chunks = []; let size = 0;
        req.on("data", chunk => { size += chunk.length; if (size > limit) reject(Object.assign(new Error("Request body is too large."), { statusCode: 413 })); else chunks.push(chunk); });
        req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); } catch (_) { reject(Object.assign(new Error("Invalid JSON body."), { statusCode: 400 })); } });
        req.on("error", reject);
    });
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

function createAttestationApp(config) {
    const app = createFinalApp(config);
    const inner = app.server.listeners("request")[0];
    if (typeof inner !== "function") throw new Error("SIRK Central v5 request handler is unavailable.");
    const rpOrigin = new URL(config.publicOrigin);
    if (rpOrigin.protocol !== "https:") throw new Error("WebAuthn requires HTTPS.");

    const server = http.createServer(async (req, res) => {
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
            return inner(req, res);
        } catch (error) {
            if (!res.headersSent) return json(res, error.statusCode || 400, { ok: false, error: error.message || "Request failed." });
            res.destroy(error);
        }
    });
    server.on("upgrade", (req, socket, head) => app.server.emit("upgrade", req, socket, head));
    return Object.assign({}, app, { server, version: VERSION });
}

if (require.main === module) {
    const config = loadConfig(process.env);
    const app = createAttestationApp(config);
    app.server.listen(config.port, config.bindHost, () => process.stdout.write("SIRK Central v6 listening on " + config.bindHost + ":" + config.port + "\n"));
}

module.exports = { createAttestationApp, VERSION };
