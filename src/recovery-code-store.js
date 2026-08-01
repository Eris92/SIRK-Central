"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function atomicWrite(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const temporary = filePath + ".tmp-" + process.pid + "-" + crypto.randomBytes(6).toString("hex");
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, filePath);
}

function ownerKey(identity) {
    const value = String(identity && (identity.identityKey || identity.username) || "").trim();
    if (!value || value.length > 180) throw new Error("Recovery-code owner is invalid.");
    return value;
}

function normalizeCode(value) {
    return String(value || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function codeHash(owner, code, salt) {
    return crypto.scryptSync(owner + ":" + normalizeCode(code), salt, 32).toString("base64url");
}

function create(options) {
    options = options || {};
    const dataDir = path.resolve(options.dataDir || path.join(process.cwd(), "data"));
    const filePath = path.join(dataDir, "recovery-codes.json");
    const now = typeof options.now === "function" ? options.now : Date.now;
    let state = { version: 1, owners: {} };

    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
        if (!parsed || parsed.version !== 1 || !parsed.owners || typeof parsed.owners !== "object") throw new Error("Recovery code store has an unsupported schema.");
        state = parsed;
    } catch (error) {
        if (error.code !== "ENOENT") throw error;
    }

    function persist() { atomicWrite(filePath, state); }

    function generate(identity, count = 10) {
        const owner = ownerKey(identity);
        const number = Math.max(5, Math.min(20, Number(count || 10)));
        const salt = crypto.randomBytes(16).toString("base64url");
        const plaintext = [];
        const hashes = [];
        for (let index = 0; index < number; index += 1) {
            const raw = crypto.randomBytes(10).toString("base64url").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 16);
            const formatted = raw.match(/.{1,4}/g).join("-");
            plaintext.push(formatted);
            hashes.push({ hash: codeHash(owner, formatted, salt), usedAtUtc: null });
        }
        const timestamp = new Date(now()).toISOString();
        state.owners[owner] = { owner, salt, codes: hashes, createdAtUtc: timestamp, rotatedAtUtc: timestamp, failedAttempts: 0, blockedUntil: 0 };
        persist();
        return plaintext;
    }

    function registerFailure(record, timestamp) {
        record.failedAttempts = Number(record.failedAttempts || 0) + 1;
        if (record.failedAttempts >= 5) {
            record.blockedUntil = timestamp + 15 * 60_000;
            record.failedAttempts = 0;
        }
        persist();
    }

    function verify(identity, suppliedCode) {
        const owner = ownerKey(identity);
        const record = state.owners[owner];
        if (!record) throw new Error("Recovery codes are not configured.");
        const timestamp = now();
        if (record.blockedUntil > timestamp) throw new Error("Recovery-code verification is temporarily blocked.");
        const normalized = normalizeCode(suppliedCode);
        if (normalized.length < 12 || normalized.length > 32) {
            registerFailure(record, timestamp);
            throw new Error("Recovery code is invalid.");
        }
        const candidate = codeHash(owner, normalized, record.salt);
        const candidateBuffer = Buffer.from(candidate);
        let matched = null;
        for (const item of record.codes) {
            if (item.usedAtUtc) continue;
            const expected = Buffer.from(item.hash);
            if (candidateBuffer.length === expected.length && crypto.timingSafeEqual(candidateBuffer, expected)) {
                matched = item;
                break;
            }
        }
        if (!matched) {
            registerFailure(record, timestamp);
            throw new Error("Recovery code is invalid.");
        }
        matched.usedAtUtc = new Date(timestamp).toISOString();
        record.failedAttempts = 0;
        record.blockedUntil = 0;
        persist();
        return { ok: true, remaining: record.codes.filter(item => !item.usedAtUtc).length };
    }

    function status(identity) {
        const owner = ownerKey(identity);
        const record = state.owners[owner];
        if (!record) return { configured: false, remaining: 0 };
        return {
            configured: true,
            createdAtUtc: record.createdAtUtc,
            rotatedAtUtc: record.rotatedAtUtc,
            remaining: record.codes.filter(item => !item.usedAtUtc).length,
            blockedUntilUtc: record.blockedUntil > now() ? new Date(record.blockedUntil).toISOString() : null
        };
    }

    function revoke(identity) {
        const owner = ownerKey(identity);
        const existed = Boolean(state.owners[owner]);
        delete state.owners[owner];
        if (existed) persist();
        return existed;
    }

    return { generate, verify, status, revoke, filePath };
}

module.exports = { create, normalizeCode };
