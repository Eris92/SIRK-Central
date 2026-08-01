"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const archiveSecurity = require("./backup-archive");
const restoreTransaction = require("./restore-transaction");

const bindHost = process.env.SIRK_UPDATER_BIND_HOST || "0.0.0.0";
const port = Number(process.env.SIRK_UPDATER_PORT || 8090);
const token = String(process.env.SIRK_UPDATER_TOKEN || "");
const installDir = path.resolve(process.env.SIRK_INSTALL_DIR || "/opt/sirk-central");
const script = path.resolve(process.env.SIRK_UPDATER_SCRIPT || path.join(installDir, "deploy/web-update.sh"));
const stateDir = path.resolve(process.env.SIRK_UPDATER_STATE_DIR || "/var/lib/sirk-updater");
const dataDir = path.resolve(process.env.SIRK_BACKUP_SOURCE_DIR || "/var/lib/sirk-central");
const backupDir = path.resolve(process.env.SIRK_BACKUP_DIR || path.join(stateDir, "backups"));
const backupTimeZone = process.env.SIRK_BACKUP_TIME_ZONE || "Europe/Warsaw";
const composeFiles = String(process.env.SIRK_COMPOSE_FILE || path.join(installDir, "docker-compose.yml"))
    .split(path.delimiter).map(value => value.trim()).filter(Boolean).map(value => path.resolve(value));
const composeProfiles = String(process.env.SIRK_COMPOSE_PROFILES || "auth").split(",").map(value => value.trim()).filter(Boolean);
const managedServices = ["central", ...(String(process.env.SIRK_AUTH_ORIGIN || "").trim() ? ["auth"] : [])];
const statusPath = path.join(stateDir, "status.json");
const restoreStatusPath = path.join(stateDir, "restore-status.json");
const maxArchiveBytes = Math.max(1024 * 1024, Number(process.env.SIRK_BACKUP_MAX_ARCHIVE_BYTES || 50 * 1024 * 1024 * 1024));
const maxArchiveEntries = Math.max(100, Math.min(1000000, Number(process.env.SIRK_BACKUP_MAX_ENTRIES || 100000)));
const allowLegacyWithoutChecksum = String(process.env.SIRK_BACKUP_ALLOW_LEGACY_WITHOUT_CHECKSUM || "").toLowerCase() === "true";
let child = null;
let restoreRunning = false;

if (token.length < 43) throw new Error("SIRK_UPDATER_TOKEN must contain at least 43 characters.");
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("SIRK_UPDATER_PORT is invalid.");
if (!composeFiles.length) throw new Error("At least one Docker Compose file is required.");
for (const file of composeFiles) if (!fs.existsSync(file)) throw new Error("Docker Compose file is missing: " + file);
if (!script.startsWith(installDir + path.sep) || !fs.existsSync(script)) throw new Error("Updater script must exist inside SIRK_INSTALL_DIR.");
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

function readJson(filePath, fallback) {
    try { return JSON.parse(fs.readFileSync(filePath, "utf8")); }
    catch (error) {
        if (error.code === "ENOENT") return fallback;
        throw error;
    }
}

function writeStatus(value) { atomicJson(statusPath, value); }
function readStatus() { return readJson(statusPath, { state: "idle", running: false }); }
function writeRestoreStatus(value) { atomicJson(restoreStatusPath, value); }
function readRestoreStatus() { return readJson(restoreStatusPath, { state: "idle", running: false }); }

function recoverInterruptedState() {
    const update = readStatus();
    if (update.running) writeStatus(Object.assign({}, update, { state: "interrupted", running: false, finishedAtUtc: new Date().toISOString(), error: "Updater process restarted while the operation was running." }));
    const restore = readRestoreStatus();
    if (restore.running) writeRestoreStatus(Object.assign({}, restore, { state: "interrupted", running: false, finishedAtUtc: new Date().toISOString(), error: "Updater process restarted while restore was running. Manual validation is required before another restore." }));
}

function updateIsRunning() {
    return Boolean(child && child.exitCode === null) || Boolean(readStatus().running);
}

function restoreIsRunning() {
    return restoreRunning || Boolean(readRestoreStatus().running);
}

