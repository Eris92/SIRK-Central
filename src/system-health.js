"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function statSafe(filePath) {
    try {
        const stat = fs.statSync(filePath);
        return { exists: true, size: stat.size, modifiedAtUtc: stat.mtime.toISOString() };
    } catch (error) {
        if (error.code === "ENOENT") return { exists: false, size: 0, modifiedAtUtc: null };
        throw error;
    }
}

function create(options) {
    options = options || {};
    const dataDir = path.resolve(options.dataDir || path.join(process.cwd(), "data"));
    const version = String(options.version || "unknown");
    const startedAt = Date.now();

    function snapshot(extra) {
        const memory = process.memoryUsage();
        const files = [
            "sessions.json",
            "organizations.json",
            "approvals.json",
            "passkeys.json",
            "security-center.json"
        ];
        return {
            ok: true,
            status: "healthy",
            version,
            timestampUtc: new Date().toISOString(),
            process: {
                pid: process.pid,
                node: process.version,
                uptimeSeconds: Math.floor(process.uptime()),
                startedAtUtc: new Date(startedAt).toISOString(),
                rssBytes: memory.rss,
                heapUsedBytes: memory.heapUsed,
                heapTotalBytes: memory.heapTotal
            },
            host: {
                hostname: os.hostname(),
                platform: os.platform(),
                release: os.release(),
                cpuCount: os.cpus().length,
                loadAverage: os.loadavg(),
                freeMemoryBytes: os.freemem(),
                totalMemoryBytes: os.totalmem()
            },
            storage: Object.fromEntries(files.map(name => [name, statSafe(path.join(dataDir, name))])),
            dependencies: Object.assign({}, extra || {})
        };
    }

    return { snapshot };
}

module.exports = { create, statSafe };
