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

function cleanText(value, limit) {
    return String(value || "").replace(/[\r\n\t]+/g, " ").trim().slice(0, limit);
}

function cleanObject(value, depth = 0) {
    if (depth > 4) return "[depth-limit]";
    if (value === null || value === undefined) return value;
    if (typeof value === "string") return cleanText(value, 1000);
    if (typeof value === "number" || typeof value === "boolean") return value;
    if (Array.isArray(value)) return value.slice(0, 50).map(item => cleanObject(item, depth + 1));
    if (typeof value === "object") {
        const result = {};
        for (const [key, item] of Object.entries(value).slice(0, 50)) {
            if (/secret|password|token|code|credential|authorization/i.test(key)) result[key] = "[redacted]";
            else result[cleanText(key, 100)] = cleanObject(item, depth + 1);
        }
        return result;
    }
    return cleanText(value, 200);
}

function digest(record) {
    return crypto.createHash("sha256").update(JSON.stringify(record), "utf8").digest("base64url");
}

function create(options) {
    options = options || {};
    const dataDir = path.resolve(options.dataDir || path.join(process.cwd(), "data"));
    const filePath = path.join(dataDir, "audit-events.json");
    const now = typeof options.now === "function" ? options.now : Date.now;
    const maxEvents = Math.max(100, Math.min(100000, Number(options.maxEvents || 10000)));
    let state = { version: 1, events: [] };

    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
        if (parsed && parsed.version === 1 && Array.isArray(parsed.events)) state = parsed;
    } catch (error) {
        if (error.code !== "ENOENT") throw error;
    }

    function persist() { atomicWrite(filePath, state); }

    function append(event) {
        event = event || {};
        const previousHash = state.events.length ? state.events[state.events.length - 1].hash : "";
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
                path: cleanText(event.request && event.request.path, 500)
            },
            target: cleanText(event.target, 300),
            details: cleanObject(event.details || {}),
            previousHash
        };
        record.hash = digest(record);
        state.events.push(record);
        if (state.events.length > maxEvents) state.events = state.events.slice(-maxEvents);
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
        let previousHash = "";
        for (let index = 0; index < state.events.length; index += 1) {
            const event = state.events[index];
            if (event.previousHash !== previousHash) return { ok: false, index, reason: "previous-hash-mismatch" };
            const copy = Object.assign({}, event);
            const expected = copy.hash;
            delete copy.hash;
            if (digest(copy) !== expected) return { ok: false, index, reason: "event-hash-mismatch" };
            previousHash = expected;
        }
        return { ok: true, count: state.events.length, lastHash: previousHash };
    }

    return { append, list, verify, filePath };
}

module.exports = { create };
