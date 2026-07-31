"use strict";

const crypto = require("node:crypto");
const os = require("node:os");

const centralOrigin = String(process.env.SIRK_CENTRAL_ORIGIN || "https://central.sirkportal.com").replace(/\/+$/, "");
const portalId = String(process.env.SIRK_PORTAL_ID || "").trim().toLowerCase();
const portalToken = String(process.env.SIRK_PORTAL_TOKEN || "");
const intervalSeconds = Math.max(30, Math.min(3600, Number(process.env.SIRK_HEARTBEAT_INTERVAL_SECONDS || 60)));

if (!/^[a-z0-9][a-z0-9-]{2,62}$/.test(portalId)) throw new Error("SIRK_PORTAL_ID is invalid.");
if (portalToken.length < 32) throw new Error("SIRK_PORTAL_TOKEN is missing or too short.");
if (!centralOrigin.startsWith("https://")) throw new Error("SIRK_CENTRAL_ORIGIN must use HTTPS.");

function authorization() {
    return "SIRK-Portal " + Buffer.from(portalId + ":" + portalToken, "utf8").toString("base64url");
}

function signature(timestamp, nonce, body) {
    return crypto.createHmac("sha256", portalToken)
        .update(String(timestamp) + "\n" + nonce + "\n" + body, "utf8")
        .digest("base64url");
}

function payload() {
    const total = os.totalmem();
    const used = Math.max(0, total - os.freemem());
    return {
        portalVersion: process.env.SIRK_PORTAL_VERSION || "development",
        buildCommit: process.env.SIRK_PORTAL_COMMIT || "",
        platform: process.platform + "-" + process.arch,
        hostname: os.hostname(),
        publicUrl: process.env.SIRK_PORTAL_PUBLIC_URL || "",
        health: process.env.SIRK_PORTAL_HEALTH || "ok",
        agentCount: Number(process.env.SIRK_AGENT_COUNT || 0),
        onlineAgents: Number(process.env.SIRK_ONLINE_AGENT_COUNT || 0),
        cpuPercent: Number(process.env.SIRK_CPU_PERCENT || 0),
        memoryUsedBytes: used,
        memoryTotalBytes: total,
        lastBackupAtUtc: process.env.SIRK_LAST_BACKUP_AT_UTC || "",
        lastBackupStatus: process.env.SIRK_LAST_BACKUP_STATUS || "unknown",
        updateChannel: process.env.SIRK_UPDATE_CHANNEL || "stable",
        availableVersion: process.env.SIRK_AVAILABLE_VERSION || "",
        capabilities: String(process.env.SIRK_PORTAL_CAPABILITIES || "heartbeat")
            .split(",").map(value => value.trim()).filter(Boolean)
    };
}

async function heartbeat() {
    const timestamp = Date.now();
    const nonce = crypto.randomBytes(18).toString("base64url");
    const body = JSON.stringify(payload());
    const response = await fetch(centralOrigin + "/api/portal/v1/heartbeat", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: authorization(),
            "X-SIRK-Timestamp": String(timestamp),
            "X-SIRK-Nonce": nonce,
            "X-SIRK-Signature": signature(timestamp, nonce, body)
        },
        body,
        signal: AbortSignal.timeout(20000)
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "Heartbeat rejected with HTTP " + response.status);
    process.stdout.write("[portal-heartbeat] accepted " + String(result.acceptedAtUtc || "") + "\n");
}

async function run() {
    try { await heartbeat(); }
    catch (error) { process.stderr.write("[portal-heartbeat] " + String(error.message || error) + "\n"); }
    setTimeout(run, intervalSeconds * 1000).unref();
}

run();
