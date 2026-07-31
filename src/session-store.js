"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function atomicWrite(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const temporaryPath = filePath + ".tmp-" + process.pid + "-" + crypto.randomBytes(6).toString("hex");
    let descriptor;
    try {
        descriptor = fs.openSync(temporaryPath, "wx", 0o600);
        fs.writeFileSync(descriptor, JSON.stringify(value, null, 2) + "\n", "utf8");
        fs.fsyncSync(descriptor);
        fs.closeSync(descriptor);
        descriptor = undefined;
        fs.renameSync(temporaryPath, filePath);
    } catch (error) {
        if (descriptor !== undefined) {
            try { fs.closeSync(descriptor); } catch (_) { /* ignore cleanup failure */ }
        }
        try { fs.rmSync(temporaryPath, { force: true }); } catch (_) { /* ignore cleanup failure */ }
        throw error;
    }
}

function tokenHash(token) {
    return crypto.createHash("sha256").update(String(token), "utf8").digest("base64url");
}

function publicId(hash) {
    return hash.slice(0, 16);
}

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function boundedInteger(value, fallback, minimum, maximum) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.max(minimum, Math.min(maximum, Math.floor(number)));
}

function identityKey(record) {
    if (record && record.identityKey) return String(record.identityKey);
    return String(record && record.source || "") + ":" + String(record && record.username || "");
}

function create(options) {
    options = options || {};
    const dataDir = path.resolve(options.dataDir || path.join(process.cwd(), "data"));
    const filePath = path.join(dataDir, "sessions.json");
    const now = typeof options.now === "function" ? options.now : Date.now;
    const randomToken = typeof options.randomToken === "function"
        ? options.randomToken
        : () => crypto.randomBytes(32).toString("base64url");
    const idleMinutes = Math.max(5, Math.min(1440, Number(options.idleMinutes || 30)));
    const absoluteHours = Math.max(1, Math.min(168, Number(options.absoluteHours || 8)));
    const touchPersistIntervalMs = boundedInteger(options.touchPersistIntervalMs, 60_000, 5_000, 300_000);
    const maxSessions = boundedInteger(options.maxSessions, 10_000, 100, 100_000);
    const maxSessionsPerIdentity = boundedInteger(options.maxSessionsPerIdentity, 20, 1, 1_000);
    let records = {};
    const persistedTouchAt = new Map();

    function load() {
        try {
            const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
            records = parsed && typeof parsed === "object" && parsed.sessions && typeof parsed.sessions === "object"
                ? parsed.sessions
                : {};
        } catch (error) {
            if (error.code !== "ENOENT") throw error;
            records = {};
        }
        for (const [hash, record] of Object.entries(records)) persistedTouchAt.set(hash, Number(record.lastSeenAt || record.createdAt || 0));
        cleanup(false);
    }

    function persist() {
        atomicWrite(filePath, { version: 1, sessions: records });
    }

    function expired(record, timestamp) {
        return !record || record.revokedAt || record.absoluteExpiresAt <= timestamp || record.idleExpiresAt <= timestamp;
    }

    function cleanup(write = true) {
        const timestamp = now();
        let changed = false;
        for (const [hash, record] of Object.entries(records)) {
            if (expired(record, timestamp)) {
                delete records[hash];
                persistedTouchAt.delete(hash);
                changed = true;
            }
        }
        if (changed && write) persist();
        return changed;
    }

    function evictForIdentity(identity) {
        const key = identityKey(identity);
        const matches = Object.entries(records)
            .filter(([, record]) => identityKey(record) === key)
            .sort((a, b) => Number(a[1].createdAt || 0) - Number(b[1].createdAt || 0));
        while (matches.length >= maxSessionsPerIdentity) {
            const [hash] = matches.shift();
            delete records[hash];
            persistedTouchAt.delete(hash);
        }
    }

    function evictGlobal() {
        const items = Object.entries(records).sort((a, b) => Number(a[1].lastSeenAt || a[1].createdAt || 0) - Number(b[1].lastSeenAt || b[1].createdAt || 0));
        while (items.length >= maxSessions) {
            const [hash] = items.shift();
            delete records[hash];
            persistedTouchAt.delete(hash);
        }
    }

    function uniqueToken() {
        for (let attempt = 0; attempt < 8; attempt += 1) {
            const token = String(randomToken());
            if (!/^[A-Za-z0-9_-]{32,512}$/.test(token)) throw new Error("Session token generator returned an invalid token.");
            const hash = tokenHash(token);
            if (!records[hash]) return { token, hash };
        }
        throw new Error("Unable to allocate a unique session token.");
    }

    function issue(identity, metadata) {
        cleanup(false);
        evictForIdentity(identity || {});
        evictGlobal();
        const generated = uniqueToken();
        const timestamp = now();
        const record = Object.assign({}, clone(identity || {}), {
            id: publicId(generated.hash),
            tokenHash: generated.hash,
            createdAt: timestamp,
            lastSeenAt: timestamp,
            idleExpiresAt: timestamp + idleMinutes * 60_000,
            absoluteExpiresAt: timestamp + absoluteHours * 3_600_000,
            ip: String(metadata && metadata.ip || "").slice(0, 128),
            userAgent: String(metadata && metadata.userAgent || "").slice(0, 300)
        });
        records[generated.hash] = record;
        persistedTouchAt.set(generated.hash, timestamp);
        persist();
        return { token: generated.token, record: clone(record) };
    }

    function get(token, touch = true) {
        const hash = tokenHash(token);
        const record = records[hash];
        const timestamp = now();
        if (expired(record, timestamp)) {
            if (record) {
                delete records[hash];
                persistedTouchAt.delete(hash);
                persist();
            }
            return null;
        }
        if (touch) {
            record.lastSeenAt = timestamp;
            record.idleExpiresAt = Math.min(record.absoluteExpiresAt, timestamp + idleMinutes * 60_000);
            const lastPersisted = Number(persistedTouchAt.get(hash) || record.createdAt || 0);
            if (timestamp - lastPersisted >= touchPersistIntervalMs) {
                persist();
                persistedTouchAt.set(hash, timestamp);
            }
        }
        return clone(record);
    }

    function revokeToken(token) {
        const hash = tokenHash(token);
        if (!records[hash]) return false;
        delete records[hash];
        persistedTouchAt.delete(hash);
        persist();
        return true;
    }

    function revokeById(id) {
        const matches = Object.entries(records).filter(([, record]) => record.id === id);
        if (matches.length !== 1) return false;
        delete records[matches[0][0]];
        persistedTouchAt.delete(matches[0][0]);
        persist();
        return true;
    }

    function revokeWhere(predicate, exceptToken) {
        const exceptHash = exceptToken ? tokenHash(exceptToken) : "";
        let count = 0;
        for (const [hash, record] of Object.entries(records)) {
            if (hash !== exceptHash && predicate(clone(record))) {
                delete records[hash];
                persistedTouchAt.delete(hash);
                count += 1;
            }
        }
        if (count) persist();
        return count;
    }

    function list() {
        cleanup();
        return Object.values(records).map(record => {
            const value = clone(record);
            delete value.tokenHash;
            return value;
        });
    }

    load();
    return { issue, get, revokeToken, revokeById, revokeWhere, list, cleanup, filePath };
}

module.exports = { create, tokenHash, identityKey };
