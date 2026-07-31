"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const crypto = require("node:crypto");

const bindHost = process.env.SIRK_UPDATER_BIND_HOST || "0.0.0.0";
const port = Number(process.env.SIRK_UPDATER_PORT || 8090);
const token = String(process.env.SIRK_UPDATER_TOKEN || "");
const script = process.env.SIRK_UPDATER_SCRIPT || "/opt/sirk-central/deploy/web-update.sh";
const stateDir = process.env.SIRK_UPDATER_STATE_DIR || "/var/lib/sirk-updater";
const dataDir = process.env.SIRK_BACKUP_SOURCE_DIR || "/var/lib/sirk-central";
const backupDir = process.env.SIRK_BACKUP_DIR || path.join(stateDir, "backups");
const backupTimeZone = process.env.SIRK_BACKUP_TIME_ZONE || "Europe/Warsaw";
const composeFile = process.env.SIRK_COMPOSE_FILE || "/opt/sirk-central/docker-compose.yml";
const statusPath = path.join(stateDir, "status.json");
const restoreStatusPath = path.join(stateDir, "restore-status.json");
let child = null;
let restoreRunning = false;

if (token.length < 43) throw new Error("SIRK_UPDATER_TOKEN must contain at least 43 characters.");
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("SIRK_UPDATER_PORT is invalid.");
fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });

