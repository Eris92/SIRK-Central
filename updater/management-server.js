"use strict";

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

const bindHost = process.env.SIRK_BACKUP_MANAGER_BIND_HOST || "0.0.0.0";
const port = Number(process.env.SIRK_BACKUP_MANAGER_PORT || 8091);
const token = String(process.env.SIRK_UPDATER_TOKEN || "");
const stateDir = process.env.SIRK_UPDATER_STATE_DIR || "/var/lib/sirk-updater";
const dataDir = process.env.SIRK_BACKUP_SOURCE_DIR || "/var/lib/sirk-central";
const backupDir = process.env.SIRK_BACKUP_DIR || path.join(stateDir, "backups");
const timeZone = process.env.SIRK_BACKUP_TIME_ZONE || "Europe/Warsaw";
const policyPath = path.join(stateDir, "backup-policy.json");
const historyPath = path.join(stateDir, "backup-history.json");
const updateStatusPath = path.join(stateDir, "status.json");
const restoreStatusPath = path.join(stateDir, "restore-status.json");

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
    const match = String(req.headers.authorization || "").match(/^Bearer (.+)$/);
    return Boolean(match && safeEqual(match[1], token));
}
function readJson(filePath, fallback) {
    try { return JSON.parse(fs.readFileSync(filePath, "utf8")); }
    catch (_) { return fallback; }
}
function atomicJson(filePath, value) {
    const temporary = filePath + ".tmp-" + process.pid + "-" + crypto.randomBytes(4).toString("hex");
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, filePath);
}
function json(res, status, body) {
    const data = Buffer.from(JSON.stringify(body));
    res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": String(data.length),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff"
    });
    res.end(data);
}
function readBody(req, limit = 16384) {
    return new Promise((resolve, reject) => {
        const chunks = []; let size = 0;
        req.on("data", chunk => {
            size += chunk.length;
            if (size > limit) { reject(new Error("Request body is too large.")); req.destroy(); }
            else chunks.push(chunk);
        });
        req.on("end", () => {
            try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
            catch (_) { reject(new Error("Invalid JSON body.")); }
        });
        req.on("error", reject);
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
function backupNameAllowed(name) {
    return /^sirk-central-\d{8}T\d{6}(?:Z|[+-]\d{4})\.tar\.gz$/.test(String(name || ""));
}
function logNameAllowed(name) {
    return /^update-\d{8}T\d{6}Z\.log$/.test(String(name || ""));
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
function zonedTimestamp() {
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone, year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
        timeZoneName: "longOffset"
    }).formatToParts(new Date());
    const value = type => (parts.find(part => part.type === type) || {}).value || "";
    const offset = value("timeZoneName").replace(/^GMT/, "").replace(":", "") || "+0000";
    return value("year") + value("month") + value("day") + "T" + value("hour") + value("minute") + value("second") + offset;
}
function operationRunning() {
    const update = readJson(updateStatusPath, {});
    const restore = readJson(restoreStatusPath, {});
    return Boolean(update.running || restore.running || ["starting", "running", "rollback"].includes(update.state));
}
function createBackup(source) {
    if (!fs.existsSync(dataDir)) throw new Error("Persistent data directory is unavailable.");
    const name = "sirk-central-" + zonedTimestamp() + ".tar.gz";
    const target = path.join(backupDir, name);
    const result = spawnSync("tar", ["-czf", target, "-C", dataDir, "."], { encoding: "utf8" });
    if (result.status !== 0) throw new Error("Backup failed: " + String(result.stderr || result.error || result.status));
    fs.chmodSync(target, 0o600);
    const stat = fs.statSync(target);
    const backup = { name, size: stat.size, createdAtUtc: stat.mtime.toISOString() };
    appendHistory({ action: "backup.created", result: "success", source, backup });
    return backup;
}
function applyRetention(retention, source) {
    const backups = listBackups();
    const removed = [];
    for (const backup of backups.slice(retention)) {
        fs.rmSync(path.join(backupDir, backup.name), { force: true });
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
function streamFile(res, filePath, downloadName, contentType) {
    const stat = fs.statSync(filePath);
    res.writeHead(200, {
        "Content-Type": contentType,
        "Content-Length": String(stat.size),
        "Content-Disposition": `attachment; filename="${downloadName}"`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff"
    });
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
            if (!backupNameAllowed(name)) return json(res, 400, { ok: false, error: "Backup name is invalid." });
            const target = path.join(backupDir, name);
            if (!fs.existsSync(target)) return json(res, 404, { ok: false, error: "Backup not found." });
            appendHistory({ action: "backup.downloaded", result: "success", source: "api", backup: name });
            return streamFile(res, target, name, "application/gzip");
        }
        const logDownload = url.pathname.match(/^\/log\/([^/]+)\/download$/);
        if (logDownload && req.method === "GET") {
            const name = decodeURIComponent(logDownload[1]);
            if (!logNameAllowed(name)) return json(res, 400, { ok: false, error: "Log name is invalid." });
            const target = path.join(stateDir, name);
            if (!fs.existsSync(target)) return json(res, 404, { ok: false, error: "Log not found." });
            return streamFile(res, target, name, "text/plain; charset=utf-8");
        }
        return json(res, 404, { ok: false, error: "Not found." });
    } catch (error) {
        return json(res, 400, { ok: false, error: String(error.message || error) });
    }
});

server.listen(port, bindHost, () => process.stdout.write(`SIRK backup manager listening on ${bindHost}:${port}\n`));
setInterval(schedulerTick, 60000).unref();
setTimeout(schedulerTick, 5000).unref();

module.exports = { normalizePolicy, scheduleDue, backupNameAllowed, logNameAllowed };
