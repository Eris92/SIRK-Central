"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function atomicWrite(filePath, value) {
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
    } catch (error) {
        if (descriptor !== undefined) {
            try { fs.closeSync(descriptor); } catch (_) { /* ignore cleanup failure */ }
        }
        try { fs.rmSync(temporary, { force: true }); } catch (_) { /* ignore cleanup failure */ }
        throw error;
    }
}

function cleanText(value, limit) {
    return String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, limit);
}

function cleanPath(value) {
    return cleanText(String(value || "").split(/[?#]/, 1)[0], 500);
}

function secretKey(key) {
    return /secret|password|token|credential|authorization|cookie|recovery.?code|access.?key|private.?key|client.?secret/i.test(String(key || ""));
}

function cleanObject(value, depth = 0) {
    if (depth > 4) return "[depth-limit]";
    if (value === null || value === undefined) return value;
    if (typeof value === "string") return cleanText(value, 1000);
    if (typeof value === "number" || typeof value === "boolean") return value;
    if (Array.isArray(value)) return value.slice(0, 50).map(item => cleanObject(item, depth + 1));
    if (typeof value === "object") {
        const result = {};
        for (const [rawKey, item] of Object.entries(value).slice(0, 50)) {
            const key = cleanText(rawKey, 100);
            result[key] = secretKey(key) ? "[redacted]" : cleanObject(item, depth + 1);
        }
        return result;
    }
    return cleanText(value, 200);
}

function deriveIntegrityKey(value) {
    const raw = String(value || "");
    if (!raw) return null;
    if (raw.length < 32) throw new Error("Audit integrity key must contain at least 32 characters.");
    return crypto.createHash("sha256").update("SIRK-AUDIT-v2\0", "utf8").update(raw, "utf8").digest();
}

function digest(record, algorithm, key) {
    const serialized = JSON.stringify(record);
    if (algorithm === "hmac-sha256") {
        if (!key) throw new Error("Audit HMAC key is unavailable.");
        return crypto.createHmac("sha256", key).update(serialized, "utf8").digest("base64url");
    }
    return crypto.createHash("sha256").update(serialized, "utf8").digest("base64url");
}

function verifyState(state, key) {
    if (!state || !Array.isArray(state.events)) return { ok: false, index: -1, reason: "invalid-state" };
    if (state.version !== 2) return { ok: false, index: -1, reason: "unsupported-schema" };
    const algorithm = String(state.algorithm || "");
    if (algorithm !== "hmac-sha256") return { ok: false, index: -1, reason: "unsupported-algorithm" };
    if (!key) return { ok: false, index: -1, reason: "integrity-key-unavailable" };
    let previousHash = String(state.anchorHash || "");
    for (let index = 0; index < state.events.length; index += 1) {
        const event = state.events[index];
        if (event.previousHash !== previousHash) return { ok: false, index, reason: "previous-hash-mismatch" };
        const copy = Object.assign({}, event);
        const expected = copy.hash;
        delete copy.hash;
        if (digest(copy, algorithm, key) !== expected) return { ok: false, index, reason: "event-hash-mismatch" };
        previousHash = expected;
    }
    return { ok: true, count: state.events.length, lastHash: previousHash, algorithm, anchorHash: String(state.anchorHash || "") };
}

function rechain(events, algorithm, key, anchorHash = "") {
    let previousHash = anchorHash;
    return events.map(source => {
        const record = Object.assign({}, source, { previousHash });
        delete record.hash;
        record.hash = digest(record, algorithm, key);
        previousHash = record.hash;
        return record;
    });
}

function create(options) {
    options = options || {};
    const dataDir = path.resolve(options.dataDir || path.join(process.cwd(), "data"));
    const filePath = path.join(dataDir, "audit-events.json");
    const now = typeof options.now === "function" ? options.now : Date.now;
    const maxEvents = Math.max(100, Math.min(100000, Number(options.maxEvents || 10000)));
    const configuredKey = options.integrityKey !== undefined ? options.integrityKey : process.env.SIRK_AUDIT_INTEGRITY_KEY || "";
    const integrityKey = deriveIntegrityKey(configuredKey);
    if (!integrityKey) throw new Error("SIRK_AUDIT_INTEGRITY_KEY is required.");
    const desiredAlgorithm = "hmac-sha256";
    let state = { version: 2, algorithm: desiredAlgorithm, anchorHash: "", events: [] };
    let integrityFailure = null;

    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
        const verification = verifyState(parsed, integrityKey);
        if (!verification.ok) {
            integrityFailure = verification;
            state = parsed;
        } else {
            state = parsed;
        }
    } catch (error) {
        if (error.code !== "ENOENT") throw error;
    }

    function persist() {
        atomicWrite(filePath, state);
    }

    function assertIntegrity() {
        const result = integrityFailure || verifyState(state, integrityKey);
        if (!result.ok) {
            throw Object.assign(new Error("Audit trail integrity verification failed."), {
                code: "AUDIT_INTEGRITY_FAILED",
                details: result
            });
        }
    }

    function append(event) {
        assertIntegrity();
        event = event || {};
        const previousHash = state.events.length ? state.events[state.events.length - 1].hash : String(state.anchorHash || "");
        const record = {
            id: crypto.randomUUID(),
            timestampUtc: new Date(now()).toISOString(),
            action: cleanText(event.action, 160) || "unknown",
            category: cleanText(event.category, 80) || "system",
            result: ["success", "failure", "denied", "info"].includes(event.result) ? event.result : "info",
            actor: {
                username: cleanText(event.actor && event.actor.username, 180),
                displayName: cleanText(event.actor && event.actor.displayName, 240),
                identityKey: cleanText(event.actor && event.actor.identityKey, 240),
                role: cleanText(event.actor && event.actor.role, 80),
                source: cleanText(event.actor && event.actor.source, 80)
            },
            request: {
                ip: cleanText(event.request && event.request.ip, 128),
                userAgent: cleanText(event.request && event.request.userAgent, 400),
                method: cleanText(event.request && event.request.method, 16),
                path: cleanPath(event.request && event.request.path)
            },
            target: cleanText(event.target, 300),
            details: cleanObject(event.details || {}),
            previousHash
        };
        record.hash = digest(record, state.algorithm, integrityKey);
        state.events.push(record);
        if (state.events.length > maxEvents) {
            const removeCount = state.events.length - maxEvents;
            const firstRetained = state.events[removeCount];
            state.anchorHash = firstRetained ? firstRetained.previousHash : record.hash;
            state.events = state.events.slice(removeCount);
        }
        persist();
        return JSON.parse(JSON.stringify(record));
    }

    function list(filters) {
        filters = filters || {};
        const limit = Math.max(1, Math.min(500, Number(filters.limit || 100)));
        const category = cleanText(filters.category, 80).toLowerCase();
        const result = cleanText(filters.result, 20).toLowerCase();
        const query = cleanText(filters.query, 200).toLowerCase();
        return state.events.slice().reverse().filter(event => {
            if (category && event.category.toLowerCase() !== category) return false;
            if (result && event.result.toLowerCase() !== result) return false;
            if (query) {
                const haystack = [event.action, event.category, event.target, event.actor.username, event.actor.displayName, JSON.stringify(event.details)].join(" ").toLowerCase();
                if (!haystack.includes(query)) return false;
            }
            return true;
        }).slice(0, limit).map(event => JSON.parse(JSON.stringify(event)));
    }

    function verify() {
        return integrityFailure || verifyState(state, integrityKey);
    }

    return { append, list, verify, filePath, algorithm: state.algorithm };
}

module.exports = { create, cleanObject, cleanPath, deriveIntegrityKey, verifyState };
