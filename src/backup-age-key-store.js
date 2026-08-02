"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const FILE_NAME = "backup-age-key.json";
const LEGACY_FILE_NAME = "backup-age-recipient.json";
const RECIPIENT_PATTERN = /^age1[0-9a-z]{58}$/;
const IDENTITY_PATTERN = /(?:^|\n)AGE-SECRET-KEY-1[0-9A-Z]+(?:\n|$)/;
const KDF = Object.freeze({ name: "scrypt", N: 32768, r: 8, p: 1, keyLength: 32 });

function validRecipient(value) {
    return RECIPIENT_PATTERN.test(String(value || ""));
}

function validIdentity(value) {
    return IDENTITY_PATTERN.test(String(value || "").trim() + "\n");
}

function atomicJson(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const temporary = filePath + ".tmp-" + process.pid + "-" + crypto.randomBytes(6).toString("hex");
    let descriptor;
    try {
        descriptor = fs.openSync(temporary, "wx", 0o600);
        fs.writeFileSync(descriptor, JSON.stringify(value, null, 2) + "\n", "utf8");
        fs.fsyncSync(descriptor);
        fs.closeSync(descriptor);
        descriptor = undefined;
        fs.renameSync(temporary, filePath);
        fs.chmodSync(filePath, 0o600);
    } catch (error) {
        if (descriptor !== undefined) {
            try { fs.closeSync(descriptor); } catch (_) { /* cleanup only */ }
        }
        try { fs.rmSync(temporary, { force: true }); } catch (_) { /* cleanup only */ }
        throw error;
    }
}

function deriveKey(password, salt, parameters = KDF) {
    const secret = String(password || "");
    if (secret.length < 12 || Buffer.byteLength(secret, "utf8") > 4096) {
        throw Object.assign(new Error("Break-Glass password is invalid."), { code: "BREAKGLASS_PASSWORD_INVALID", statusCode: 400 });
    }
    return crypto.scryptSync(secret, salt, parameters.keyLength, {
        N: parameters.N,
        r: parameters.r,
        p: parameters.p,
        maxmem: 128 * 1024 * 1024
    });
}

