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
function command(name, args, cwd = installDir) {
    const result = spawnSync(name, args, { cwd, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
    if (result.status !== 0) throw new Error(String(result.stderr || result.stdout || result.error || name + " failed").trim());
    return String(result.stdout || "").trim();
}
function readJson(filePath, fallback) {
    try { return JSON.parse(fs.readFileSync(filePath, "utf8")); }
    catch (error) { if (error.code === "ENOENT") return fallback; throw error; }
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

const originalListeners = runtime.server.listeners("request");
runtime.server.removeAllListeners("request");
runtime.server.on("request", async (req, res) => {
    try {
        const url = new URL(req.url, "http://updater.local");
        if (req.method === "GET" && url.pathname === "/appliance/status") {
            if (!authorized(req)) return json(res, 404, { ok: false, error: "Not found." });
            return json(res, 200, status());
        }
        for (const listener of originalListeners) {
            const result = listener.call(runtime.server, req, res);
            if (result && typeof result.then === "function") await result;
            if (res.writableEnded || res.headersSent) return;
        }
    } catch (error) {
        if (!res.headersSent) return json(res, 500, { ok: false, error: "Internal appliance diagnostics error." });
        res.destroy(error);
    }
});

if (require.main === module) {
    const host = process.env.SIRK_UPDATER_BIND_HOST || "0.0.0.0";
    const port = Number(process.env.SIRK_UPDATER_PORT || 8090);
    runtime.server.listen(port, host, () => process.stdout.write(`SIRK appliance worker listening on ${host}:${port}\n`));
}

module.exports = { status, containers, storage };
