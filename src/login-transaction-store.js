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

function digest(value) {
    return crypto.createHash("sha256").update(String(value || ""), "utf8").digest("base64url");
}

function safeEqual(left, right) {
    const a = Buffer.from(String(left || ""));
    const b = Buffer.from(String(right || ""));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function create(options = {}) {
    const dataDir = path.resolve(options.dataDir || path.join(process.cwd(), "data"));
    const filePath = path.join(dataDir, "login-transactions.json");
    const now = typeof options.now === "function" ? options.now : Date.now;
    const lifetimeMs = Math.max(60_000, Math.min(15 * 60_000, Number(options.lifetimeMs || 5 * 60_000)));
    const maxAttempts = Math.max(1, Math.min(10, Number(options.maxAttempts || 5)));
    let state = { version: 1, transactions: {} };

    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
        if (parsed && parsed.version === 1 && parsed.transactions) state = parsed;
    } catch (error) {
        if (error.code !== "ENOENT") throw error;
    }

    function persist() { atomicWrite(filePath, state); }

    function cleanup() {
        const timestamp = now();
        let changed = false;
        for (const [id, item] of Object.entries(state.transactions)) {
            if (!item || item.expiresAt <= timestamp || item.usedAt || item.attempts >= maxAttempts) {
                delete state.transactions[id];
                changed = true;
            }
        }
        if (changed) persist();
    }

    function issue(identity, context = {}) {
        cleanup();
        const token = crypto.randomBytes(32).toString("base64url");
        const id = crypto.randomBytes(16).toString("base64url");
        const timestamp = now();
        state.transactions[id] = {
            id,
            tokenHash: digest(token),
            identity: JSON.parse(JSON.stringify(identity)),
            ipHash: digest(context.ip || ""),
            userAgentHash: digest(context.userAgent || ""),
            createdAt: timestamp,
            expiresAt: timestamp + lifetimeMs,
            attempts: 0,
            usedAt: null
        };
        persist();
        return { token: id + "." + token, expiresAtUtc: new Date(timestamp + lifetimeMs).toISOString() };
    }

    function resolve(value, context = {}, consumeTransaction = false) {
        cleanup();
        const match = String(value || "").match(/^([A-Za-z0-9_-]{16,64})\.([A-Za-z0-9_-]{32,128})$/);
        if (!match) return null;
        const item = state.transactions[match[1]];
        if (!item) return null;
        const valid = safeEqual(item.tokenHash, digest(match[2])) &&
            safeEqual(item.ipHash, digest(context.ip || "")) &&
            safeEqual(item.userAgentHash, digest(context.userAgent || "")) &&
            !item.usedAt && item.expiresAt > now() && item.attempts < maxAttempts;
        if (!valid) return null;
        const identity = JSON.parse(JSON.stringify(item.identity));
        if (consumeTransaction) {
            item.attempts += 1;
            item.usedAt = now();
            delete state.transactions[match[1]];
            persist();
        }
        return identity;
    }

    function inspect(value, context = {}) {
        return resolve(value, context, false);
    }

    function consume(value, context = {}) {
        const identity = resolve(value, context, true);
        if (identity) return identity;
        const id = String(value || "").split(".")[0];
        const item = state.transactions[id];
        if (item) {
            item.attempts += 1;
            if (item.attempts >= maxAttempts) delete state.transactions[id];
            persist();
        }
        return null;
    }

    function cancel(value) {
        const id = String(value || "").split(".")[0];
        if (!state.transactions[id]) return false;
        delete state.transactions[id];
        persist();
        return true;
    }

    cleanup();
    return { issue, inspect, consume, cancel, cleanup, filePath };
}

module.exports = { create, digest };
