"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const webauthn = require("../src/webauthn-es256");

function client(type, challenge, origin) {
    return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false })).toString("base64url");
}
function authData(rpId, flags, counter) {
    const value = Buffer.alloc(37);
    crypto.createHash("sha256").update(rpId).digest().copy(value, 0);
    value[32] = flags;
    value.writeUInt32BE(counter, 33);
    return value;
}

test("ES256 registration and authentication verify origin, RP ID, UV, signature and counter", () => {
    const rpId = "central.example.test";
    const origin = "https://central.example.test";
    const challenge = crypto.randomBytes(32).toString("base64url");
    const credentialId = crypto.randomBytes(32).toString("base64url");
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const publicKeyDer = publicKey.export({ format: "der", type: "spki" });
    const registrationAuth = authData(rpId, 0x05, 0);
    const registered = webauthn.registration({
        credentialId,
        clientDataJSON: client("webauthn.create", challenge, origin),
        authenticatorData: registrationAuth.toString("base64url"),
        publicKey: publicKeyDer.toString("base64url"),
        publicKeyAlgorithm: -7,
        transports: ["usb"]
    }, { challenge, origin, rpId, requireUV: true });
    assert.equal(registered.credentialId, credentialId);
    assert.equal(registered.counter, 0);

    const authChallenge = crypto.randomBytes(32).toString("base64url");
    const clientRaw = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge: authChallenge, origin, crossOrigin: false }));
    const assertionAuth = authData(rpId, 0x05, 1);
    const signed = Buffer.concat([assertionAuth, crypto.createHash("sha256").update(clientRaw).digest()]);
    const signature = crypto.sign("sha256", signed, privateKey);
    const result = webauthn.authentication({
        credentialId,
        clientDataJSON: clientRaw.toString("base64url"),
        authenticatorData: assertionAuth.toString("base64url"),
        signature: signature.toString("base64url")
    }, { credentialId, publicKey: registered.publicKey, counter: 0 }, { challenge: authChallenge, origin, rpId, requireUV: true });
    assert.equal(result.counter, 1);

    assert.throws(() => webauthn.authentication({
        credentialId,
        clientDataJSON: clientRaw.toString("base64url"),
        authenticatorData: assertionAuth.toString("base64url"),
        signature: signature.toString("base64url")
    }, { credentialId, publicKey: registered.publicKey, counter: 1 }, { challenge: authChallenge, origin, rpId, requireUV: true }), /counter/);

    assert.throws(() => webauthn.registration({
        credentialId,
        clientDataJSON: client("webauthn.create", challenge, "https://evil.example"),
        authenticatorData: registrationAuth.toString("base64url"),
        publicKey: publicKeyDer.toString("base64url"),
        publicKeyAlgorithm: -7
    }, { challenge, origin, rpId, requireUV: true }), /origin/);

    assert.throws(() => webauthn.registration({
        credentialId,
        clientDataJSON: client("webauthn.create", challenge, origin),
        authenticatorData: authData("wrong.example", 0x05, 0).toString("base64url"),
        publicKey: publicKeyDer.toString("base64url"),
        publicKeyAlgorithm: -7
    }, { challenge, origin, rpId, requireUV: true }), /RP ID/);

    assert.throws(() => webauthn.registration({
        credentialId,
        clientDataJSON: client("webauthn.create", challenge, origin),
        authenticatorData: authData(rpId, 0x01, 0).toString("base64url"),
        publicKey: publicKeyDer.toString("base64url"),
        publicKeyAlgorithm: -7
    }, { challenge, origin, rpId, requireUV: true }), /user verification/);
});
