"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function hashToken(token) {
    return crypto.createHash("sha256").update(String(token), "utf8").digest("base64url");
}

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function atomicWrite(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const temporary = filePath + ".tmp-" + process.pid + "-" + crypto.randomBytes(6).toString("hex");
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, filePath);
}

class PersistentSessionMap {
    constructor(options) {
        options = options || {};
        this.filePath = path.join(path.resolve(options.dataDir || path.join(process.cwd(), "data")), "sessions.json");
        this.idleMs = Math.max(5, Math.min(1440, Number(options.idleMinutes || 30))) * 60_000;
        this.absoluteMs = Math.max(1, Math.min(168, Number(options.absoluteHours || 8))) * 3_600_000;
        this.records = {};
        this.load();
    }

    load() {
        try {
            const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
            this.records = parsed && parsed.sessions && typeof parsed.sessions === "object" ? parsed.sessions : {};
        } catch (error) {
            if (error.code !== "ENOENT") throw error;
            this.records = {};
        }
        this.cleanup(false);
    }

    persist() {
        atomicWrite(this.filePath, { version: 2, sessions: this.records });
    }

    cleanup(write = true) {
        const now = Date.now();
        let changed = false;
        for (const [hash, record] of Object.entries(this.records)) {
            const absolute = Number(record.absoluteExpiresAt || record.expiresAt || 0);
            const idle = Number(record.idleExpiresAt || absolute);
            if (!absolute || absolute <= now || idle <= now) {
                delete this.records[hash];
                changed = true;
            }
        }
        if (changed && write) this.persist();
        return changed;
    }

    set(token, value) {
        const hash = hashToken(token);
        const now = Date.now();
        const requestedExpiry = Number(value && value.expiresAt || now + this.absoluteMs);
        const absoluteExpiresAt = Math.min(requestedExpiry, now + this.absoluteMs);
        this.records[hash] = Object.assign({}, clone(value || {}), {
            id: hash.slice(0, 16),
            createdAt: Number(value && value.createdAt || now),
            lastSeenAt: Number(value && value.lastSeenAt || now),
            idleExpiresAt: Math.min(absoluteExpiresAt, now + this.idleMs),
            absoluteExpiresAt,
            expiresAt: absoluteExpiresAt
        });
        this.persist();
        return this;
    }

    get(token) {
        const hash = hashToken(token);
        const record = this.records[hash];
        if (!record) return undefined;
        const now = Date.now();
        if (Number(record.absoluteExpiresAt || record.expiresAt) <= now || Number(record.idleExpiresAt || record.expiresAt) <= now) {
            delete this.records[hash];
            this.persist();
            return undefined;
        }
        record.lastSeenAt = now;
        record.idleExpiresAt = Math.min(Number(record.absoluteExpiresAt || record.expiresAt), now + this.idleMs);
        this.persist();
        return record;
    }

    has(token) {
        return Boolean(this.get(token));
    }

    delete(key) {
        const text = String(key || "");
        const directHash = hashToken(text);
        if (this.records[directHash]) {
            delete this.records[directHash];
            this.persist();
            return true;
        }
        const match = Object.entries(this.records).find(([, record]) => record.id === text);
        if (!match) return false;
        delete this.records[match[0]];
        this.persist();
        return true;
    }

    clear() {
        this.records = {};
        this.persist();
    }

    revokeWhere(predicate, exceptToken) {
        const exceptHash = exceptToken ? hashToken(exceptToken) : "";
        let count = 0;
        for (const [hash, record] of Object.entries(this.records)) {
            if (hash !== exceptHash && predicate(record)) {
                delete this.records[hash];
                count += 1;
            }
        }
        if (count) this.persist();
        return count;
    }

    entries() {
        this.cleanup();
        const values = Object.values(this.records).map(record => [record.id, record]);
        return values[Symbol.iterator]();
    }

    keys() {
        return Array.from(this.entries(), entry => entry[0])[Symbol.iterator]();
    }

    values() {
        return Array.from(this.entries(), entry => entry[1])[Symbol.iterator]();
    }

    forEach(callback, thisArg) {
        for (const [key, value] of this.entries()) callback.call(thisArg, value, key, this);
    }

    get size() {
        this.cleanup();
        return Object.keys(this.records).length;
    }

    [Symbol.iterator]() {
        return this.entries();
    }
}

module.exports = { PersistentSessionMap, hashToken };
