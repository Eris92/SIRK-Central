"use strict";

const crypto = require("node:crypto");
const http = require("node:http");
const { sign } = require("../src/sso-ticket");

function required(env, name) {
    const value = String(env[name] || "").trim();
    if (!value) throw new Error(name + " is required.");
    return value;
}

function loadConfig(env) {
    const authOrigin = required(env, "SIRK_AUTH_ORIGIN").replace(/\/+$/, "");
    const centralOrigin = required(env, "SIRK_PUBLIC_ORIGIN").replace(/\/+$/, "");
    const clientId = required(env, "SIRK_ENTRA_CLIENT_ID");
    const clientSecret = required(env, "SIRK_ENTRA_CLIENT_SECRET");
    const sharedSecret = required(env, "SIRK_SSO_SHARED_SECRET");
    const tenant = String(env.SIRK_ENTRA_TENANT || "organizations").trim();
    const allowedIdentities = new Set(required(env, "SIRK_ENTRA_ADMIN_IDENTITIES").split(",")
        .map((value) => value.trim().toLowerCase()).filter(Boolean));
    const identityPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    if (!allowedIdentities.size || [...allowedIdentities].some((value) => !identityPattern.test(value))) {
        throw new Error("SIRK_ENTRA_ADMIN_IDENTITIES must contain comma-separated tenant-id:object-id values.");
    }
    const port = Number(env.SIRK_AUTH_PORT || 8081);
    const bindHost = env.SIRK_AUTH_BIND_HOST || "127.0.0.1";
    if (!authOrigin.startsWith("https://") || !centralOrigin.startsWith("https://")) {
        throw new Error("Auth and Central origins must use HTTPS.");
    }
    if (sharedSecret.length < 43) throw new Error("SIRK_SSO_SHARED_SECRET must contain at least 43 characters.");
    return {
        authOrigin,
        centralOrigin,
        clientId,
        clientSecret,
        sharedSecret,
        tenant,
        allowedIdentities,
        port,
        bindHost,
        callbackUrl: authOrigin + "/auth/entra/callback",
        authorizeUrl: "https://login.microsoftonline.com/" + encodeURIComponent(tenant) + "/oauth2/v2.0/authorize",
        tokenUrl: "https://login.microsoftonline.com/" + encodeURIComponent(tenant) + "/oauth2/v2.0/token",
        jwksUrl: "https://login.microsoftonline.com/common/discovery/v2.0/keys"
    };
}

