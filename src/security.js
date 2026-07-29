"use strict";

const crypto = require("node:crypto");

function hashSecret(secret, salt) {
    if (typeof secret !== "string" || secret.length < 12) {
        throw new Error("Secret must contain at least 12 characters.");
    }
    const actualSalt = salt || crypto.randomBytes(16);
    const derived = crypto.scryptSync(secret, actualSalt, 32, {
        N: 32768,
        r: 8,
        p: 1,
        maxmem: 64 * 1024 * 1024
    });
    return "scrypt$" + actualSalt.toString("base64url") + "$" + derived.toString("base64url");
}

function verifySecret(secret, encoded) {
    try {
        const parts = String(encoded || "").split("$");
        if (parts.length !== 3 || parts[0] !== "scrypt") return false;
        const salt = Buffer.from(parts[1], "base64url");
        const expected = Buffer.from(parts[2], "base64url");
        const actual = crypto.scryptSync(String(secret || ""), salt, expected.length, {
            N: 32768,
            r: 8,
            p: 1,
            maxmem: 64 * 1024 * 1024
        });
        return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
    } catch (_) {
        return false;
    }
}

function randomToken(bytes) {
    return crypto.randomBytes(bytes || 32).toString("base64url");
}

function hashAccessKey(key) {
    if (typeof key !== "string" || key.length < 32) {
        throw new Error("Access key must contain at least 32 characters.");
    }
    return "sha256$" + crypto.createHash("sha256").update(key, "utf8").digest("base64url");
}

function verifyAccessKey(key, encoded) {
    try {
        const parts = String(encoded || "").split("$");
        if (parts.length !== 2 || parts[0] !== "sha256") return false;
        const expected = Buffer.from(parts[1], "base64url");
        const actual = crypto.createHash("sha256").update(String(key || ""), "utf8").digest();
        return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
    } catch (_) {
        return false;
    }
}

module.exports = { hashSecret, verifySecret, randomToken, hashAccessKey, verifyAccessKey };
