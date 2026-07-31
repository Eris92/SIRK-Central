"use strict";

const crypto = require("node:crypto");

function base64url(value) {
    return Buffer.from(value).toString("base64url");
}

function timingSafeTextEqual(left, right) {
    const a = Buffer.from(String(left));
    const b = Buffer.from(String(right));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function sign(payload, secret) {
    if (typeof secret !== "string" || secret.length < 43) {
        throw new Error("SSO shared secret must contain at least 43 characters.");
    }
    const encoded = base64url(JSON.stringify(payload));
    const signature = crypto.createHmac("sha256", secret).update(encoded).digest("base64url");
    return encoded + "." + signature;
}

function verify(token, secret, expected) {
    const raw = String(token || "");
    if (raw.length > 32768) throw new Error("Invalid SSO ticket format.");
    const parts = raw.split(".");
    if (parts.length !== 2) throw new Error("Invalid SSO ticket format.");
    const signature = crypto.createHmac("sha256", secret).update(parts[0]).digest("base64url");
    if (!timingSafeTextEqual(signature, parts[1])) throw new Error("Invalid SSO ticket signature.");

    let payload;
    try {
        payload = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    } catch (_) {
        throw new Error("Invalid SSO ticket payload.");
    }

    const now = Math.floor(Date.now() / 1000);
    if (!payload || payload.v !== 1 || typeof payload.jti !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(payload.jti)) {
        throw new Error("Invalid SSO ticket claims.");
    }
    if (!Number.isInteger(payload.iat) || !Number.isInteger(payload.exp) || payload.iat > now + 30 || payload.exp < now) {
        throw new Error("Expired SSO ticket.");
    }
    if (payload.exp - payload.iat > 90) throw new Error("SSO ticket lifetime is too long.");
    if (expected && payload.iss !== expected.issuer) throw new Error("Invalid SSO ticket issuer.");
    if (expected && payload.aud !== expected.audience) throw new Error("Invalid SSO ticket audience.");

    const type = String(payload.typ || "login");
    if (expected && expected.type && type !== expected.type) throw new Error("Invalid SSO ticket type.");
    if (type === "login") {
        if (!payload.tid || !payload.oid) throw new Error("SSO ticket identity is incomplete.");
    } else if (type === "logout") {
        if (!/^[A-Za-z0-9._~-]{8,512}$/.test(String(payload.sid || ""))) throw new Error("SSO logout ticket session is invalid.");
        if (typeof payload.providerIssuer !== "string" || payload.providerIssuer.length > 512) throw new Error("SSO logout ticket issuer is invalid.");
    } else throw new Error("Unsupported SSO ticket type.");
    return payload;
}

module.exports = { sign, verify };
