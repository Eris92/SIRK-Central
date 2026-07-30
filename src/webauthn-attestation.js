"use strict";

const crypto = require("node:crypto");
const { clientData } = require("./webauthn-es256");

function b64url(value, field, min = 1, max = 65536) {
    const text = String(value || "");
    if (!/^[A-Za-z0-9_-]+$/.test(text) || text.length < min || text.length > max) throw new Error(field + " is invalid.");
    return Buffer.from(text, "base64url");
}

function decoder(buffer) {
    let offset = 0;
    function length(additional) {
        if (additional < 24) return additional;
        if (additional === 24) return buffer.readUInt8(offset++);
        if (additional === 25) { const value = buffer.readUInt16BE(offset); offset += 2; return value; }
        if (additional === 26) { const value = buffer.readUInt32BE(offset); offset += 4; return value; }
        throw new Error("Unsupported or indefinite CBOR length.");
    }
    function read() {
        if (offset >= buffer.length) throw new Error("Unexpected end of CBOR data.");
        const initial = buffer[offset++];
        const major = initial >> 5;
        const additional = initial & 31;
        const size = length(additional);
        if (major === 0) return size;
        if (major === 1) return -1 - size;
        if (major === 2) { const value = buffer.subarray(offset, offset + size); offset += size; return value; }
        if (major === 3) { const value = buffer.subarray(offset, offset + size).toString("utf8"); offset += size; return value; }
        if (major === 4) { const value = []; for (let i = 0; i < size; i += 1) value.push(read()); return value; }
        if (major === 5) { const value = new Map(); for (let i = 0; i < size; i += 1) value.set(read(), read()); return value; }
        if (major === 7 && additional === 20) return false;
        if (major === 7 && additional === 21) return true;
        if (major === 7 && additional === 22) return null;
        throw new Error("Unsupported CBOR value.");
    }
    const value = read();
    return { value, bytesRead: offset };
}

function coseToSpki(cose) {
    if (!(cose instanceof Map)) throw new Error("COSE public key is invalid.");
    if (cose.get(1) !== 2 || cose.get(3) !== -7 || cose.get(-1) !== 1) throw new Error("Only COSE EC2 ES256 P-256 keys are supported.");
    const x = cose.get(-2), y = cose.get(-3);
    if (!Buffer.isBuffer(x) || x.length !== 32 || !Buffer.isBuffer(y) || y.length !== 32) throw new Error("COSE P-256 coordinates are invalid.");
    const key = crypto.createPublicKey({ key: { kty: "EC", crv: "P-256", x: x.toString("base64url"), y: y.toString("base64url") }, format: "jwk" });
    return key.export({ format: "der", type: "spki" });
}

function aaguidText(value) {
    const hex = value.toString("hex");
    return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-");
}

function verifyRegistration(input, options) {
    const client = clientData(input.clientDataJSON, "webauthn.create", options.challenge, options.origin);
    const object = decoder(b64url(input.attestationObject, "attestationObject", 16)).value;
    if (!(object instanceof Map)) throw new Error("attestationObject is invalid.");
    if (object.get("fmt") !== "none") throw new Error("Only WebAuthn attestation format 'none' is accepted.");
    const statement = object.get("attStmt");
    if (!(statement instanceof Map) || statement.size !== 0) throw new Error("Unexpected attestation statement.");
    const authData = object.get("authData");
    if (!Buffer.isBuffer(authData) || authData.length < 55) throw new Error("Attestation authenticator data is invalid.");
    const rpHash = crypto.createHash("sha256").update(String(options.rpId), "utf8").digest();
    if (!crypto.timingSafeEqual(rpHash, authData.subarray(0, 32))) throw new Error("WebAuthn RP ID hash mismatch.");
    const flags = authData[32];
    if ((flags & 0x01) === 0) throw new Error("WebAuthn user presence is required.");
    if (options.requireUV !== false && (flags & 0x04) === 0) throw new Error("WebAuthn user verification is required.");
    if ((flags & 0x40) === 0) throw new Error("Attested credential data is missing.");
    const counter = authData.readUInt32BE(33);
    const aaguid = authData.subarray(37, 53);
    const idLength = authData.readUInt16BE(53);
    const idStart = 55, idEnd = idStart + idLength;
    if (idLength < 16 || idEnd >= authData.length) throw new Error("Attested credential ID is invalid.");
    const credentialId = authData.subarray(idStart, idEnd).toString("base64url");
    const rawId = String(input.credentialId || input.rawId || "");
    if (rawId !== credentialId) throw new Error("Attested credential ID mismatch.");
    const decodedKey = decoder(authData.subarray(idEnd));
    const publicKey = coseToSpki(decodedKey.value);
    return {
        credentialId,
        publicKey: publicKey.toString("base64url"),
        counter,
        aaguid: aaguidText(aaguid),
        transports: Array.isArray(input.transports) ? input.transports : [],
        backupEligible: Boolean(flags & 0x08),
        backupState: Boolean(flags & 0x10),
        clientData: client.parsed
    };
}

module.exports = { verifyRegistration, decoder, coseToSpki };