function operationRunning() {
    return updateIsRunning() || restoreIsRunning();
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

function zonedTimestamp(date = new Date()) {
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: backupTimeZone,
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit",
        hourCycle: "h23", timeZoneName: "longOffset"
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

function createBackup() {
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
        return { name: allocated.name, size: stat.size, createdAtUtc: stat.mtime.toISOString(), checksum };
    } catch (error) {
        try { fs.rmSync(temporary, { force: true }); } catch (_) { /* ignore cleanup failure */ }
        try { fs.rmSync(allocated.target, { force: true }); } catch (_) { /* ignore cleanup failure */ }
        try { fs.rmSync(archiveSecurity.checksumPath(allocated.target), { force: true }); } catch (_) { /* ignore cleanup failure */ }
        throw error;
    }
}

function validatedBackupPath(name) {
    if (!archiveSecurity.backupNameAllowed(name)) throw new Error("Backup name is invalid.");
    const target = path.resolve(backupDir, name);
    if (path.dirname(target) !== backupDir) throw new Error("Backup path is invalid.");
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) throw new Error("Backup was not found.");
    archiveSecurity.validateArchive(target, {
        requireChecksum: !allowLegacyWithoutChecksum,
        maxArchiveBytes,
        maxEntries: maxArchiveEntries
    });
    return target;
}

function deleteBackup(name) {
    if (operationRunning()) throw Object.assign(new Error("A backup cannot be deleted while an update or restore is running."), { statusCode: 409 });
    const target = validatedBackupPath(name);
    fs.rmSync(target, { force: false });
    fs.rmSync(archiveSecurity.checksumPath(target), { force: true });
    return { name };
}

function composeArguments() {
    const args = [];
    for (const file of composeFiles) args.push("-f", file);
    for (const profile of composeProfiles) args.push("--profile", profile);
    return args;
}

function runDocker(args, options = {}) {
    const result = spawnSync("docker", args, {
        cwd: installDir,
        encoding: "utf8",
        maxBuffer: options.maxBuffer || 8 * 1024 * 1024
    });
    if (result.status !== 0) throw new Error("Docker command failed: " + String(result.stderr || result.stdout || result.error || result.status));
    return String(result.stdout || "").trim();
}

function runCompose(args) {
    return runDocker(["compose", ...composeArguments(), ...args]);
}

