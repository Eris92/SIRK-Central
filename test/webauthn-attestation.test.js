"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const { verifyRegistration } = require("../src/webauthn-attestation");

function head(major, length) {
    if (length < 24) return Buffer.from([(major << 5) | length]);
    if (length < 256) return Buffer.from([(major << 5) | 24, length]);
    const value = Buffer.alloc(3); value[0] = (major << 5) | 25; value.writeUInt16BE(length, 1); return value;
}
function cbor(value) {
    if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.length), value]);
    if (typeof value === "string") { const data = Buffer.from(value); return Buffer.concat([head(3, data.length), data]); }
    if (Number.isInteger(value) && value >= 0) return head(0, value);
    if (Number.isInteger(value) && value < 0) return head(1, -1 - value);
    if (value instanceof Map) { const parts = [head(5, value.size)]; for (const [key, item] of value) parts.push(cbor(key), cbor(item)); return Buffer.concat(parts); }
    throw new Error("Unsupported test CBOR value");
}
function clientData(challenge, origin) {
    return Buffer.from(JSON.stringify({ type: "webauthn.create", challenge, origin, crossOrigin: false })).toString("base64url");
}
function fixture(overrides = {}) {
    const { publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const jwk = publicKey.export({ format: "jwk" });
    const credential = crypto.randomBytes(32);
    const rpId = overrides.rpId || "central.example.test";
    const flags = overrides.flags === undefined ? 0x45 : overrides.flags;
    const auth = Buffer.concat([
        crypto.createHash("sha256").update(rpId).digest(),
        Buffer.from([flags]),
        Buffer.alloc(4),
        Buffer.alloc(16),
        Buffer.from([0, credential.length]),
        credential,
        cbor(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, "base64url")], [-3, Buffer.from(jwk.y, "base64url")]]))
    ]);
    const object = cbor(new Map([["fmt", overrides.fmt || "none"], ["authData", auth], ["attStmt", new Map()]]));
    const challenge = "challenge-123";
    return {
        input: {
            credentialId: (overrides.credential || credential).toString("base64url"),
            clientDataJSON: clientData(challenge, "https://central.example.test"),
            attestationObject: object.toString("base64url"),
            transports: ["usb", "nfc"]
        },
        options: { challenge, origin: "https://central.example.test", rpId: "central.example.test", requireUV: true }
    };
}

test("parses fmt none attestation and extracts ES256 credential", () => {
    const data = fixture();
    const result = verifyRegistration(data.input, data.options);
    assert.equal(result.credentialId, data.input.credentialId);
    assert.match(result.publicKey, /^[A-Za-z0-9_-]+$/);
    assert.equal(result.counter, 0);
    assert.equal(result.aaguid, "00000000-0000-0000-0000-000000000000");
    assert.deepEqual(result.transports, ["usb", "nfc"]);
});

test("rejects wrong RP ID", () => {
    const data = fixture({ rpId: "wrong.example.test" });
    assert.throws(() => verifyRegistration(data.input, data.options), /RP ID hash mismatch/);
});

test("rejects mismatched credential ID", () => {
    const data = fixture({ credential: crypto.randomBytes(32) });
    assert.throws(() => verifyRegistration(data.input, data.options), /credential ID mismatch/);
});

test("rejects unsupported attestation format", () => {
    const data = fixture({ fmt: "packed" });
    assert.throws(() => verifyRegistration(data.input, data.options), /format 'none'/);
});

test("requires user verification", () => {
    const data = fixture({ flags: 0x41 });
    assert.throws(() => verifyRegistration(data.input, data.options), /user verification/);
});