function encryptIdentity(identity, password, recipient, metadata = {}) {
    if (!validIdentity(identity)) throw new TypeError("Age backup identity is invalid.");
    if (!validRecipient(recipient)) throw new TypeError("Age backup recipient is invalid.");
    const salt = crypto.randomBytes(32);
    const nonce = crypto.randomBytes(12);
    const key = deriveKey(password, salt);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
    const aad = Buffer.from("SIRK-Central/backup-age-key/v2\n" + recipient, "utf8");
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(String(identity).trim() + "\n", "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    key.fill(0);
    return {
        version: 2,
        recipient,
        encryption: {
            algorithm: "aes-256-gcm",
            kdf: KDF,
            salt: salt.toString("base64"),
            nonce: nonce.toString("base64"),
            tag: tag.toString("base64"),
            ciphertext: ciphertext.toString("base64")
        },
        createdAtUtc: String(metadata.createdAtUtc || new Date().toISOString()),
        updatedAtUtc: new Date().toISOString(),
        updatedBy: String(metadata.updatedBy || "break-glass").slice(0, 200),
        rotation: Number(metadata.rotation || 1)
    };
}

function validateRecord(value) {
    if (!value || value.version !== 2 || !validRecipient(value.recipient) || !value.encryption) {
        throw Object.assign(new Error("Stored age backup key is invalid."), { code: "BACKUP_AGE_KEY_INVALID", statusCode: 503 });
    }
    const encryption = value.encryption;
    if (encryption.algorithm !== "aes-256-gcm" || !encryption.kdf || encryption.kdf.name !== "scrypt") {
        throw Object.assign(new Error("Stored age backup key encryption is unsupported."), { code: "BACKUP_AGE_KEY_UNSUPPORTED", statusCode: 503 });
    }
    for (const name of ["salt", "nonce", "tag", "ciphertext"]) {
        if (typeof encryption[name] !== "string" || !encryption[name]) {
            throw Object.assign(new Error("Stored age backup key is incomplete."), { code: "BACKUP_AGE_KEY_INVALID", statusCode: 503 });
        }
    }
    return value;
}

function decryptRecord(record, password) {
    validateRecord(record);
    try {
        const salt = Buffer.from(record.encryption.salt, "base64");
        const nonce = Buffer.from(record.encryption.nonce, "base64");
        const tag = Buffer.from(record.encryption.tag, "base64");
        const ciphertext = Buffer.from(record.encryption.ciphertext, "base64");
        if (salt.length !== 32 || nonce.length !== 12 || tag.length !== 16 || ciphertext.length < 32) throw new Error("Invalid encrypted key parameters.");
        const key = deriveKey(password, salt, record.encryption.kdf);
        const decipher = crypto.createDecipheriv("aes-256-gcm", key, nonce);
        decipher.setAAD(Buffer.from("SIRK-Central/backup-age-key/v2\n" + record.recipient, "utf8"));
        decipher.setAuthTag(tag);
        const identity = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
        key.fill(0);
        if (!validIdentity(identity)) throw new Error("Decrypted age identity is invalid.");
        return identity.trim() + "\n";
    } catch (error) {
        throw Object.assign(new Error("Break-Glass password cannot unlock the backup key."), {
            code: "BACKUP_AGE_KEY_UNLOCK_FAILED",
            statusCode: 401,
            cause: error
        });
    }
}

function create(options = {}) {
    const dataDir = path.resolve(options.dataDir || path.join(process.cwd(), "data"));
    const filePath = path.join(dataDir, FILE_NAME);
    const legacyPath = path.join(dataDir, LEGACY_FILE_NAME);

    function raw() {
        try { return validateRecord(JSON.parse(fs.readFileSync(filePath, "utf8"))); }
        catch (error) {
            if (error.code === "ENOENT") return null;
            throw error;
        }
    }

    function read() {
        const value = raw();
        if (!value) {
            try {
                const legacy = JSON.parse(fs.readFileSync(legacyPath, "utf8"));
                if (legacy && legacy.version === 1 && validRecipient(legacy.recipient)) {
                    return { version: 1, recipient: legacy.recipient, keyPersisted: false, migrationRequired: true,
                        updatedAtUtc: String(legacy.updatedAtUtc || ""), updatedBy: String(legacy.updatedBy || "") };
                }
            } catch (error) { if (error.code !== "ENOENT") throw error; }
            return null;
        }
        return {
            version: 2,
            recipient: value.recipient,
            keyPersisted: true,
            migrationRequired: false,
            createdAtUtc: String(value.createdAtUtc || ""),
            updatedAtUtc: String(value.updatedAtUtc || ""),
            updatedBy: String(value.updatedBy || ""),
            rotation: Number(value.rotation || 1)
        };
    }

    function setIdentity(identity, recipient, password, actor, previous) {
        const old = previous || raw();
        const record = encryptIdentity(identity, password, recipient, {
            createdAtUtc: old && old.createdAtUtc,
            updatedBy: String(actor && (actor.username || actor.displayName) || "break-glass"),
            rotation: old ? Number(old.rotation || 1) + 1 : 1
        });
        atomicJson(filePath, record);
        try { fs.rmSync(legacyPath, { force: true }); } catch (_) { /* best effort */ }
        return read();
    }

    function unlock(password) {
        const value = raw();
        if (!value) throw Object.assign(new Error("Encrypted backup key is not configured."), { code: "BACKUP_AGE_KEY_NOT_CONFIGURED", statusCode: 409 });
        return { identity: decryptRecord(value, password), recipient: value.recipient };
    }

    function stageRewrap(currentPassword, newPassword, actor) {
        const existing = raw();
        if (!existing) return { configured: false, commit() {}, abort() {} };
        const identity = decryptRecord(existing, currentPassword);
        const staged = encryptIdentity(identity, newPassword, existing.recipient, {
            createdAtUtc: existing.createdAtUtc,
            updatedBy: String(actor && (actor.username || actor.displayName) || "break-glass"),
            rotation: Number(existing.rotation || 1)
        });
        let active = true;
        return {
            configured: true,
            commit() {
                if (!active) throw new Error("Backup key rewrap transaction is no longer active.");
                atomicJson(filePath, staged);
                active = false;
                return read();
            },
            abort() { active = false; }
        };
    }

    function exportEncrypted() {
        const value = raw();
        if (!value) throw Object.assign(new Error("Encrypted backup key is not configured."), { code: "BACKUP_AGE_KEY_NOT_CONFIGURED", statusCode: 409 });
        return Buffer.from(JSON.stringify({
            format: "sirk-central-encrypted-age-key",
            exportedAtUtc: new Date().toISOString(),
            key: value
        }, null, 2) + "\n", "utf8");
    }

    return { filePath, legacyPath, read, raw, setIdentity, unlock, stageRewrap, exportEncrypted };
}

module.exports = {
    create,
    validRecipient,
    validIdentity,
    encryptIdentity,
    decryptRecord,
    FILE_NAME,
    LEGACY_FILE_NAME,
    RECIPIENT_PATTERN,
    IDENTITY_PATTERN
};
