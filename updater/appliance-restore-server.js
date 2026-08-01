"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

require("./appliance-download-server");
const runtime = require("./server");
const archiveSecurity = require("./backup-archive");

const token = String(process.env.SIRK_UPDATER_TOKEN || "");
const stateDir = path.resolve(process.env.SIRK_UPDATER_STATE_DIR || "/var/lib/sirk-updater");
const backupDir = path.resolve(process.env.SIRK_BACKUP_DIR || path.join(stateDir, "backups"));
const encryptedNamePattern = /^sirk-central-\d{8}T\d{6}Z\.tar\.gz\.age$/;
let encryptedRestoreRunning = false;

function safeEqual(left, right) {
    const a = Buffer.from(String(left || ""));
    const b = Buffer.from(String(right || ""));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function authorized(req) {
    const match = String(req.headers.authorization || "").match(/^Bearer ([A-Za-z0-9_-]{43,512})$/);
    return Boolean(match && safeEqual(match[1], token));
}
function json(res, status, body) {
    const data = Buffer.from(JSON.stringify(body));
    res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": String(data.length),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
        "Referrer-Policy": "no-referrer"
    });
    res.end(data);
}
function readBody(req, limit = 32768) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        let settled = false;
        req.on("data", chunk => {
            if (settled) return;
            size += chunk.length;
            if (size > limit) {
                settled = true;
                reject(Object.assign(new Error("Request body is too large."), { statusCode: 413 }));
                req.resume();
            } else chunks.push(chunk);
        });
        req.on("end", () => {
            if (settled) return;
            try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
            catch (_) { reject(Object.assign(new Error("Invalid JSON body."), { statusCode: 400 })); }
        });
        req.on("error", error => { if (!settled) reject(error); });
    });
}
function encryptedBackup(name) {
    if (!encryptedNamePattern.test(String(name || ""))) throw Object.assign(new Error("Encrypted backup name is invalid."), { statusCode: 400 });
    const target = path.resolve(backupDir, name);
    if (path.dirname(target) !== backupDir) throw Object.assign(new Error("Encrypted backup path is invalid."), { statusCode: 400 });
    const stat = fs.statSync(target);
    if (!stat.isFile() || stat.size < 1) throw Object.assign(new Error("Encrypted backup was not found."), { statusCode: 404 });
    const metadata = JSON.parse(fs.readFileSync(target + ".json", "utf8"));
    if (!metadata || metadata.version !== 1 || metadata.encryption !== "age" || !/^[a-f0-9]{20}$/.test(String(metadata.recipientFingerprint || ""))) {
        throw Object.assign(new Error("Encrypted backup metadata is invalid."), { statusCode: 409 });
    }
    return { target, metadata };
}
function validateIdentity(identity) {
    const value = String(identity || "");
    if (!value || Buffer.byteLength(value, "utf8") > 16384 || value.includes("\0")) {
        throw Object.assign(new Error("Age identity is invalid."), { statusCode: 400 });
    }
    if (!/^AGE-SECRET-KEY-1[0-9A-Z]+$/m.test(value)) {
        throw Object.assign(new Error("Age identity does not contain a supported secret key."), { statusCode: 400 });
    }
    return value.endsWith("\n") ? value : value + "\n";
}
function run(name, args) {
    const result = spawnSync(name, args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
    if (result.status !== 0) throw new Error(String(result.stderr || result.stdout || result.error || name + " failed").trim());
    return String(result.stdout || "").trim();
}
function fingerprint(recipient) {
    return crypto.createHash("sha256").update(recipient).digest("hex").slice(0, 20);
}
function removePlainBackup(backup) {
    if (!backup || !backup.name) return;
    const target = path.resolve(backupDir, backup.name);
    if (path.dirname(target) !== backupDir) return;
    try { fs.rmSync(target, { force: true }); } catch (_) { /* cleanup only */ }
    try { fs.rmSync(target + ".sha256", { force: true }); } catch (_) { /* cleanup only */ }
}
function encryptSafetyBackup(backup, recipient, recipientFingerprint) {
    if (!backup || !backup.name) return null;
    const plaintext = path.resolve(backupDir, backup.name);
    if (path.dirname(plaintext) !== backupDir || !fs.existsSync(plaintext)) return null;
    const target = plaintext + ".age";
    const temporary = target + ".partial-" + crypto.randomBytes(6).toString("hex");
    try {
        run("age", ["--recipient", recipient, "--output", temporary, plaintext]);
        fs.chmodSync(temporary, 0o600);
        fs.renameSync(temporary, target);
        const checksum = archiveSecurity.sha256File(target);
        fs.writeFileSync(target + ".sha256", checksum + "  " + path.basename(target) + "\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
        fs.writeFileSync(target + ".json", JSON.stringify({
            version: 1,
            name: path.basename(target),
            encrypted: true,
            encryption: "age",
            recipientFingerprint,
            checksum,
            size: fs.statSync(target).size,
            createdAtUtc: new Date().toISOString(),
            safetyBackup: true
        }, null, 2) + "\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
        return path.basename(target);
    } finally {
        try { fs.rmSync(temporary, { force: true }); } catch (_) { /* cleanup only */ }
        removePlainBackup(backup);
    }
}
function performEncryptedRestore(name, identityText) {
    const encrypted = encryptedBackup(name);
    const nonce = process.pid + "-" + crypto.randomBytes(8).toString("hex");
    const identityPath = path.join(stateDir, ".restore-identity-" + nonce + ".agekey");
    const plaintext = path.join(stateDir, ".restore-archive-" + nonce + ".tar.gz");
    let safetyBackup = null;
    let recipient = "";
    try {
        fs.writeFileSync(identityPath, validateIdentity(identityText), { encoding: "utf8", mode: 0o600, flag: "wx" });
        recipient = run("age-keygen", ["-y", identityPath]);
        if (!/^age1[0-9a-z]{58}$/.test(recipient)) throw Object.assign(new Error("Age identity public recipient is invalid."), { statusCode: 400 });
        if (!safeEqual(fingerprint(recipient), encrypted.metadata.recipientFingerprint)) {
            throw Object.assign(new Error("The selected age identity does not match this backup."), { statusCode: 400 });
        }
        run("age", ["--decrypt", "--identity", identityPath, "--output", plaintext, encrypted.target]);
        fs.chmodSync(plaintext, 0o600);
        archiveSecurity.writeChecksum(plaintext);
        archiveSecurity.validateArchive(plaintext, { requireChecksum: true });
        safetyBackup = runtime.createBackup();
        const result = runtime.performRestore(name, plaintext, safetyBackup);
        const encryptedSafetyBackup = encryptSafetyBackup(safetyBackup, recipient, encrypted.metadata.recipientFingerprint);
        return Object.assign({}, result, { encryptedSafetyBackup });
    } finally {
        try { fs.rmSync(identityPath, { force: true }); } catch (_) { /* cleanup only */ }
        try { fs.rmSync(plaintext, { force: true }); } catch (_) { /* cleanup only */ }
        try { fs.rmSync(plaintext + ".sha256", { force: true }); } catch (_) { /* cleanup only */ }
        if (safetyBackup && fs.existsSync(path.join(backupDir, safetyBackup.name))) {
            try { encryptSafetyBackup(safetyBackup, recipient, encrypted.metadata.recipientFingerprint); } catch (_) { /* preserve cleanup attempt */ }
        }
        encryptedRestoreRunning = false;
    }
}

const originalListeners = runtime.server.listeners("request");
runtime.server.removeAllListeners("request");
runtime.server.on("request", async (req, res) => {
    try {
        const url = new URL(req.url, "http://updater.local");
        if (req.method === "POST" && url.pathname === "/backup/encrypted/restore") {
            if (!authorized(req)) return json(res, 404, { ok: false, error: "Not found." });
            if (encryptedRestoreRunning || runtime.operationRunning()) return json(res, 409, { ok: false, error: "An update or restore operation is already running." });
            const body = await readBody(req);
            if (body.confirm !== "RESTORE SIRK CENTRAL") return json(res, 400, { ok: false, error: "Restore confirmation is invalid." });
            const name = String(body.name || "");
            const identity = validateIdentity(body.identity);
            encryptedBackup(name);
            encryptedRestoreRunning = true;
            setTimeout(() => {
                try { performEncryptedRestore(name, identity); }
                catch (error) {
                    encryptedRestoreRunning = false;
                    process.stderr.write("[encrypted-restore] " + String(error.stack || error) + "\n");
                }
            }, 250).unref();
            return json(res, 202, { ok: true, accepted: true, backup: name });
        }
        if (encryptedRestoreRunning && req.method === "POST" && url.pathname === "/backup/run") {
            return json(res, 409, { ok: false, error: "A backup cannot start while encrypted restore is running." });
        }
        for (const listener of originalListeners) {
            const result = listener.call(runtime.server, req, res);
            if (result && typeof result.then === "function") await result;
            if (res.writableEnded || res.headersSent) return;
        }
    } catch (error) {
        if (!res.headersSent) return json(res, Number.isInteger(error.statusCode) ? error.statusCode : 500, {
            ok: false,
            error: Number.isInteger(error.statusCode) && error.statusCode < 500 ? error.message : "Internal encrypted restore error."
        });
        res.destroy(error);
    }
});

if (require.main === module) {
    const host = process.env.SIRK_UPDATER_BIND_HOST || "0.0.0.0";
    const port = Number(process.env.SIRK_UPDATER_PORT || 8090);
    runtime.server.listen(port, host, () => process.stdout.write(`SIRK appliance worker with encrypted restore listening on ${host}:${port}\n`));
}

module.exports = { validateIdentity, encryptedBackup, performEncryptedRestore, fingerprint };
