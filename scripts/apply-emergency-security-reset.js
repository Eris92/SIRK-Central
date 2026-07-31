"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const sessionStoreFactory = require("../src/session-store");

function atomicJson(filePath, value) {
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
            try { fs.closeSync(descriptor); } catch (_) { /* cleanup */ }
        }
        try { fs.rmSync(temporary, { force: true }); } catch (_) { /* cleanup */ }
        throw error;
    }
}
function readUsers(filePath) {
    try {
        const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
        if (!value || value.schema !== 2 || !Array.isArray(value.users) || !value.security || typeof value.security !== "object") {
            throw new Error("users.json has an unsupported format.");
        }
        return value;
    } catch (error) {
        if (error.code === "ENOENT") return { schema: 2, users: [], security: {} };
        throw error;
    }
}
function validateHash(value, prefix, name) {
    const text = String(value || "");
    if (!text.startsWith(prefix) || text.length > 4096 || /[\r\n\0]/.test(text)) {
        throw new Error(name + " is invalid.");
    }
    return text;
}

function run(options = {}) {
    const dataDir = path.resolve(options.dataDir || process.env.SIRK_DATA_DIR || "/var/lib/sirk-central");
    const passwordHash = options.passwordHash || process.env.SIRK_EMERGENCY_PASSWORD_HASH || "";
    const accessKeyHash = options.accessKeyHash || process.env.SIRK_EMERGENCY_ACCESS_KEY_HASH || "";
    if (!passwordHash && !accessKeyHash) throw new Error("No emergency security value was supplied.");

    const usersPath = path.join(dataDir, "users.json");
    const users = readUsers(usersPath);
    const changed = [];
    if (passwordHash) {
        users.security.breakGlassPasswordHash = validateHash(passwordHash, "scrypt$", "BreakGlass password hash");
        changed.push("password");
    }
    if (accessKeyHash) {
        users.security.accessKeyHash = validateHash(accessKeyHash, "sha256$", "Access key hash");
        changed.push("access-key");
    }
    users.security.emergencyResetAtUtc = new Date().toISOString();
    atomicJson(usersPath, users);

    const sessions = sessionStoreFactory.create({ dataDir });
    const revokedSessions = sessions.revokeWhere(record => record && (record.builtIn === true || record.source === "local"));
    return { ok: true, changed, revokedSessions, dataDir };
}

if (require.main === module) {
    try {
        const result = run();
        process.stdout.write(JSON.stringify(result) + "\n");
    } catch (error) {
        process.stderr.write(String(error.stack || error) + "\n");
        process.exit(1);
    }
}

module.exports = { run, atomicJson, readUsers, validateHash };
