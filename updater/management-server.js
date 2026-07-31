"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const archiveSecurity = require("./backup-archive");

const bindHost = process.env.SIRK_BACKUP_MANAGER_BIND_HOST || "0.0.0.0";
const port = Number(process.env.SIRK_BACKUP_MANAGER_PORT || 8091);
const token = String(process.env.SIRK_UPDATER_TOKEN || "");
const stateDir = path.resolve(process.env.SIRK_UPDATER_STATE_DIR || "/var/lib/sirk-updater");
const dataDir = path.resolve(process.env.SIRK_BACKUP_SOURCE_DIR || "/var/lib/sirk-central");
const backupDir = path.resolve(process.env.SIRK_BACKUP_DIR || path.join(stateDir, "backups"));
const timeZone = process.env.SIRK_BACKUP_TIME_ZONE || "Europe/Warsaw";
const policyPath = path.join(stateDir, "backup-policy.json");
const historyPath = path.join(stateDir, "backup-history.json");
const updateStatusPath = path.join(stateDir, "status.json");
const restoreStatusPath = path.join(stateDir, "restore-status.json");
const maxArchiveBytes = Math.max(1024 * 1024, Number(process.env.SIRK_BACKUP_MAX_ARCHIVE_BYTES || 50 * 1024 * 1024 * 1024));
const maxArchiveEntries = Math.max(100, Math.min(1000000, Number(process.env.SIRK_BACKUP_MAX_ENTRIES || 100000)));

if (token.length < 43) throw new Error("SIRK_UPDATER_TOKEN must contain at least 43 characters.");
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("SIRK_BACKUP_MANAGER_PORT is invalid.");
fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });

function safeEqual(a, b) {
    const left = Buffer.from(String(a || ""));
    const right = Buffer.from(String(b || ""));
    return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function authorized(req) {
    const match = String(req.headers.authorization || "").match(/^Bearer ([A-Za-z0-9_-]{43,512})$/);
    return Boolean(match && safeEqual(match[1], token));
}

function readJson(filePath, fallback) {
    try { return JSON.parse(fs.readFileSync(filePath, "utf8")); }
    catch (error) {
        if (error.code === "ENOENT") return fallback;
        throw error;
    }
}

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
            try { fs.closeSync(descriptor); } catch (_) { /* ignore cleanup failure */ }
        }
        try { fs.rmSync(temporary, { force: true }); } catch (_) { /* ignore cleanup failure */ }
        throw error;
    }
}

function json(res, status, body, headers = {}) {
    const data = Buffer.from(JSON.stringify(body));
    res.writeHead(status, Object.assign({
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": String(data.length),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
        "Referrer-Policy": "no-referrer"
    }, headers));
    res.end(data);
}

function readBody(req, limit = 16384) {
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

function defaultPolicy() {
    return { enabled: false, hour: 2, minute: 0, retention: 10, minimumAgeHours: 20, updatedAtUtc: "", updatedBy: "" };
}

function normalizePolicy(input, previous) {
    const base = Object.assign(defaultPolicy(), previous || {});
    return {
        enabled: Boolean(input.enabled),
        hour: Math.max(0, Math.min(23, Number(input.hour ?? base.hour) || 0)),
        minute: Math.max(0, Math.min(59, Number(input.minute ?? base.minute) || 0)),
        retention: Math.max(1, Math.min(365, Number(input.retention ?? base.retention) || 10)),
        minimumAgeHours: Math.max(1, Math.min(168, Number(input.minimumAgeHours ?? base.minimumAgeHours) || 20)),
        updatedAtUtc: new Date().toISOString(),
        updatedBy: String(input.updatedBy || "unknown").slice(0, 200)
    };
}

function readPolicy() { return Object.assign(defaultPolicy(), readJson(policyPath, {})); }

function readHistory() {
    const value = readJson(historyPath, { version: 1, events: [] });
    return value && Array.isArray(value.events) ? value : { version: 1, events: [] };
}

function appendHistory(event) {
    const history = readHistory();
    history.events.unshift(Object.assign({ id: crypto.randomUUID(), timestampUtc: new Date().toISOString() }, event));
    history.events = history.events.slice(0, 200);
    atomicJson(historyPath, history);
}

function logNameAllowed(name) {
    return /^update-\d{8}T\d{6}Z\.log$/.test(String(name || ""));
}

function listBackups() {
    return fs.readdirSync(backupDir, { withFileTypes: true })
        .filter(entry => entry.isFile() && archiveSecurity.backupNameAllowed(entry.name))
        .map(entry => {
            const target = path.join(backupDir, entry.name);
            const stat = fs.statSync(target);
            return {
                name: entry.name,
                size: stat.size,
                createdAtUtc: stat.mtime.toISOString(),
                checksum: archiveSecurity.readExpectedChecksum(target) || null
            };
        })
        .sort((a, b) => b.createdAtUtc.localeCompare(a.createdAtUtc));
}

function zonedTimestamp(date = new Date()) {
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone, year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
        timeZoneName: "longOffset"
    }).formatToParts(date);
    const value = type => (parts.find(part => part.type === type) || {}).value || "";
    const offset = value("timeZoneName").replace(/^GMT/, "").replace(":", "") || "+0000";
    return value("year") + value("month") + value("day") + "T" + value("hour") + value("minute") + value("second") + offset;
}

