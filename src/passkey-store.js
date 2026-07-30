"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function atomicWrite(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const temporary = filePath + ".tmp-" + process.pid + "-" + crypto.randomBytes(5).toString("hex");
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, filePath);
}
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function identityKey(identity) {
    const value = String(identity && (identity.identityKey || identity.username) || "").trim();
    if (!value || value.length > 180) throw new Error("Identity key is invalid.");
    return value;
}
function credentialId(value) {
    const id = String(value || "").trim();
    if (!/^[A-Za-z0-9_-]{16,512}$/.test(id)) throw new Error("Credential ID is invalid.");
    return id;
}

function create(options) {
    options = options || {};
    const dataDir = path.resolve(options.dataDir || path.join(process.cwd(), "data"));
    const filePath = path.join(dataDir, "passkeys.json");
    const now = typeof options.now === "function" ? options.now : Date.now;
    let state = { version: 1, credentials: {} };
    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
        if (parsed && parsed.version === 1 && parsed.credentials) state = parsed;
    } catch (error) {
        if (error.code !== "ENOENT") throw error;
    }
    function persist() { atomicWrite(filePath, state); }

    function register(input, identity) {
        const owner = identityKey(identity);
        const id = credentialId(input && input.credentialId);
        if (state.credentials[id] && !state.credentials[id].revokedAtUtc) throw new Error("Passkey is already registered.");
        const publicKey = String(input && input.publicKey || "").trim();
        if (!/^[A-Za-z0-9+/=_-]{40,8192}$/.test(publicKey)) throw new Error("Public key is invalid.");
        const transports = Array.isArray(input && input.transports) ? input.transports.filter(x => ["usb", "nfc", "ble", "internal", "hybrid"].includes(x)) : [];
        const timestamp = new Date(now()).toISOString();
        const record = {
            credentialId: id,
            owner,
            displayName: String(input && input.displayName || "Passkey").trim().slice(0, 120) || "Passkey",
            publicKey,
            counter: Math.max(0, Number(input && input.counter || 0)),
            aaguid: String(input && input.aaguid || "").trim().slice(0, 64),
            transports,
            backupEligible: Boolean(input && input.backupEligible),
            backupState: Boolean(input && input.backupState),
            createdAtUtc: timestamp,
            lastUsedAtUtc: null,
            status: "active"
        };
        state.credentials[id] = record;
        persist();
        return clone(record);
    }

    function verifyUse(idValue, identity, newCounter) {
        const id = credentialId(idValue);
        const record = state.credentials[id];
        if (!record || record.revokedAtUtc || record.status !== "active") throw new Error("Passkey not found or revoked.");
        if (record.owner !== identityKey(identity)) throw new Error("Passkey owner mismatch.");
        const counter = Math.max(0, Number(newCounter || 0));
        if (counter > 0 && record.counter > 0 && counter <= record.counter) throw new Error("Passkey signature counter did not increase.");
        if (counter > record.counter) record.counter = counter;
        record.lastUsedAtUtc = new Date(now()).toISOString();
        persist();
        return clone(record);
    }

    function revoke(idValue, actor) {
        const id = credentialId(idValue);
        const record = state.credentials[id];
        if (!record || record.revokedAtUtc) throw new Error("Passkey not found.");
        record.status = "revoked";
        record.revokedAtUtc = new Date(now()).toISOString();
        record.revokedBy = identityKey(actor);
        persist();
        return clone(record);
    }

    function list(identity) {
        const owner = identityKey(identity);
        return Object.values(state.credentials).filter(item => item.owner === owner).map(item => {
            const copy = clone(item);
            delete copy.publicKey;
            return copy;
        });
    }

    function activeCount(identity) {
        return list(identity).filter(item => item.status === "active").length;
    }

    return { register, verifyUse, revoke, list, activeCount, filePath };
}

module.exports = { create };
