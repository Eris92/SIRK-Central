"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const TYPES = Object.freeze(["backup", "update", "restart", "reconnect", "sync", "diagnostics"]);
const STATES = Object.freeze(["queued", "delivered", "running", "completed", "failed", "cancelled", "expired"]);

function atomicWrite(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const temporary = filePath + ".tmp-" + process.pid + "-" + crypto.randomBytes(5).toString("hex");
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, filePath);
}
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function clean(value, max) { return String(value || "").trim().replace(/[\r\n\t]+/g, " ").slice(0, max); }
function cleanPayload(value, depth = 0) {
    if (depth > 4) return "[depth-limit]";
    if (value === null || value === undefined) return value;
    if (typeof value === "string") return clean(value, 2000);
    if (typeof value === "number" || typeof value === "boolean") return value;
    if (Array.isArray(value)) return value.slice(0, 100).map(item => cleanPayload(item, depth + 1));
    if (typeof value === "object") {
        const result = {};
        for (const [key, item] of Object.entries(value).slice(0, 100)) {
            if (/secret|password|token|credential|authorization/i.test(key)) result[clean(key, 100)] = "[redacted]";
            else result[clean(key, 100)] = cleanPayload(item, depth + 1);
        }
        return result;
    }
    return clean(value, 200);
}

function create(options) {
    options = options || {};
    const dataDir = path.resolve(options.dataDir || path.join(process.cwd(), "data"));
    const filePath = path.join(dataDir, "portal-commands.json");
    const now = typeof options.now === "function" ? options.now : Date.now;
    const randomId = typeof options.randomId === "function" ? options.randomId : () => "cmd-" + crypto.randomBytes(12).toString("base64url").toLowerCase();
    const maxCommands = Math.max(100, Math.min(100000, Number(options.maxCommands || 10000)));
    let state = { version: 1, commands: {} };

    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
        if (parsed && parsed.version === 1 && parsed.commands && typeof parsed.commands === "object") state = parsed;
    } catch (error) {
        if (error.code !== "ENOENT") throw error;
    }

    function persist() { atomicWrite(filePath, state); }
    function expire() {
        const timestamp = now();
        let changed = false;
        for (const command of Object.values(state.commands)) {
            if (["queued", "delivered", "running"].includes(command.state) && Date.parse(command.expiresAtUtc) <= timestamp) {
                command.state = "expired";
                command.finishedAtUtc = new Date(timestamp).toISOString();
                changed = true;
            }
        }
        if (changed) persist();
    }
    function trim() {
        const commands = Object.values(state.commands).sort((a, b) => a.createdAtUtc.localeCompare(b.createdAtUtc));
        const removable = commands.filter(item => ["completed", "failed", "cancelled", "expired"].includes(item.state));
        while (Object.keys(state.commands).length > maxCommands && removable.length) delete state.commands[removable.shift().id];
    }
    function enqueue(input, actor) {
        const portalId = clean(input && input.portalId, 63).toLowerCase();
        if (!/^[a-z0-9][a-z0-9-]{2,62}$/.test(portalId)) throw new Error("Portal ID is invalid.");
        const type = clean(input && input.type, 40);
        if (!TYPES.includes(type)) throw new Error("Unsupported command type.");
        const timestamp = now();
        const ttlMinutes = Math.max(5, Math.min(1440, Number(input && input.ttlMinutes || 60)));
        const command = {
            id: randomId(), portalId, type, state: "queued",
            payload: cleanPayload(input && input.payload || {}),
            requestedBy: clean(actor && (actor.identityKey || actor.username), 180) || "system",
            approvalId: clean(input && input.approvalId, 80),
            createdAtUtc: new Date(timestamp).toISOString(),
            expiresAtUtc: new Date(timestamp + ttlMinutes * 60000).toISOString(),
            attempts: 0,
            progress: 0,
            message: ""
        };
        state.commands[command.id] = command;
        trim(); persist();
        return clone(command);
    }
    function deliver(portalId, limit = 20) {
        expire();
        const timestamp = new Date(now()).toISOString();
        const commands = Object.values(state.commands)
            .filter(item => item.portalId === portalId && item.state === "queued")
            .sort((a, b) => a.createdAtUtc.localeCompare(b.createdAtUtc))
            .slice(0, Math.max(1, Math.min(100, Number(limit || 20))));
        for (const command of commands) {
            command.state = "delivered";
            command.deliveredAtUtc = timestamp;
            command.attempts += 1;
        }
        if (commands.length) persist();
        return commands.map(clone);
    }
    function acknowledge(portalId, commandId, input) {
        expire();
        const command = state.commands[String(commandId || "")];
        if (!command || command.portalId !== portalId) throw new Error("Command not found.");
        if (["cancelled", "expired"].includes(command.state)) throw new Error("Command is no longer active.");
        const next = clean(input && input.state, 20);
        if (!["running", "completed", "failed"].includes(next)) throw new Error("Unsupported command acknowledgement state.");
        if (command.state === "completed" || command.state === "failed") return clone(command);
        command.state = next;
        command.progress = Math.max(0, Math.min(100, Number(input && input.progress || (next === "completed" ? 100 : 0))));
        command.message = clean(input && input.message, 1000);
        command.result = cleanPayload(input && input.result || {});
        command.lastAckAtUtc = new Date(now()).toISOString();
        if (next === "running" && !command.startedAtUtc) command.startedAtUtc = command.lastAckAtUtc;
        if (next === "completed" || next === "failed") command.finishedAtUtc = command.lastAckAtUtc;
        persist();
        return clone(command);
    }
    function cancel(commandId, actor) {
        expire();
        const command = state.commands[String(commandId || "")];
        if (!command) throw new Error("Command not found.");
        if (!["queued", "delivered"].includes(command.state)) throw new Error("Only a queued or delivered command can be cancelled.");
        command.state = "cancelled";
        command.cancelledAtUtc = new Date(now()).toISOString();
        command.cancelledBy = clean(actor && (actor.identityKey || actor.username), 180) || "system";
        command.finishedAtUtc = command.cancelledAtUtc;
        persist();
        return clone(command);
    }
    function retry(commandId, actor) {
        expire();
        const source = state.commands[String(commandId || "")];
        if (!source) throw new Error("Command not found.");
        if (!["failed", "expired", "cancelled"].includes(source.state)) throw new Error("Only failed, expired or cancelled commands can be retried.");
        return enqueue({ portalId: source.portalId, type: source.type, payload: source.payload, approvalId: source.approvalId, ttlMinutes: 60 }, actor);
    }
    function list(filter) {
        expire(); filter = filter || {};
        return Object.values(state.commands)
            .filter(item => !filter.portalId || item.portalId === filter.portalId)
            .filter(item => !filter.state || item.state === filter.state)
            .filter(item => !filter.type || item.type === filter.type)
            .sort((a, b) => b.createdAtUtc.localeCompare(a.createdAtUtc))
            .slice(0, Math.max(1, Math.min(1000, Number(filter.limit || 200))))
            .map(clone);
    }
    function summary() {
        expire();
        const counts = {};
        for (const stateName of STATES) counts[stateName] = 0;
        for (const command of Object.values(state.commands)) counts[command.state] = (counts[command.state] || 0) + 1;
        return { counts, active: counts.queued + counts.delivered + counts.running, total: Object.keys(state.commands).length };
    }
    function get(commandId) { expire(); const value = state.commands[String(commandId || "")]; return value ? clone(value) : null; }

    return { enqueue, deliver, acknowledge, cancel, retry, list, get, summary, expire, filePath, TYPES, STATES };
}

module.exports = { create, TYPES, STATES };