function waitForCentralHealthy(timeoutMs = 120000) {
    const deadline = Date.now() + timeoutMs;
    let lastState = "unknown";
    while (Date.now() < deadline) {
        const containerId = runCompose(["ps", "-q", "central"]);
        if (containerId) {
            lastState = runDocker(["inspect", containerId, "--format", "{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}"]) || "unknown";
            if (lastState === "healthy") return;
            if (["unhealthy", "exited", "dead"].includes(lastState)) throw new Error("Central container entered state: " + lastState);
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
    }
    throw new Error("Central did not become healthy before timeout; last state=" + lastState);
}

function clearDataDirectory() {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    for (const entry of fs.readdirSync(dataDir)) fs.rmSync(path.join(dataDir, entry), { recursive: true, force: true });
}

function hardenRestoredTree(root) {
    let entries = 0;
    const visit = current => {
        const stat = fs.lstatSync(current);
        entries += 1;
        if (entries > maxArchiveEntries) throw new Error("Restored data contains too many filesystem entries.");
        if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error("Restored data contains an unsupported filesystem entry.");
        if (stat.isDirectory()) {
            fs.chmodSync(current, 0o700);
            for (const name of fs.readdirSync(current)) visit(path.join(current, name));
        } else fs.chmodSync(current, 0o600);
    };
    visit(root);
}

function replaceData(archivePath) {
    archiveSecurity.validateArchive(archivePath, {
        requireChecksum: !allowLegacyWithoutChecksum,
        maxArchiveBytes,
        maxEntries: maxArchiveEntries
    });
    clearDataDirectory();
    const extract = spawnSync("tar", [
        "--extract", "--gzip", "--file", archivePath, "--directory", dataDir,
        "--no-same-owner", "--no-same-permissions", "--delay-directory-restore"
    ], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
    if (extract.status !== 0) throw new Error("Restore extraction failed: " + String(extract.stderr || extract.error || extract.status));
    hardenRestoredTree(dataDir);
}

function stopServices() {
    runCompose(["stop", ...managedServices]);
}

function startServices() {
    runCompose(["up", "-d", "--force-recreate", ...managedServices]);
}

function performRestore(name, archivePath, safetyBackup) {
    try {
        const safetyArchive = validatedBackupPath(safetyBackup.name);
        return restoreTransaction.run({
            backupName: name,
            safetyBackupName: safetyBackup.name,
            targetArchive: archivePath,
            safetyArchive,
            writeStatus: writeRestoreStatus,
            stopServices,
            startServices,
            waitHealthy: waitForCentralHealthy,
            replaceData
        });
    } finally {
        restoreRunning = false;
    }
}

recoverInterruptedState();

const server = http.createServer(async (req, res) => {
    try {
        const url = new URL(req.url, "http://updater.local");
        const backupDelete = url.pathname.match(/^\/backup\/([^/]+)$/);
        if (url.pathname === "/healthz" && req.method === "GET") return json(res, 200, { ok: true });
        if (!authorized(req)) return json(res, 404, { ok: false, error: "Not found." });

        if (url.pathname === "/status" && req.method === "GET") {
            const status = readStatus();
            status.running = updateIsRunning();
            return json(res, 200, { ok: true, status, restore: readRestoreStatus() });
        }

        if (url.pathname === "/run" && req.method === "POST") {
            if (operationRunning()) return json(res, 409, { ok: false, error: "An update or restore operation is already running." });
            const body = await readBody(req);
            if (body.confirm !== "UPDATE SIRK CENTRAL") return json(res, 400, { ok: false, error: "Update confirmation is invalid." });
            const startedAtUtc = new Date().toISOString();
            const requestedBy = String(body.requestedBy || "unknown").slice(0, 200);
            writeStatus({ state: "starting", running: true, startedAtUtc, requestedBy });
            let spawnFailed = false;
            child = spawn("/usr/bin/env", ["bash", script], {
                cwd: installDir,
                env: Object.assign({}, process.env, { SIRK_UPDATE_REQUESTED_BY: requestedBy, SIRK_UPDATE_STARTED_AT: startedAtUtc }),
                stdio: ["ignore", "ignore", "ignore"]
            });
            child.once("error", error => {
                spawnFailed = true;
                writeStatus({ state: "failed", running: false, startedAtUtc, finishedAtUtc: new Date().toISOString(), error: String(error.message || error) });
            });
            child.once("exit", code => {
                const current = readStatus();
                if (!spawnFailed && (current.state === "running" || current.state === "starting")) {
                    writeStatus(Object.assign({}, current, { state: code === 0 ? "completed" : "failed", running: false, finishedAtUtc: new Date().toISOString(), exitCode: code }));
                }
                child = null;
            });
            return json(res, 202, { ok: true, accepted: true, startedAtUtc });
        }

        if (url.pathname === "/backup/status" && req.method === "GET") {
            return json(res, 200, { ok: true, backups: listBackups(), restore: readRestoreStatus(), operationRunning: operationRunning() });
        }

        if (url.pathname === "/backup/run" && req.method === "POST") {
            if (operationRunning()) return json(res, 409, { ok: false, error: "A backup cannot start while an update or restore is running." });
            const body = await readBody(req);
            if (body.confirm !== "BACKUP SIRK CENTRAL") return json(res, 400, { ok: false, error: "Backup confirmation is invalid." });
            return json(res, 201, { ok: true, backup: createBackup() });
        }

        if (backupDelete && req.method === "DELETE") {
            const body = await readBody(req);
            if (body.confirm !== "DELETE SIRK BACKUP") return json(res, 400, { ok: false, error: "Backup deletion confirmation is invalid." });
            const name = decodeURIComponent(backupDelete[1]);
            return json(res, 200, { ok: true, deleted: deleteBackup(name) });
        }

        if (url.pathname === "/backup/restore" && req.method === "POST") {
            if (operationRunning()) return json(res, 409, { ok: false, error: "An update or restore operation is already running." });
            const body = await readBody(req);
            if (body.confirm !== "RESTORE SIRK CENTRAL") return json(res, 400, { ok: false, error: "Restore confirmation is invalid." });
            const name = String(body.name || "");
            const archivePath = validatedBackupPath(name);
            const safetyBackup = createBackup();
            restoreRunning = true;
            writeRestoreStatus({ state: "scheduled", running: true, backup: name, safetyBackup: safetyBackup.name, requestedAtUtc: new Date().toISOString() });
            setTimeout(() => {
                try { performRestore(name, archivePath, safetyBackup); }
                catch (error) {
                    restoreRunning = false;
                    writeRestoreStatus({ state: "rollback_failed", running: false, backup: name, safetyBackup: safetyBackup.name, finishedAtUtc: new Date().toISOString(), error: String(error.stack || error.message || error).slice(0, 8000) });
                }
            }, 750).unref();
            return json(res, 202, { ok: true, accepted: true, backup: name, safetyBackup: safetyBackup.name });
        }

        return json(res, 404, { ok: false, error: "Not found." });
    } catch (error) {
        return json(res, error.statusCode || 400, { ok: false, error: String(error.message || error) });
    }
});

if (require.main === module) {
    server.listen(port, bindHost, () => process.stdout.write(`SIRK updater listening on ${bindHost}:${port}\n`));
}

module.exports = {
    server,
    atomicJson,
    createBackup,
    validatedBackupPath,
    operationRunning,
    performRestore,
    replaceData,
    waitForCentralHealthy
};