function allocateBackupTarget() {
    const timestamp = Date.now();
    for (let offset = 0; offset < 10; offset += 1) {
        const name = "sirk-central-" + zonedTimestamp(new Date(timestamp + offset * 1000)) + ".tar.gz";
        const target = path.join(backupDir, name);
        if (!fs.existsSync(target)) return { name, target };
    }
    throw new Error("Unable to allocate a unique backup file name.");
}

function operationRunning() {
    const update = readJson(updateStatusPath, {});
    const restore = readJson(restoreStatusPath, {});
    return Boolean(update.running || restore.running || ["starting", "running", "rollback"].includes(update.state));
}

function createBackup(source) {
    if (!fs.existsSync(dataDir) || !fs.statSync(dataDir).isDirectory()) throw new Error("Persistent data directory is unavailable.");
    const allocated = allocateBackupTarget();
    const temporary = path.join(backupDir, ".partial-" + process.pid + "-" + crypto.randomBytes(8).toString("hex") + ".tar.gz");
    try {
        const result = spawnSync("tar", ["-czf", temporary, "-C", dataDir, "."], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
        if (result.status !== 0) throw new Error("Backup failed: " + String(result.stderr || result.error || result.status));
        fs.chmodSync(temporary, 0o600);
        fs.renameSync(temporary, allocated.target);
        const checksum = archiveSecurity.writeChecksum(allocated.target);
        archiveSecurity.validateArchive(allocated.target, { requireChecksum: true, maxArchiveBytes, maxEntries: maxArchiveEntries });
        const stat = fs.statSync(allocated.target);
        const backup = { name: allocated.name, size: stat.size, createdAtUtc: stat.mtime.toISOString(), checksum };
        appendHistory({ action: "backup.created", result: "success", source, backup });
        return backup;
    } catch (error) {
        try { fs.rmSync(temporary, { force: true }); } catch (_) { /* ignore cleanup failure */ }
        try { fs.rmSync(allocated.target, { force: true }); } catch (_) { /* ignore cleanup failure */ }
        try { fs.rmSync(archiveSecurity.checksumPath(allocated.target), { force: true }); } catch (_) { /* ignore cleanup failure */ }
        throw error;
    }
}

function applyRetention(retention, source) {
    const backups = listBackups();
    const removed = [];
    for (const backup of backups.slice(retention)) {
        const target = path.join(backupDir, backup.name);
        fs.rmSync(target, { force: true });
        fs.rmSync(archiveSecurity.checksumPath(target), { force: true });
        removed.push(backup.name);
    }
    if (removed.length) appendHistory({ action: "backup.retention", result: "success", source, removed });
    return removed;
}

function lastAutomaticBackup() {
    return readHistory().events.find(event => event.action === "backup.created" && event.source === "schedule" && event.result === "success") || null;
}

function scheduleDue(policy, now = new Date()) {
    if (!policy.enabled || operationRunning()) return false;
    const local = new Intl.DateTimeFormat("en-CA", {
        timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
    }).formatToParts(now);
    const value = type => Number((local.find(part => part.type === type) || {}).value || 0);
    if (value("hour") !== policy.hour || value("minute") !== policy.minute) return false;
    const last = lastAutomaticBackup();
    if (!last) return true;
    return now.getTime() - new Date(last.timestampUtc).getTime() >= policy.minimumAgeHours * 3600000;
}

function schedulerTick() {
    const policy = readPolicy();
    if (!scheduleDue(policy)) return;
    try {
        createBackup("schedule");
        applyRetention(policy.retention, "schedule");
    } catch (error) {
        appendHistory({ action: "backup.created", result: "failure", source: "schedule", error: String(error.message || error) });
    }
}

function streamFile(res, filePath, downloadName, contentType, headers = {}) {
    const stat = fs.statSync(filePath);
    res.writeHead(200, Object.assign({
        "Content-Type": contentType,
        "Content-Length": String(stat.size),
        "Content-Disposition": `attachment; filename="${downloadName}"`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff"
    }, headers));
    fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer(async (req, res) => {
    try {
        const url = new URL(req.url, "http://backup-manager.local");
        if (url.pathname === "/healthz" && req.method === "GET") return json(res, 200, { ok: true });
        if (!authorized(req)) return json(res, 404, { ok: false, error: "Not found." });

        if (url.pathname === "/policy" && req.method === "GET") {
            return json(res, 200, { ok: true, policy: readPolicy(), backups: listBackups(), history: readHistory().events.slice(0, 50), operationRunning: operationRunning() });
        }

        if (url.pathname === "/policy" && req.method === "PUT") {
            const policy = normalizePolicy(await readBody(req), readPolicy());
            atomicJson(policyPath, policy);
            const removed = applyRetention(policy.retention, "policy-update");
            appendHistory({ action: "backup.policy_updated", result: "success", source: "api", policy, removed });
            return json(res, 200, { ok: true, policy, removed });
        }

        if (url.pathname === "/run" && req.method === "POST") {
            if (operationRunning()) return json(res, 409, { ok: false, error: "Update or restore operation is currently running." });
            const body = await readBody(req);
            if (body.confirm !== "BACKUP SIRK CENTRAL") return json(res, 400, { ok: false, error: "Backup confirmation is invalid." });
            const backup = createBackup("manual");
            const removed = applyRetention(readPolicy().retention, "manual");
            return json(res, 201, { ok: true, backup, removed });
        }

        const backupDownload = url.pathname.match(/^\/backup\/([^/]+)\/download$/);
        if (backupDownload && req.method === "GET") {
            const name = decodeURIComponent(backupDownload[1]);
            if (!archiveSecurity.backupNameAllowed(name)) return json(res, 400, { ok: false, error: "Backup name is invalid." });
            const target = path.resolve(backupDir, name);
            if (path.dirname(target) !== backupDir || !fs.existsSync(target)) return json(res, 404, { ok: false, error: "Backup not found." });
            const validation = archiveSecurity.validateArchive(target, { requireChecksum: true, maxArchiveBytes, maxEntries: maxArchiveEntries });
            appendHistory({ action: "backup.downloaded", result: "success", source: "api", backup: name });
            return streamFile(res, target, name, "application/gzip", { "X-SIRK-Backup-SHA256": validation.checksum.digest });
        }

        const logDownload = url.pathname.match(/^\/log\/([^/]+)\/download$/);
        if (logDownload && req.method === "GET") {
            const name = decodeURIComponent(logDownload[1]);
            if (!logNameAllowed(name)) return json(res, 400, { ok: false, error: "Log name is invalid." });
            const target = path.resolve(stateDir, name);
            if (path.dirname(target) !== stateDir || !fs.existsSync(target)) return json(res, 404, { ok: false, error: "Log not found." });
            return streamFile(res, target, name, "text/plain; charset=utf-8");
        }

        return json(res, 404, { ok: false, error: "Not found." });
    } catch (error) {
        return json(res, error.statusCode || 400, { ok: false, error: String(error.message || error) });
    }
});

if (require.main === module) {
    server.listen(port, bindHost, () => process.stdout.write(`SIRK backup manager listening on ${bindHost}:${port}\n`));
    setInterval(schedulerTick, 60000).unref();
    setTimeout(schedulerTick, 5000).unref();
}

module.exports = { normalizePolicy, scheduleDue, logNameAllowed, createBackup, applyRetention, server };
