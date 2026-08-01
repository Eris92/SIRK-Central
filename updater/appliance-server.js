"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const runtime = require("./server");

const token = String(process.env.SIRK_UPDATER_TOKEN || "");
const installDir = path.resolve(process.env.SIRK_INSTALL_DIR || "/opt/sirk-central");
const stateDir = path.resolve(process.env.SIRK_UPDATER_STATE_DIR || "/var/lib/sirk-updater");
const dataDir = path.resolve(process.env.SIRK_BACKUP_SOURCE_DIR || "/var/lib/sirk-central");
const backupDir = path.resolve(process.env.SIRK_BACKUP_DIR || path.join(stateDir, "backups"));
const recipientPath = path.join(dataDir, "backup-age-recipient.json");
const recipientPattern = /^age1[0-9a-z]{58}$/;
const encryptedNamePattern = /^sirk-central-\d{8}T\d{6}Z\.tar\.gz\.age$/;
const legacyNamePattern = /^sirk-central-\d{8}T\d{6}(?:Z|[+-]\d{4})\.tar\.gz$/;

function safeEqual(left, right) {
    const a = Buffer.from(String(left || ""));
    const b = Buffer.from(String(right || ""));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function authorized(req) {
    const match = String(req.headers.authorization || "").match(/^Bearer ([A-Za-z0-9_-]{43,512})$/);
    return Boolean(match && safeEqual(match[1], token));
}
function responseHeaders(contentType) {
    return {
        "Content-Type": contentType || "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
        "Referrer-Policy": "no-referrer"
    };
}
function json(res, status, body) {
    const data = Buffer.from(JSON.stringify(body));
    res.writeHead(status, Object.assign(responseHeaders(), { "Content-Length": String(data.length) }));
    res.end(data);
}
function command(name, args, cwd = installDir) {
    const result = spawnSync(name, args, { cwd, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
    if (result.status !== 0) throw new Error(String(result.stderr || result.stdout || result.error || name + " failed").trim());
    return String(result.stdout || "").trim();
}
function readJson(filePath, fallback) {
    try { return JSON.parse(fs.readFileSync(filePath, "utf8")); }
    catch (error) { if (error.code === "ENOENT") return fallback; throw error; }
}
function atomicJson(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const temporary = filePath + ".tmp-" + process.pid + "-" + crypto.randomBytes(6).toString("hex");
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, filePath);
    fs.chmodSync(filePath, 0o600);
}
function sha256File(filePath) {
    const hash = crypto.createHash("sha256");
    const descriptor = fs.openSync(filePath, "r");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    try {
        for (;;) {
            const read = fs.readSync(descriptor, buffer, 0, buffer.length, null);
            if (!read) break;
            hash.update(buffer.subarray(0, read));
        }
    } finally { fs.closeSync(descriptor); }
    return hash.digest("hex");
}
function readBody(req, limit = 8192) {
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
function storage(target) {
    const stat = fs.statfsSync(target);
    const total = Number(stat.blocks) * Number(stat.bsize);
    const free = Number(stat.bavail) * Number(stat.bsize);
    return { totalBytes: total, freeBytes: free, usedBytes: Math.max(0, total - free) };
}
function containers() {
    const output = command("docker", ["compose", "-f", "docker-compose.yml", "-f", "docker-compose.appliance.yml", "--profile", "auth", "ps", "--format", "json"]);
    if (!output) return [];
    let parsed;
    try { parsed = JSON.parse(output); }
    catch (_) { parsed = output.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)); }
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows.map(item => ({
        service: String(item.Service || item.service || ""),
        name: String(item.Name || item.name || ""),
        state: String(item.State || item.state || ""),
        health: String(item.Health || item.health || ""),
        image: String(item.Image || item.image || "")
    })).filter(item => item.service);
}
function status() {
    let commit = "";
    try { commit = command("git", ["rev-parse", "HEAD"]); } catch (_) { /* unavailable */ }
    return {
        ok: true,
        generatedAtUtc: new Date().toISOString(),
        commit,
        installDir,
        storage: {
            data: storage(dataDir),
            install: storage(installDir)
        },
        containers: containers(),
        update: readJson(path.join(stateDir, "status.json"), { state: "idle", running: false }),
        restore: readJson(path.join(stateDir, "restore-status.json"), { state: "idle", running: false })
    };
}
function backupRecipient() {
    const value = readJson(recipientPath, null);
    if (!value || value.version !== 1 || !recipientPattern.test(String(value.recipient || ""))) {
        throw Object.assign(new Error("Encrypted backup recipient is not configured. Generate and download an age key from the Break-Glass panel first."), {
            statusCode: 409,
            code: "BACKUP_AGE_RECIPIENT_REQUIRED"
        });
    }
    return {
        recipient: value.recipient,
        fingerprint: crypto.createHash("sha256").update(value.recipient).digest("hex").slice(0, 20),
        updatedAtUtc: String(value.updatedAtUtc || "")
    };
}
function utcTimestamp(date = new Date()) {
    return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}
function allocateEncryptedTarget() {
    fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    const base = Date.now();
    for (let offset = 0; offset < 10; offset += 1) {
        const name = "sirk-central-" + utcTimestamp(new Date(base + offset * 1000)) + ".tar.gz.age";
        const target = path.join(backupDir, name);
        if (!fs.existsSync(target)) return { name, target };
    }
    throw new Error("Unable to allocate a unique encrypted backup name.");
}
function createEncryptedBackup() {
    if (runtime.operationRunning()) throw Object.assign(new Error("A backup cannot start while an update or restore is running."), { statusCode: 409 });
    if (!fs.existsSync(dataDir) || !fs.statSync(dataDir).isDirectory()) throw new Error("Persistent data directory is unavailable.");
    const key = backupRecipient();
    const allocated = allocateEncryptedTarget();
    const nonce = process.pid + "-" + crypto.randomBytes(8).toString("hex");
    const plaintext = path.join(backupDir, ".partial-" + nonce + ".tar.gz");
    const encrypted = path.join(backupDir, ".partial-" + nonce + ".tar.gz.age");
    try {
        const archive = spawnSync("tar", ["-czf", plaintext, "-C", dataDir, "."], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
        if (archive.status !== 0) throw new Error("Backup archive creation failed: " + String(archive.stderr || archive.error || archive.status));
        fs.chmodSync(plaintext, 0o600);
        const encryption = spawnSync("age", ["--recipient", key.recipient, "--output", encrypted, plaintext], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
        if (encryption.status !== 0) throw new Error("Backup encryption failed: " + String(encryption.stderr || encryption.error || encryption.status));
        fs.chmodSync(encrypted, 0o600);
        fs.renameSync(encrypted, allocated.target);
        const checksum = sha256File(allocated.target);
        fs.writeFileSync(allocated.target + ".sha256", checksum + "  " + allocated.name + "\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
        const stat = fs.statSync(allocated.target);
        const metadata = {
            version: 1,
            name: allocated.name,
            encrypted: true,
            encryption: "age",
            recipientFingerprint: key.fingerprint,
            recipientUpdatedAtUtc: key.updatedAtUtc,
            checksum,
            size: stat.size,
            createdAtUtc: stat.mtime.toISOString()
        };
        atomicJson(allocated.target + ".json", metadata);
        return metadata;
    } catch (error) {
        for (const candidate of [encrypted, allocated.target, allocated.target + ".sha256", allocated.target + ".json"]) {
            try { fs.rmSync(candidate, { force: true }); } catch (_) { /* cleanup only */ }
        }
        throw error;
    } finally {
        try { fs.rmSync(plaintext, { force: true }); } catch (_) { /* cleanup only */ }
    }
}
function listBackups() {
    fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    return fs.readdirSync(backupDir, { withFileTypes: true })
        .filter(entry => entry.isFile() && (encryptedNamePattern.test(entry.name) || legacyNamePattern.test(entry.name)))
        .map(entry => {
            const target = path.join(backupDir, entry.name);
            const stat = fs.statSync(target);
            if (encryptedNamePattern.test(entry.name)) {
                const metadata = readJson(target + ".json", {});
                return {
                    name: entry.name,
                    size: stat.size,
                    createdAtUtc: String(metadata.createdAtUtc || stat.mtime.toISOString()),
                    checksum: String(metadata.checksum || "") || null,
                    encrypted: true,
                    encryption: "age",
                    recipientFingerprint: String(metadata.recipientFingerprint || ""),
                    restorable: false
                };
            }
            return {
                name: entry.name,
                size: stat.size,
                createdAtUtc: stat.mtime.toISOString(),
                checksum: null,
                encrypted: false,
                legacy: true,
                restorable: true
            };
        })
        .sort((left, right) => right.createdAtUtc.localeCompare(left.createdAtUtc));
}

const originalListeners = runtime.server.listeners("request");
runtime.server.removeAllListeners("request");
runtime.server.on("request", async (req, res) => {
    try {
        const url = new URL(req.url, "http://updater.local");
        if (req.method === "GET" && url.pathname === "/appliance/status") {
            if (!authorized(req)) return json(res, 404, { ok: false, error: "Not found." });
            return json(res, 200, status());
        }
        if (req.method === "GET" && url.pathname === "/backup/status") {
            if (!authorized(req)) return json(res, 404, { ok: false, error: "Not found." });
            return json(res, 200, {
                ok: true,
                backups: listBackups(),
                restore: readJson(path.join(stateDir, "restore-status.json"), { state: "idle", running: false }),
                operationRunning: runtime.operationRunning(),
                encryptionRequired: true,
                recipientConfigured: (() => { try { backupRecipient(); return true; } catch (_) { return false; } })()
            });
        }
        if (req.method === "POST" && url.pathname === "/backup/run") {
            if (!authorized(req)) return json(res, 404, { ok: false, error: "Not found." });
            const body = await readBody(req);
            if (body.confirm !== "BACKUP SIRK CENTRAL") return json(res, 400, { ok: false, error: "Backup confirmation is invalid." });
            return json(res, 201, { ok: true, backup: createEncryptedBackup() });
        }
        for (const listener of originalListeners) {
            const result = listener.call(runtime.server, req, res);
            if (result && typeof result.then === "function") await result;
            if (res.writableEnded || res.headersSent) return;
        }
    } catch (error) {
        const statusCode = Number.isInteger(error.statusCode) ? error.statusCode : 500;
        if (!res.headersSent) return json(res, statusCode, {
            ok: false,
            code: error.code || "APPLIANCE_OPERATION_FAILED",
            error: statusCode >= 500 ? "Internal appliance operation error." : String(error.message || error)
        });
        res.destroy(error);
    }
});

if (require.main === module) {
    const host = process.env.SIRK_UPDATER_BIND_HOST || "0.0.0.0";
    const port = Number(process.env.SIRK_UPDATER_PORT || 8090);
    runtime.server.listen(port, host, () => process.stdout.write(`SIRK appliance worker listening on ${host}:${port}\n`));
}

module.exports = { status, containers, storage, backupRecipient, createEncryptedBackup, listBackups };
