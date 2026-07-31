"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function atomicJson(filePath, value) {
    const temporary = filePath + ".tmp-" + process.pid + "-" + crypto.randomBytes(5).toString("hex");
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, filePath);
}
function readJson(filePath) {
    try { return JSON.parse(fs.readFileSync(filePath, "utf8")); }
    catch (error) {
        if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
        throw error;
    }
}
function lockError(message, owner) {
    return Object.assign(new Error(message), {
        code: "RUNTIME_STORAGE_LOCKED",
        statusCode: 503,
        owner: owner || null
    });
}
function lockTimestamp(lockDir, owner) {
    const heartbeat = owner && Date.parse(owner.heartbeatAtUtc || owner.startedAtUtc || "");
    if (Number.isFinite(heartbeat)) return heartbeat;
    try { return fs.statSync(lockDir).mtimeMs; }
    catch (error) {
        if (error.code === "ENOENT") return NaN;
        throw error;
    }
}

function acquire(options = {}) {
    const dataDir = path.resolve(options.dataDir || path.join(process.cwd(), "data"));
    const now = typeof options.now === "function" ? options.now : Date.now;
    const staleMs = Math.max(30000, Math.min(3600000, Number(options.staleMs || 120000)));
    const heartbeatMs = Math.max(5000, Math.min(Math.floor(staleMs / 3), Number(options.heartbeatMs || 30000)));
    const lockDir = path.join(dataDir, ".sirk-central-runtime.lock");
    const ownerPath = path.join(lockDir, "owner.json");
    const instanceId = String(options.instanceId || crypto.randomBytes(18).toString("base64url"));
    let released = false;
    let timer = null;

    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });

    function ownerRecord(startedAt) {
        const timestamp = now();
        return {
            schema: 1,
            instanceId,
            pid: process.pid,
            hostname: os.hostname().slice(0, 255),
            startedAtUtc: new Date(startedAt).toISOString(),
            heartbeatAtUtc: new Date(timestamp).toISOString()
        };
    }

    function createLock() {
        fs.mkdirSync(lockDir, { mode: 0o700 });
        const startedAt = now();
        atomicJson(ownerPath, ownerRecord(startedAt));
        return startedAt;
    }

    let startedAt;
    try {
        startedAt = createLock();
    } catch (error) {
        if (error.code !== "EEXIST") throw error;
        const current = readJson(ownerPath);
        const timestamp = lockTimestamp(lockDir, current);
        if (!Number.isFinite(timestamp) || now() - timestamp <= staleMs) {
            throw lockError("Persistent storage is already owned by another SIRK Central runtime.", current);
        }

        const quarantine = lockDir + ".stale-" + now() + "-" + crypto.randomBytes(4).toString("hex");
        try { fs.renameSync(lockDir, quarantine); }
        catch (renameError) {
            if (renameError.code === "ENOENT" || renameError.code === "EEXIST") {
                throw lockError("Persistent storage lock changed while stale recovery was attempted.", readJson(ownerPath));
            }
            throw renameError;
        }
        try {
            startedAt = createLock();
        } catch (createError) {
            throw lockError("Persistent storage was claimed by another runtime during stale recovery.", readJson(ownerPath));
        } finally {
            try { fs.rmSync(quarantine, { recursive: true, force: true }); } catch (_) { /* best effort */ }
        }
    }

    function heartbeat() {
        if (released) return;
        const current = readJson(ownerPath);
        if (!current || current.instanceId !== instanceId) {
            released = true;
            if (timer) clearInterval(timer);
            return;
        }
        atomicJson(ownerPath, ownerRecord(startedAt));
    }

    function release() {
        if (released) return false;
        released = true;
        if (timer) clearInterval(timer);
        const current = readJson(ownerPath);
        if (!current || current.instanceId !== instanceId) return false;
        fs.rmSync(lockDir, { recursive: true, force: true });
        return true;
    }

    timer = setInterval(() => {
        try { heartbeat(); }
        catch (error) { process.stderr.write("[runtime-lock] " + String(error.stack || error) + "\n"); }
    }, heartbeatMs);
    timer.unref();

    return {
        instanceId,
        lockDir,
        ownerPath,
        staleMs,
        heartbeatMs,
        heartbeat,
        release,
        snapshot: () => readJson(ownerPath)
    };
}

module.exports = { acquire, readJson, lockError, lockTimestamp };
