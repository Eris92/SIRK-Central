"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");

const bindHost = process.env.SIRK_UPDATER_BIND_HOST || "0.0.0.0";
const port = Number(process.env.SIRK_UPDATER_PORT || 8090);
const token = String(process.env.SIRK_UPDATER_TOKEN || "");
const script = process.env.SIRK_UPDATER_SCRIPT || "/opt/sirk-central/deploy/web-update.sh";
const stateDir = process.env.SIRK_UPDATER_STATE_DIR || "/var/lib/sirk-updater";
const statusPath = path.join(stateDir, "status.json");
let child = null;

if (token.length < 43) throw new Error("SIRK_UPDATER_TOKEN must contain at least 43 characters.");
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("SIRK_UPDATER_PORT is invalid.");
fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });

function safeEqual(a, b) {
    const left = Buffer.from(String(a || ""));
    const right = Buffer.from(String(b || ""));
    return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function authorized(req) {
    const match = String(req.headers.authorization || "").match(/^Bearer (.+)$/);
    return Boolean(match && safeEqual(match[1], token));
}

function writeStatus(value) {
    const temporary = statusPath + ".tmp";
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(temporary, statusPath);
}

function readStatus() {
    try { return JSON.parse(fs.readFileSync(statusPath, "utf8")); }
    catch (_) { return { state: "idle", running: false }; }
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

function readBody(req, limit = 8192) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on("data", chunk => {
            size += chunk.length;
            if (size > limit) {
                reject(new Error("Request body is too large."));
                req.destroy();
            } else chunks.push(chunk);
        });
        req.on("end", () => {
            try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
            catch (_) { reject(new Error("Invalid JSON body.")); }
        });
        req.on("error", reject);
    });
}

const server = http.createServer(async (req, res) => {
    try {
        const url = new URL(req.url, "http://updater.local");
        if (url.pathname === "/healthz" && req.method === "GET") return json(res, 200, { ok: true });
        if (!authorized(req)) return json(res, 404, { ok: false, error: "Not found." });

        if (url.pathname === "/status" && req.method === "GET") {
            const status = readStatus();
            status.running = Boolean(child && child.exitCode === null);
            return json(res, 200, { ok: true, status });
        }

        if (url.pathname === "/run" && req.method === "POST") {
            if (child && child.exitCode === null) return json(res, 409, { ok: false, error: "An update is already running." });
            const body = await readBody(req);
            if (body.confirm !== "UPDATE SIRK CENTRAL") return json(res, 400, { ok: false, error: "Update confirmation is invalid." });

            const startedAtUtc = new Date().toISOString();
            writeStatus({ state: "starting", running: true, startedAtUtc, requestedBy: String(body.requestedBy || "unknown").slice(0, 200) });
            child = spawn("/usr/bin/env", ["bash", script], {
                cwd: "/opt/sirk-central",
                env: Object.assign({}, process.env, {
                    SIRK_UPDATE_REQUESTED_BY: String(body.requestedBy || "unknown").slice(0, 200),
                    SIRK_UPDATE_STARTED_AT: startedAtUtc
                }),
                stdio: ["ignore", "ignore", "ignore"]
            });
            child.once("error", error => writeStatus({ state: "failed", running: false, startedAtUtc, finishedAtUtc: new Date().toISOString(), error: String(error.message || error) }));
            child.once("exit", code => {
                const current = readStatus();
                if (current.state === "running" || current.state === "starting") {
                    writeStatus(Object.assign({}, current, { state: code === 0 ? "completed" : "failed", running: false, finishedAtUtc: new Date().toISOString(), exitCode: code }));
                }
                child = null;
            });
            return json(res, 202, { ok: true, accepted: true, startedAtUtc });
        }

        return json(res, 404, { ok: false, error: "Not found." });
    } catch (error) {
        return json(res, 400, { ok: false, error: String(error.message || error) });
    }
});

server.listen(port, bindHost, () => process.stdout.write(`SIRK updater listening on ${bindHost}:${port}\n`));
