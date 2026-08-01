"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function atomicWrite(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const temporary = filePath + ".tmp-" + process.pid + "-" + crypto.randomBytes(6).toString("hex");
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, filePath);
}

function cleanText(value, limit = 200) {
    return String(value == null ? "" : value)
        .replace(/[\u0000-\u001f\u007f]/g, " ")
        .trim()
        .slice(0, limit);
}

function finiteNumber(value, minimum, maximum, fallback = 0) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.max(minimum, Math.min(maximum, number));
}

function finiteInteger(value, minimum, maximum, fallback) {
    return Math.round(finiteNumber(value, minimum, maximum, fallback));
}

function optionNumber(value, fallback, minimum, maximum) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.max(minimum, Math.min(maximum, number));
}

function optionalIso(value) {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function cleanPublicUrl(value) {
    const input = cleanText(value, 500);
    if (!input) return "";
    try {
        const url = new URL(input);
        if (url.protocol !== "https:" || url.username || url.password) return "";
        url.hash = "";
        return url.toString().slice(0, 500);
    } catch (_) { return ""; }
}

function timingSafeText(left, right) {
    const a = Buffer.from(String(left || ""));
    const b = Buffer.from(String(right || ""));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function canonicalPayload(timestamp, nonce, rawBody) {
    return String(timestamp) + "\n" + String(nonce) + "\n" + String(rawBody || "");
}

function sign(token, timestamp, nonce, rawBody) {
    return crypto.createHmac("sha256", String(token || ""))
        .update(canonicalPayload(timestamp, nonce, rawBody), "utf8")
        .digest("base64url");
}

function verifySignature(token, timestamp, nonce, rawBody, supplied) {
    return timingSafeText(sign(token, timestamp, nonce, rawBody), supplied);
}

function normalizeHeartbeat(input) {
    input = input && typeof input === "object" && !Array.isArray(input) ? input : {};
    const health = ["ok", "warning", "critical"].includes(input.health) ? input.health : "warning";
    const agentCount = finiteInteger(input.agentCount, 0, 10000000, 0);
    const onlineAgents = Math.min(agentCount, finiteInteger(input.onlineAgents, 0, 10000000, 0));
    const memoryTotalBytes = finiteInteger(input.memoryTotalBytes, 0, Number.MAX_SAFE_INTEGER, 0);
    const memoryUsedBytes = Math.min(memoryTotalBytes || Number.MAX_SAFE_INTEGER, finiteInteger(input.memoryUsedBytes, 0, Number.MAX_SAFE_INTEGER, 0));
    return {
        protocolVersion: finiteInteger(input.protocolVersion, 1, 1000, 1),
        portalVersion: cleanText(input.portalVersion, 80),
        buildCommit: cleanText(input.buildCommit || input.commit, 80),
        platform: cleanText(input.platform, 120),
        hostname: cleanText(input.hostname, 160),
        publicUrl: cleanPublicUrl(input.publicUrl),
        health,
        agentCount,
        onlineAgents,
        cpuPercent: finiteNumber(input.cpuPercent, 0, 100, 0),
        memoryUsedBytes,
        memoryTotalBytes,
        lastBackupAtUtc: optionalIso(input.lastBackupAtUtc),
        lastBackupStatus: ["ok", "failed", "unknown"].includes(input.lastBackupStatus) ? input.lastBackupStatus : "unknown",
        updateChannel: cleanText(input.updateChannel, 80),
        availableVersion: cleanText(input.availableVersion, 80),
        capabilities: Array.isArray(input.capabilities)
            ? [...new Set(input.capabilities.map(value => cleanText(value, 100)).filter(Boolean))].slice(0, 100)
            : []
    };
}

function create(options) {
    options = options || {};
    const dataDir = path.resolve(options.dataDir || path.join(process.cwd(), "data"));
    const filePath = path.join(dataDir, "portal-telemetry.json");
    const now = typeof options.now === "function" ? options.now : Date.now;
    const onlineAfterMs = optionNumber(options.onlineAfterMs, 180000, 30000, 3600000);
    const maximumClockSkewMs = optionNumber(options.maximumClockSkewMs, 300000, 30000, 900000);
    const maxNoncesPerPortal = Math.round(optionNumber(options.maxNoncesPerPortal, 1000, 100, 10000));
    let state = { schema: 1, portals: {} };

    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
        if (!parsed || parsed.schema !== 1 || !parsed.portals || typeof parsed.portals !== "object") throw new Error("Portal telemetry store has an unsupported schema.");
        state = parsed;
    } catch (error) {
        if (error.code !== "ENOENT") throw error;
    }

    function persist() { atomicWrite(filePath, state); }

    function accept(portal, envelope) {
        const timestamp = Number(envelope.timestamp);
        const nonce = cleanText(envelope.nonce, 200);
        const rawBody = String(envelope.rawBody || "");
        const signature = cleanText(envelope.signature, 200);
        const token = String(envelope.token || "");
        const currentTime = now();

        if (!Number.isSafeInteger(timestamp) || Math.abs(currentTime - timestamp) > maximumClockSkewMs) {
            throw Object.assign(new Error("Heartbeat timestamp is outside the accepted window."), { code: "HEARTBEAT_STALE", statusCode: 401 });
        }
        if (!/^[A-Za-z0-9_-]{16,200}$/.test(nonce)) {
            throw Object.assign(new Error("Heartbeat nonce is invalid."), { code: "HEARTBEAT_NONCE_INVALID", statusCode: 400 });
        }
        if (!/^[A-Za-z0-9_-]{43}$/.test(signature) || !verifySignature(token, timestamp, nonce, rawBody, signature)) {
            throw Object.assign(new Error("Heartbeat signature is invalid."), { code: "HEARTBEAT_SIGNATURE_INVALID", statusCode: 401 });
        }

        const previous = state.portals[portal.id] || { nonces: [] };
        const activeNonces = (Array.isArray(previous.nonces) ? previous.nonces : [])
            .filter(item => item && Number(item.expiresAt) > currentTime && typeof item.value === "string");
        if (activeNonces.some(item => item.value === nonce)) {
            throw Object.assign(new Error("Heartbeat nonce was already used."), { code: "HEARTBEAT_REPLAY", statusCode: 409 });
        }
        if (activeNonces.length >= maxNoncesPerPortal) {
            throw Object.assign(new Error("Heartbeat replay cache is at capacity."), { code: "HEARTBEAT_NONCE_CAPACITY", statusCode: 429 });
        }

        let body;
        try { body = JSON.parse(rawBody || "{}"); }
        catch (_) { throw Object.assign(new Error("Heartbeat body is invalid JSON."), { code: "HEARTBEAT_BODY_INVALID", statusCode: 400 }); }
        if (!body || typeof body !== "object" || Array.isArray(body)) {
            throw Object.assign(new Error("Heartbeat body must be a JSON object."), { code: "HEARTBEAT_BODY_INVALID", statusCode: 400 });
        }

        activeNonces.push({ value: nonce, expiresAt: currentTime + maximumClockSkewMs });
        const metrics = normalizeHeartbeat(body);
        state.portals[portal.id] = {
            id: portal.id,
            name: portal.name,
            firstSeenAtUtc: previous.firstSeenAtUtc || new Date(currentTime).toISOString(),
            lastSeenAtUtc: new Date(currentTime).toISOString(),
            lastRemoteTimestampUtc: new Date(timestamp).toISOString(),
            heartbeatCount: Number(previous.heartbeatCount || 0) + 1,
            metrics,
            nonces: activeNonces
        };
        persist();
        return publicRecord(state.portals[portal.id]);
    }

    function publicRecord(record) {
        if (!record) return null;
        const lastSeen = Date.parse(record.lastSeenAtUtc || "");
        const ageMs = Number.isFinite(lastSeen) ? Math.max(0, now() - lastSeen) : null;
        return {
            id: record.id,
            name: record.name,
            status: ageMs !== null && ageMs <= onlineAfterMs ? "online" : "offline",
            ageSeconds: ageMs === null ? null : Math.floor(ageMs / 1000),
            firstSeenAtUtc: record.firstSeenAtUtc || null,
            lastSeenAtUtc: record.lastSeenAtUtc || null,
            lastRemoteTimestampUtc: record.lastRemoteTimestampUtc || null,
            heartbeatCount: Number(record.heartbeatCount || 0),
            metrics: normalizeHeartbeat(record.metrics || {})
        };
    }

    function get(id) { return publicRecord(state.portals[String(id || "").toLowerCase()]); }

    function list(registry) {
        const known = new Map((Array.isArray(registry) ? registry : []).map(item => [item.id, item]));
        const ids = new Set([...known.keys(), ...Object.keys(state.portals)]);
        return [...ids].sort().map(id => {
            const registered = known.get(id);
            const telemetry = publicRecord(state.portals[id]);
            if (telemetry) return Object.assign({}, telemetry, { name: registered && registered.name || telemetry.name, registered: Boolean(registered) });
            return {
                id,
                name: registered && registered.name || id,
                registered: Boolean(registered),
                status: "never",
                ageSeconds: null,
                firstSeenAtUtc: null,
                lastSeenAtUtc: null,
                lastRemoteTimestampUtc: null,
                heartbeatCount: 0,
                metrics: normalizeHeartbeat({})
            };
        });
    }

    function remove(id) {
        const key = String(id || "").toLowerCase();
        if (!state.portals[key]) return false;
        delete state.portals[key];
        persist();
        return true;
    }

    return { accept, get, list, remove, filePath, onlineAfterMs, maximumClockSkewMs, maxNoncesPerPortal };
}

module.exports = { create, sign, verifySignature, canonicalPayload, normalizeHeartbeat, cleanPublicUrl, optionalIso };