function safeEqual(a, b) {
    const left = Buffer.from(String(a || ""));
    const right = Buffer.from(String(b || ""));
    return left.length === right.length && crypto.timingSafeEqual(left, right);
}
function authorized(req) {
    const match = String(req.headers.authorization || "").match(/^Bearer (.+)$/);
    return Boolean(match && safeEqual(match[1], token));
}
function atomicJson(filePath, value) {
    const temporary = filePath + ".tmp";
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(temporary, filePath);
}
function readJson(filePath, fallback) {
    try { return JSON.parse(fs.readFileSync(filePath, "utf8")); }
    catch (_) { return fallback; }
}
function writeStatus(value) { atomicJson(statusPath, value); }
function readStatus() { return readJson(statusPath, { state: "idle", running: false }); }
function writeRestoreStatus(value) { atomicJson(restoreStatusPath, value); }
function readRestoreStatus() { return readJson(restoreStatusPath, { state: "idle", running: false }); }
function backupNameAllowed(name) {
    return /^sirk-central-\d{8}T\d{6}(?:Z|[+-]\d{4})\.tar\.gz$/.test(String(name || ""));
}
function listBackups() {
    return fs.readdirSync(backupDir, { withFileTypes: true })
        .filter(entry => entry.isFile() && backupNameAllowed(entry.name))
        .map(entry => {
            const stat = fs.statSync(path.join(backupDir, entry.name));
            return { name: entry.name, size: stat.size, createdAtUtc: stat.mtime.toISOString() };
        })
        .sort((a, b) => b.createdAtUtc.localeCompare(a.createdAtUtc));
}
function json(res, status, body) {
    const data = Buffer.from(JSON.stringify(body));
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": String(data.length), "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    res.end(data);
}
function readBody(req, limit = 8192) {
    return new Promise((resolve, reject) => {
        const chunks = []; let size = 0;
        req.on("data", chunk => { size += chunk.length; if (size > limit) { reject(new Error("Request body is too large.")); req.destroy(); } else chunks.push(chunk); });
        req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); } catch (_) { reject(new Error("Invalid JSON body.")); } });
        req.on("error", reject);
    });
}
function zonedTimestamp() {
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: backupTimeZone,
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit",
        hourCycle: "h23", timeZoneName: "longOffset"
    }).formatToParts(new Date());
    const value = type => (parts.find(part => part.type === type) || {}).value || "";
    const offset = value("timeZoneName").replace(/^GMT/, "").replace(":", "") || "+0000";
    return value("year") + value("month") + value("day") + "T" + value("hour") + value("minute") + value("second") + offset;
}
function createBackup() {
    if (!fs.existsSync(dataDir)) throw new Error("Persistent data directory is unavailable.");
    const name = "sirk-central-" + zonedTimestamp() + ".tar.gz";
    const target = path.join(backupDir, name);
    const result = spawnSync("tar", ["-czf", target, "-C", dataDir, "."], { encoding: "utf8" });
    if (result.status !== 0) throw new Error("Backup failed: " + String(result.stderr || result.error || result.status));
    fs.chmodSync(target, 0o600);
    const stat = fs.statSync(target);
    return { name, size: stat.size, createdAtUtc: stat.mtime.toISOString() };
}
function validatedBackupPath(name) {
    if (!backupNameAllowed(name)) throw new Error("Backup name is invalid.");
    const target = path.join(backupDir, name);
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) throw new Error("Backup was not found.");
    const listing = spawnSync("tar", ["-tzf", target], { encoding: "utf8" });
    if (listing.status !== 0) throw new Error("Backup archive is damaged or unreadable.");
    for (const item of String(listing.stdout || "").split(/\r?\n/).filter(Boolean)) {
        const normalized = path.posix.normalize(item.replace(/^\.\//, ""));
        if (path.posix.isAbsolute(item) || normalized === ".." || normalized.startsWith("../")) throw new Error("Backup archive contains an unsafe path.");
    }
    return target;
}
function deleteBackup(name) {
    if (restoreRunning || readRestoreStatus().running) throw new Error("A backup cannot be deleted while restore is running.");
    const target = validatedBackupPath(name);
    fs.rmSync(target, { force: false });
    return { name };
}
function runCompose(args) {
    const result = spawnSync("docker", ["compose", "-f", composeFile, "--profile", "auth", ...args], { cwd: "/opt/sirk-central", encoding: "utf8" });
    if (result.status !== 0) throw new Error("Docker Compose failed: " + String(result.stderr || result.stdout || result.status));
}
function clearDataDirectory() {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    for (const entry of fs.readdirSync(dataDir)) fs.rmSync(path.join(dataDir, entry), { recursive: true, force: true });
}
function performRestore(name, archive, safetyBackup) {
    restoreRunning = true;
    const startedAtUtc = new Date().toISOString();
    writeRestoreStatus({ state: "stopping", running: true, backup: name, safetyBackup: safetyBackup.name, startedAtUtc });
    try {
        runCompose(["stop", "central", "auth"]);
        writeRestoreStatus({ state: "restoring", running: true, backup: name, safetyBackup: safetyBackup.name, startedAtUtc });
        clearDataDirectory();
        const extract = spawnSync("tar", ["-xzf", archive, "-C", dataDir], { encoding: "utf8" });
        if (extract.status !== 0) throw new Error("Restore extraction failed: " + String(extract.stderr || extract.error || extract.status));
        runCompose(["up", "-d", "--force-recreate", "central", "auth"]);
        writeRestoreStatus({ state: "completed", running: false, backup: name, safetyBackup: safetyBackup.name, startedAtUtc, finishedAtUtc: new Date().toISOString() });
    } catch (error) {
        try { runCompose(["up", "-d", "--force-recreate", "central", "auth"]); } catch (_) { /* preserve original error */ }
        writeRestoreStatus({ state: "failed", running: false, backup: name, safetyBackup: safetyBackup.name, startedAtUtc, finishedAtUtc: new Date().toISOString(), error: String(error.message || error) });
    } finally {
        restoreRunning = false;
    }
}

const server = http.createServer(async (req, res) => {
    try {
        const url = new URL(req.url, "http://updater.local");
        const backupDelete = url.pathname.match(/^\/backup\/([^/]+)$/);
        if (url.pathname === "/healthz" && req.method === "GET") return json(res, 200, { ok: true });
        if (!authorized(req)) return json(res, 404, { ok: false, error: "Not found." });
        if (url.pathname === "/status" && req.method === "GET") {
            const status = readStatus(); status.running = Boolean(child && child.exitCode === null);
            return json(res, 200, { ok: true, status });
        }
        if (url.pathname === "/run" && req.method === "POST") {
            if (child && child.exitCode === null) return json(res, 409, { ok: false, error: "An update is already running." });
            const body = await readBody(req);
            if (body.confirm !== "UPDATE SIRK CENTRAL") return json(res, 400, { ok: false, error: "Update confirmation is invalid." });
            const startedAtUtc = new Date().toISOString();
            writeStatus({ state: "starting", running: true, startedAtUtc, requestedBy: String(body.requestedBy || "unknown").slice(0, 200) });
            child = spawn("/usr/bin/env", ["bash", script], { cwd: "/opt/sirk-central", env: Object.assign({}, process.env, { SIRK_UPDATE_REQUESTED_BY: String(body.requestedBy || "unknown").slice(0, 200), SIRK_UPDATE_STARTED_AT: startedAtUtc }), stdio: ["ignore", "ignore", "ignore"] });
            child.once("error", error => writeStatus({ state: "failed", running: false, startedAtUtc, finishedAtUtc: new Date().toISOString(), error: String(error.message || error) }));
            child.once("exit", code => { const current = readStatus(); if (current.state === "running" || current.state === "starting") writeStatus(Object.assign({}, current, { state: code === 0 ? "completed" : "failed", running: false, finishedAtUtc: new Date().toISOString(), exitCode: code })); child = null; });
            return json(res, 202, { ok: true, accepted: true, startedAtUtc });
        }
        if (url.pathname === "/backup/status" && req.method === "GET") return json(res, 200, { ok: true, backups: listBackups(), restore: readRestoreStatus() });
        if (url.pathname === "/backup/run" && req.method === "POST") {
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
            if (restoreRunning) return json(res, 409, { ok: false, error: "A restore is already running." });
            const body = await readBody(req);
            if (body.confirm !== "RESTORE SIRK CENTRAL") return json(res, 400, { ok: false, error: "Restore confirmation is invalid." });
            const name = String(body.name || "");
            const archive = validatedBackupPath(name);
            const safetyBackup = createBackup();
            writeRestoreStatus({ state: "scheduled", running: true, backup: name, safetyBackup: safetyBackup.name, requestedAtUtc: new Date().toISOString() });
            setTimeout(() => performRestore(name, archive, safetyBackup), 750);
            return json(res, 202, { ok: true, accepted: true, backup: name, safetyBackup: safetyBackup.name });
        }
        return json(res, 404, { ok: false, error: "Not found." });
    } catch (error) {
        return json(res, 400, { ok: false, error: String(error.message || error) });
    }
});

server.listen(port, bindHost, () => process.stdout.write(`SIRK updater listening on ${bindHost}:${port}\n`));
