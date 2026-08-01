"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

require("./appliance-server");
const runtime = require("./server");

const token = String(process.env.SIRK_UPDATER_TOKEN || "");
const stateDir = path.resolve(process.env.SIRK_UPDATER_STATE_DIR || "/var/lib/sirk-updater");
const backupDir = path.resolve(process.env.SIRK_BACKUP_DIR || path.join(stateDir, "backups"));
const encryptedNamePattern = /^sirk-central-\d{8}T\d{6}Z\.tar\.gz\.age$/;

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
function encryptedBackupPath(name) {
    if (!encryptedNamePattern.test(String(name || ""))) throw Object.assign(new Error("Encrypted backup name is invalid."), { statusCode: 400 });
    const target = path.resolve(backupDir, name);
    if (path.dirname(target) !== backupDir) throw Object.assign(new Error("Encrypted backup path is invalid."), { statusCode: 400 });
    const stat = fs.statSync(target);
    if (!stat.isFile() || stat.size < 1) throw Object.assign(new Error("Encrypted backup was not found."), { statusCode: 404 });
    return { target, stat };
}

const originalListeners = runtime.server.listeners("request");
runtime.server.removeAllListeners("request");
runtime.server.on("request", async (req, res) => {
    try {
        const url = new URL(req.url, "http://updater.local");
        const match = url.pathname.match(/^\/backup\/file\/([^/]+)$/);
        if (req.method === "GET" && match) {
            if (!authorized(req)) return json(res, 404, { ok: false, error: "Not found." });
            const name = decodeURIComponent(match[1]);
            const file = encryptedBackupPath(name);
            res.writeHead(200, {
                "Content-Type": "application/octet-stream",
                "Content-Length": String(file.stat.size),
                "Content-Disposition": `attachment; filename="${name}"`,
                "Cache-Control": "no-store, private",
                "X-Content-Type-Options": "nosniff",
                "X-Frame-Options": "DENY",
                "Referrer-Policy": "no-referrer"
            });
            const stream = fs.createReadStream(file.target, { flags: "r" });
            stream.on("error", error => res.destroy(error));
            stream.pipe(res);
            return;
        }
        for (const listener of originalListeners) {
            const result = listener.call(runtime.server, req, res);
            if (result && typeof result.then === "function") await result;
            if (res.writableEnded || res.headersSent) return;
        }
    } catch (error) {
        if (!res.headersSent) return json(res, Number.isInteger(error.statusCode) ? error.statusCode : 500, {
            ok: false,
            error: Number.isInteger(error.statusCode) && error.statusCode < 500 ? error.message : "Internal backup download error."
        });
        res.destroy(error);
    }
});

if (require.main === module) {
    const host = process.env.SIRK_UPDATER_BIND_HOST || "0.0.0.0";
    const port = Number(process.env.SIRK_UPDATER_PORT || 8090);
    runtime.server.listen(port, host, () => process.stdout.write(`SIRK appliance worker with encrypted download listening on ${host}:${port}\n`));
}

module.exports = { encryptedBackupPath };
