"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function clone(value) { return JSON.parse(JSON.stringify(value)); }

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

function create(options = {}) {
    const dataDir = path.resolve(options.dataDir || path.join(process.cwd(), "data"));
    const filePath = path.join(dataDir, "sso-replay.json");
    const now = typeof options.now === "function" ? options.now : Date.now;
    const maxEntries = Math.max(100, Math.min(100000, Number(options.maxEntries || 10000)));
    let state = { version: 1, tickets: {} };

    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
        if (!parsed || parsed.version !== 1 || !parsed.tickets || typeof parsed.tickets !== "object") throw new Error("SSO replay store has an unsupported schema.");
        state = parsed;
    } catch (error) {
        if (error.code !== "ENOENT") throw error;
    }

    function cleanup(write = true) {
        const timestamp = now();
        let changed = false;
        for (const [jti, expiresAt] of Object.entries(state.tickets)) {
            if (!Number.isFinite(Number(expiresAt)) || Number(expiresAt) <= timestamp) {
                delete state.tickets[jti];
                changed = true;
            }
        }
        if (changed && write) atomicWrite(filePath, state);
        return changed;
    }

    function consume(jti, expiresAt) {
        const id = String(jti || "");
        const expiry = Number(expiresAt);
        const timestamp = now();
        if (!/^[A-Za-z0-9_-]{16,128}$/.test(id)) throw new Error("SSO ticket JTI is invalid.");
        if (!Number.isFinite(expiry) || expiry <= timestamp || expiry > timestamp + 5 * 60_000) {
            throw new Error("SSO ticket expiry is invalid.");
        }
        cleanup(false);
        if (state.tickets[id] && Number(state.tickets[id]) > timestamp) return false;
        if (Object.keys(state.tickets).length >= maxEntries) {
            throw Object.assign(new Error("SSO replay store capacity was exceeded."), { statusCode: 503, code: "SSO_REPLAY_STORE_FULL" });
        }
        state.tickets[id] = expiry;
        atomicWrite(filePath, state);
        return true;
    }

    function list() {
        cleanup();
        return clone(state.tickets);
    }

    cleanup(false);
    return { consume, cleanup, list, filePath };
}

module.exports = { create };
