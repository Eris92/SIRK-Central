"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function atomicWrite(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const temporaryPath = filePath + ".tmp-" + process.pid + "-" + crypto.randomBytes(6).toString("hex");
    fs.writeFileSync(temporaryPath, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    fs.renameSync(temporaryPath, filePath);
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
    let records = {};

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
                changed = true;
            }
        }
        if (changed && write) persist();
        return changed;
    }

    function issue(identity, metadata) {
        const token = randomToken();
        const hash = tokenHash(token);
        const timestamp = now();
        const record = Object.assign({}, clone(identity || {}), {
            id: publicId(hash),
            tokenHash: hash,
            createdAt: timestamp,
            lastSeenAt: timestamp,
            idleExpiresAt: timestamp + idleMinutes * 60_000,
            absoluteExpiresAt: timestamp + absoluteHours * 3_600_000,
            ip: String(metadata && metadata.ip || "").slice(0, 128),
            userAgent: String(metadata && metadata.userAgent || "").slice(0, 300)
        });
        records[hash] = record;
        persist();
        return { token, record: clone(record) };
    }

    function get(token, touch = true) {
        const hash = tokenHash(token);
        const record = records[hash];
        const timestamp = now();
        if (expired(record, timestamp)) {
            if (record) {
                delete records[hash];
                persist();
            }
            return null;
        }
        if (touch) {
            record.lastSeenAt = timestamp;
            record.idleExpiresAt = Math.min(record.absoluteExpiresAt, timestamp + idleMinutes * 60_000);
            persist();
        }
        return clone(record);
    }

    function revokeToken(token) {
        const hash = tokenHash(token);
        if (!records[hash]) return false;
        delete records[hash];
        persist();
        return true;
    }

    function revokeById(id) {
        const matches = Object.entries(records).filter(([, record]) => record.id === id);
        if (matches.length !== 1) return false;
        delete records[matches[0][0]];
        persist();
        return true;
    }

    function revokeWhere(predicate, exceptToken) {
        const exceptHash = exceptToken ? tokenHash(exceptToken) : "";
        let count = 0;
        for (const [hash, record] of Object.entries(records)) {
            if (hash !== exceptHash && predicate(clone(record))) {
                delete records[hash];
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

module.exports = { create, tokenHash };
