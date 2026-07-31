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

function hash(value) {
    return crypto.createHash("sha256").update(String(value), "utf8").digest("base64url");
}

function actorKey(actor) {
    const value = String(actor && (actor.identityKey || actor.username) || "").trim();
    if (!value || value.length > 180) throw new Error("Challenge owner is invalid.");
    return value;
}

function create(options) {
    options = options || {};
    const dataDir = path.resolve(options.dataDir || path.join(process.cwd(), "data"));
    const filePath = path.join(dataDir, "webauthn-challenges.json");
    const now = typeof options.now === "function" ? options.now : Date.now;
    const ttlMs = Math.max(30_000, Math.min(10 * 60_000, Number(options.ttlMs || 120_000)));
    let state = { version: 1, challenges: {} };

    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
        if (parsed && parsed.version === 1 && parsed.challenges) state = parsed;
    } catch (error) {
        if (error.code !== "ENOENT") throw error;
    }

    function persist() { atomicWrite(filePath, state); }

    function cleanup(write = true) {
        const timestamp = now();
        let changed = false;
        for (const [id, item] of Object.entries(state.challenges)) {
            if (item.expiresAt <= timestamp || item.usedAt) {
                delete state.challenges[id];
                changed = true;
            }
        }
        if (changed && write) persist();
        return changed;
    }

    function issue(kind, actor, context) {
        if (!['registration', 'authentication'].includes(kind)) throw new Error("Unsupported challenge kind.");
        cleanup(false);
        const owner = actorKey(actor);
        for (const [id, item] of Object.entries(state.challenges)) {
            if (item.owner === owner && item.kind === kind) delete state.challenges[id];
        }
        const raw = crypto.randomBytes(32).toString("base64url");
        const id = crypto.randomBytes(12).toString("base64url");
        const timestamp = now();
        state.challenges[id] = {
            id,
            kind,
            owner,
            challengeHash: hash(raw),
            context: context && typeof context === "object" ? JSON.parse(JSON.stringify(context)) : {},
            createdAt: timestamp,
            expiresAt: timestamp + ttlMs,
            attempts: 0
        };
        persist();
        return { id, challenge: raw, expiresAtUtc: new Date(timestamp + ttlMs).toISOString() };
    }

    function consume(idValue, challenge, kind, actor) {
        cleanup();
        const id = String(idValue || "");
        const item = state.challenges[id];
        if (!item) throw new Error("Challenge not found or expired.");
        if (item.kind !== kind) throw new Error("Challenge kind mismatch.");
        if (item.owner !== actorKey(actor)) throw new Error("Challenge owner mismatch.");
        item.attempts += 1;
        if (item.attempts > 5) {
            delete state.challenges[id];
            persist();
            throw new Error("Challenge attempt limit exceeded.");
        }
        const supplied = Buffer.from(hash(challenge));
        const expected = Buffer.from(item.challengeHash);
        if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
            persist();
            throw new Error("Challenge verification failed.");
        }
        delete state.challenges[id];
        persist();
        return JSON.parse(JSON.stringify(item.context || {}));
    }

    cleanup();
    return { issue, consume, cleanup, filePath };
}

module.exports = { create, hash };
