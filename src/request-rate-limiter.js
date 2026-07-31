"use strict";

function finiteInteger(value, fallback, minimum, maximum) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.max(minimum, Math.min(maximum, Math.floor(number)));
}

function create(options = {}) {
    const now = typeof options.now === "function" ? options.now : Date.now;
    const limit = finiteInteger(options.limit, 60, 1, 100000);
    const windowMs = finiteInteger(options.windowMs, 60000, 1000, 86400000);
    const maxEntries = finiteInteger(options.maxEntries, 10000, 100, 1000000);
    const entries = new Map();

    function prune(timestamp = now(), reserve = 0) {
        for (const [key, value] of entries) {
            if (value.resetAt <= timestamp) entries.delete(key);
        }
        const target = Math.max(0, maxEntries - finiteInteger(reserve, 0, 0, maxEntries));
        if (entries.size <= target) return;
        const ordered = [...entries.entries()].sort((left, right) => {
            const resetDifference = left[1].resetAt - right[1].resetAt;
            return resetDifference || left[1].lastSeenAt - right[1].lastSeenAt;
        });
        for (const [key] of ordered.slice(0, entries.size - target)) entries.delete(key);
    }

    function consume(rawKey, cost = 1) {
        const timestamp = now();
        const key = String(rawKey || "unknown").slice(0, 512);
        const requestCost = finiteInteger(cost, 1, 1, limit);
        const exists = entries.has(key);
        if (!exists && entries.size >= maxEntries) prune(timestamp, 1);
        let entry = entries.get(key);
        if (!entry || entry.resetAt <= timestamp) {
            entry = { used: 0, resetAt: timestamp + windowMs, lastSeenAt: timestamp };
        }
        const allowed = entry.used + requestCost <= limit;
        if (allowed) entry.used += requestCost;
        entry.lastSeenAt = timestamp;
        entries.set(key, entry);
        if (entries.size > maxEntries) prune(timestamp);
        return {
            allowed,
            limit,
            remaining: Math.max(0, limit - entry.used),
            resetAt: entry.resetAt,
            retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil((entry.resetAt - timestamp) / 1000))
        };
    }

    function reset(rawKey) {
        return entries.delete(String(rawKey || "unknown").slice(0, 512));
    }

    return { consume, reset, prune, size: () => entries.size, limit, windowMs, maxEntries };
}

module.exports = { create, finiteInteger };
