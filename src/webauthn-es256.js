"use strict";

const crypto = require("node:crypto");

function b64url(value, field, min = 1, max = 16384) {
    const text = String(value || "");
    if (!/^[A-Za-z0-9_-]+$/.test(text) || text.length < min || text.length > max) throw new Error(field + " is invalid.");
    return Buffer.from(text, "base64url");
}

function clientData(value, expectedType, expectedChallenge, expectedOrigin) {
    const raw = b64url(value, "clientDataJSON", 8, 16384);
    let parsed;
    try { parsed = JSON.parse(raw.toString("utf8")); }
    catch (_) { throw new Error("clientDataJSON is not valid JSON."); }
    if (parsed.type !== expectedType) throw new Error("WebAuthn ceremony type mismatch.");
    if (parsed.challenge !== expectedChallenge) throw new Error("WebAuthn challenge mismatch.");
    if (parsed.origin !== expectedOrigin) throw new Error("WebAuthn origin mismatch.");
    if (parsed.crossOrigin === true) throw new Error("Cross-origin WebAuthn is not allowed.");
    return { raw, parsed };
}

function authenticatorData(value, rpId, requireUV = true) {
    const raw = b64url(value, "authenticatorData", 37, 4096);
    const expectedRpHash = crypto.createHash("sha256").update(String(rpId), "utf8").digest();
    const actualRpHash = raw.subarray(0, 32);
    if (!crypto.timingSafeEqual(expectedRpHash, actualRpHash)) throw new Error("WebAuthn RP ID hash mismatch.");
    const flags = raw[32];
    if ((flags & 0x01) === 0) throw new Error("WebAuthn user presence is required.");
    if (requireUV && (flags & 0x04) === 0) throw new Error("WebAuthn user verification is required.");
    return {
        raw,
        flags,
        counter: raw.readUInt32BE(33),
        backupEligible: Boolean(flags & 0x08),
        backupState: Boolean(flags & 0x10)
    };
}

function registration(input, options) {
    const client = clientData(input.clientDataJSON, "webauthn.create", options.challenge, options.origin);
    const auth = authenticatorData(input.authenticatorData, options.rpId, options.requireUV !== false);
    const credentialId = String(input.credentialId || input.rawId || "");
    b64url(credentialId, "credentialId", 16, 1024);
    const publicKeyDer = b64url(input.publicKey, "publicKey", 40, 4096);
    const publicKey = crypto.createPublicKey({ key: publicKeyDer, format: "der", type: "spki" });
    const details = publicKey.asymmetricKeyDetails || {};
    if (publicKey.asymmetricKeyType !== "ec" || details.namedCurve !== "prime256v1") throw new Error("Only ES256 P-256 credentials are supported.");
    if (Number(input.publicKeyAlgorithm) !== -7) throw new Error("Only ES256 algorithm is supported.");
    return {
        credentialId,
        publicKey: publicKeyDer.toString("base64url"),
        counter: auth.counter,
        backupEligible: auth.backupEligible,
        backupState: auth.backupState,
        transports: Array.isArray(input.transports) ? input.transports : [],
        clientData: client.parsed
    };
}

function authentication(input, credential, options) {
    const client = clientData(input.clientDataJSON, "webauthn.get", options.challenge, options.origin);
    const auth = authenticatorData(input.authenticatorData, options.rpId, options.requireUV !== false);
    if (String(input.credentialId || input.rawId || "") !== credential.credentialId) throw new Error("WebAuthn credential ID mismatch.");
    const clientHash = crypto.createHash("sha256").update(client.raw).digest();
    const signed = Buffer.concat([auth.raw, clientHash]);
    const signature = b64url(input.signature, "signature", 8, 1024);
    const publicKeyDer = Buffer.from(String(credential.publicKey || ""), "base64url");
    const publicKey = crypto.createPublicKey({ key: publicKeyDer, format: "der", type: "spki" });
    if (!crypto.verify("sha256", signed, publicKey, signature)) throw new Error("WebAuthn signature verification failed.");
    const previous = Math.max(0, Number(credential.counter || 0));
    if (previous > 0 && auth.counter > 0 && auth.counter <= previous) throw new Error("WebAuthn signature counter did not increase.");
    return {
        counter: auth.counter,
        backupEligible: auth.backupEligible,
        backupState: auth.backupState,
        clientData: client.parsed
    };
}

module.exports = { registration, authentication, clientData, authenticatorData };