function b64json(part) {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

function sha256Base64url(value) {
    return crypto.createHash("sha256").update(value).digest("base64url");
}

function secureHeaders(extra) {
    return Object.assign({
        "Cache-Control": "no-store",
        "Pragma": "no-cache",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
        "Referrer-Policy": "no-referrer",
        "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'"
    }, extra || {});
}

function redirect(res, location) {
    res.writeHead(302, secureHeaders({ Location: location, "Content-Length": "0" }));
    res.end();
}

function text(res, status, body) {
    const data = Buffer.from(body, "utf8");
    res.writeHead(status, secureHeaders({
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Length": data.length
    }));
    res.end(data);
}

function createApp(config) {
    const pending = new Map();
    let jwksCache = { expiresAt: 0, keys: [] };

    function prune() {
        const now = Date.now();
        for (const [state, item] of pending) if (item.expiresAt < now) pending.delete(state);
    }

    async function downloadJwks() {
        const response = await fetch(config.jwksUrl, { headers: { accept: "application/json" } });
        if (!response.ok) throw new Error("Unable to download Entra signing keys.");
        const body = await response.json();
        jwksCache = { expiresAt: Date.now() + 60 * 60 * 1000, keys: Array.isArray(body.keys) ? body.keys : [] };
    }

    async function getJwk(kid) {
        if (jwksCache.expiresAt < Date.now()) await downloadJwks();
        let key = jwksCache.keys.find((item) => item.kid === kid && item.kty === "RSA");
        if (!key) {
            await downloadJwks();
            key = jwksCache.keys.find((item) => item.kid === kid && item.kty === "RSA");
        }
        if (!key) throw new Error("Entra signing key was not found.");
        return key;
    }

    async function validateIdToken(token, nonce) {
        const parts = String(token || "").split(".");
        if (parts.length !== 3) throw new Error("Invalid Entra ID token.");
        const header = b64json(parts[0]);
        const claims = b64json(parts[1]);
        if (header.alg !== "RS256" || !header.kid) throw new Error("Unsupported Entra token algorithm.");
        const jwk = await getJwk(header.kid);
        const key = crypto.createPublicKey({ key: jwk, format: "jwk" });
        const valid = crypto.verify("RSA-SHA256", Buffer.from(parts[0] + "." + parts[1]), key, Buffer.from(parts[2], "base64url"));
        if (!valid) throw new Error("Invalid Entra ID token signature.");

        const now = Math.floor(Date.now() / 1000);
        if (claims.aud !== config.clientId) throw new Error("Invalid Entra token audience.");
        if (!claims.exp || claims.exp < now - 30 || (claims.nbf && claims.nbf > now + 30)) throw new Error("Expired Entra ID token.");
        if (claims.nonce !== nonce) throw new Error("Invalid Entra token nonce.");
        if (!claims.tid || !claims.oid) throw new Error("Entra token is missing tid or oid.");
        const expectedIssuer = "https://login.microsoftonline.com/" + claims.tid + "/v2.0";
        if (claims.iss !== expectedIssuer) throw new Error("Invalid Entra token issuer.");
        const identity = (String(claims.tid) + ":" + String(claims.oid)).toLowerCase();
        if (!config.allowedIdentities.has(identity)) throw new Error("This Entra identity is not authorized for SIRK Central.");
        return claims;
    }

    async function exchangeCode(code, verifier) {
        const body = new URLSearchParams({
            client_id: config.clientId,
            client_secret: config.clientSecret,
            grant_type: "authorization_code",
            code,
            redirect_uri: config.callbackUrl,
            code_verifier: verifier,
            scope: "openid profile email User.Read"
        });
        const response = await fetch(config.tokenUrl, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded", accept: "application/json" },
            body
        });
        const result = await response.json();
        if (!response.ok || !result.id_token) {
            throw new Error("Entra code exchange failed: " + String(result.error_description || result.error || response.status));
        }
        return result;
    }

    async function handler(req, res) {
        try {
            prune();
            const url = new URL(req.url, "http://auth.local");
            if (req.method === "GET" && url.pathname === "/healthz") return text(res, 200, "ok\n");
            if (req.method === "GET" && url.pathname === "/") return redirect(res, "/login");
            if (req.method === "GET" && url.pathname === "/login") {
                const state = crypto.randomBytes(32).toString("base64url");
                const nonce = crypto.randomBytes(32).toString("base64url");
                const verifier = crypto.randomBytes(48).toString("base64url");
                pending.set(state, { nonce, verifier, expiresAt: Date.now() + 10 * 60 * 1000 });
                const authorize = new URL(config.authorizeUrl);
                authorize.search = new URLSearchParams({
                    client_id: config.clientId,
                    response_type: "code",
                    redirect_uri: config.callbackUrl,
                    response_mode: "query",
                    scope: "openid profile email User.Read",
                    state,
                    nonce,
                    code_challenge: sha256Base64url(verifier),
                    code_challenge_method: "S256",
                    prompt: "select_account"
                }).toString();
                return redirect(res, authorize.toString());
            }
            if (req.method === "GET" && url.pathname === "/auth/entra/callback") {
                if (url.searchParams.get("error")) {
                    throw new Error("Entra sign-in failed: " + String(url.searchParams.get("error_description") || url.searchParams.get("error")));
                }
                const state = String(url.searchParams.get("state") || "");
                const code = String(url.searchParams.get("code") || "");
                const flow = pending.get(state);
                pending.delete(state);
                if (!state || !code || !flow || flow.expiresAt < Date.now()) throw new Error("Invalid or expired OAuth state.");
                const tokens = await exchangeCode(code, flow.verifier);
                const claims = await validateIdToken(tokens.id_token, flow.nonce);
                const now = Math.floor(Date.now() / 1000);
                const ticket = sign({
                    v: 1,
                    iss: config.authOrigin,
                    aud: config.centralOrigin,
                    iat: now,
                    exp: now + 60,
                    jti: crypto.randomBytes(24).toString("base64url"),
                    tid: String(claims.tid),
                    oid: String(claims.oid),
                    name: String(claims.name || claims.preferred_username || "Entra user").slice(0, 160),
                    username: String(claims.preferred_username || claims.email || "").slice(0, 254)
                }, config.sharedSecret);
                return redirect(res, config.centralOrigin + "/auth/sso/callback?ticket=" + encodeURIComponent(ticket));
            }
            if ((req.method === "GET" || req.method === "POST") && url.pathname === "/auth/entra/frontchannel-logout") {
                return text(res, 200, "signed out\n");
            }
            if (req.method === "GET" && url.pathname === "/logout") {
                const logout = new URL("https://login.microsoftonline.com/" + encodeURIComponent(config.tenant) + "/oauth2/v2.0/logout");
                logout.searchParams.set("post_logout_redirect_uri", config.authOrigin + "/login");
                return redirect(res, logout.toString());
            }
            return text(res, 404, "not found\n");
        } catch (error) {
            return text(res, 400, error.message + "\n");
        }
    }

    return http.createServer(handler);
}

if (require.main === module) {
    const config = loadConfig(process.env);
    createApp(config).listen(config.port, config.bindHost, () => {
        process.stdout.write("SIRK Auth Broker listening on " + config.bindHost + ":" + config.port + "\n");
    });
}

module.exports = { loadConfig, createApp };
