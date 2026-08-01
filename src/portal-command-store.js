"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const TYPES = Object.freeze(["backup", "update", "restart", "reconnect", "sync", "diagnostics"]);
const STATES = Object.freeze(["queued", "delivered", "running", "cancel_requested", "completed", "failed", "cancelled", "expired"]);
const ACTIVE_STATES = new Set(["queued", "delivered", "running", "cancel_requested"]);
const TERMINAL_STATES = new Set(["completed", "failed", "cancelled", "expired"]);

function atomicWrite(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const temporary = filePath + ".tmp-" + process.pid + "-" + crypto.randomBytes(5).toString("hex");
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, filePath);
}
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function clean(value, max) { return String(value || "").trim().replace(/[\r\n\t]+/g, " ").slice(0, max); }
function numeric(value, fallback, minimum, maximum) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.max(minimum, Math.min(maximum, number));
}
function storeError(message, code, statusCode = 400) {
    return Object.assign(new Error(message), { code, statusCode });
}
function cleanPayload(value, depth = 0) {
    if (depth > 4) return "[depth-limit]";
    if (value === null || value === undefined) return value;
    if (typeof value === "string") return clean(value, 2000);
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value === "boolean") return value;
    if (Array.isArray(value)) return value.slice(0, 100).map(item => cleanPayload(item, depth + 1));
    if (typeof value === "object") {
        const result = Object.create(null);
        for (const [rawKey, item] of Object.entries(value).slice(0, 100)) {
            const key = clean(rawKey, 100);
            if (!key || ["__proto__", "prototype", "constructor"].includes(key)) continue;
            if (/secret|password|token|credential|authorization|cookie|private.?key/i.test(key)) result[key] = "[redacted]";
            else result[key] = cleanPayload(item, depth + 1);
        }
        return result;
    }
    return clean(value, 200);
}
function portalSet(filter) {
    return Array.isArray(filter && filter.portalIds) ? new Set(filter.portalIds.map(value => String(value).toLowerCase())) : null;
}
function matches(command, filter, allowedPortals) {
    return (!allowedPortals || allowedPortals.has(command.portalId))
        && (!filter.portalId || command.portalId === filter.portalId)
        && (!filter.state || command.state === filter.state)
        && (!filter.type || command.type === filter.type);
}

function create(options = {}) {
    const dataDir = path.resolve(options.dataDir || path.join(process.cwd(), "data"));
    const filePath = path.join(dataDir, "portal-commands.json");
    const now = typeof options.now === "function" ? options.now : Date.now;
    const randomId = typeof options.randomId === "function" ? options.randomId : () => "cmd-" + crypto.randomBytes(12).toString("base64url").toLowerCase();
    const maxCommands = Math.round(numeric(options.maxCommands, 10000, 100, 100000));
    const maxActivePerPortal = Math.round(numeric(options.maxActivePerPortal, 50, 1, 1000));
    const deliveryLeaseMs = Math.round(numeric(options.deliveryLeaseMs, 60000, 5000, 3600000));
    const cancellationLeaseMs = Math.round(numeric(options.cancellationLeaseMs, 15000, 1000, 300000));
    let state = { version: 2, commands: {} };

    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
        if (!parsed || parsed.version !== 2 || !parsed.commands || typeof parsed.commands !== "object") {
            throw storeError("Unsupported portal command store schema.", "COMMAND_STORE_SCHEMA_UNSUPPORTED", 500);
        }
        state = { version: 2, commands: parsed.commands };
    } catch (error) {
        if (error.code !== "ENOENT") throw error;
    }

    function persist() { atomicWrite(filePath, state); }
    function expire() {
        const timestamp = now();
        let changed = false;
        for (const command of Object.values(state.commands)) {
            if (ACTIVE_STATES.has(command.state) && Date.parse(command.expiresAtUtc) <= timestamp) {
                command.state = "expired";
                command.finishedAtUtc = new Date(timestamp).toISOString();
                changed = true;
            }
        }
        if (changed) persist();
    }
    function trim() {
        const commands = Object.values(state.commands).sort((a, b) => a.createdAtUtc.localeCompare(b.createdAtUtc));
        const removable = commands.filter(item => TERMINAL_STATES.has(item.state));
        while (Object.keys(state.commands).length > maxCommands && removable.length) delete state.commands[removable.shift().id];
    }
    function nextId() {
        for (let attempt = 0; attempt < 10; attempt += 1) {
            const candidate = clean(randomId(), 100).toLowerCase();
            if (/^cmd-[a-z0-9_-]+$/.test(candidate) && !state.commands[candidate]) return candidate;
        }
        throw storeError("Could not allocate a unique command id.", "COMMAND_ID_COLLISION", 503);
    }
    function enqueue(input, actor) {
        expire();
        const portalId = clean(input && input.portalId, 63).toLowerCase();
        if (!/^[a-z0-9][a-z0-9-]{2,62}$/.test(portalId)) throw storeError("Portal ID is invalid.", "PORTAL_ID_INVALID");
        const type = clean(input && input.type, 40);
        if (!TYPES.includes(type)) throw storeError("Unsupported command type.", "COMMAND_TYPE_INVALID");
        const activeCount = Object.values(state.commands).filter(item => item.portalId === portalId && ACTIVE_STATES.has(item.state)).length;
        if (activeCount >= maxActivePerPortal) throw storeError("Portal has too many active commands.", "PORTAL_COMMAND_LIMIT", 429);
        const timestamp = now();
        const ttlMinutes = numeric(input && input.ttlMinutes, 60, 5, 1440);
        const command = {
            id: nextId(),
            portalId,
            type,
            state: "queued",
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
        trim();
        persist();
        return clone(command);
    }
    function deliver(portalId, limit = 20) {
        expire();
        const timestamp = now();
        const timestampUtc = new Date(timestamp).toISOString();
        const commands = Object.values(state.commands)
            .filter(item => item.portalId === portalId && (
                item.state === "queued" ||
                (item.state === "delivered" && (!item.deliveredAtUtc || Date.parse(item.deliveredAtUtc) <= timestamp - deliveryLeaseMs)) ||
                (item.state === "cancel_requested" && (!item.cancelNoticeAtUtc || Date.parse(item.cancelNoticeAtUtc) <= timestamp - cancellationLeaseMs))
            ))
            .sort((a, b) => {
                if (a.state === "cancel_requested" && b.state !== "cancel_requested") return -1;
                if (b.state === "cancel_requested" && a.state !== "cancel_requested") return 1;
                return a.createdAtUtc.localeCompare(b.createdAtUtc);
            })
            .slice(0, Math.round(numeric(limit, 20, 1, 100)));
        for (const command of commands) {
            if (command.state === "cancel_requested") {
                command.cancelNoticeAtUtc = timestampUtc;
                command.cancelNoticeAttempts = Number(command.cancelNoticeAttempts || 0) + 1;
            } else {
                command.state = "delivered";
                command.deliveredAtUtc = timestampUtc;
                command.attempts = Number(command.attempts || 0) + 1;
            }
        }
        if (commands.length) persist();
        return commands.map(item => {
            const output = clone(item);
            if (output.state === "cancel_requested") output.control = "cancel";
            return output;
        });
    }
    function acknowledge(portalId, commandId, input) {
        expire();
        const command = state.commands[String(commandId || "")];
        if (!command || command.portalId !== portalId) throw storeError("Command not found.", "COMMAND_NOT_FOUND", 404);
        const next = clean(input && input.state, 20);
        if (!["running", "completed", "failed", "cancelled"].includes(next)) throw storeError("Unsupported command acknowledgement state.", "COMMAND_ACK_STATE_INVALID");
        if (TERMINAL_STATES.has(command.state)) {
            if (command.state !== next) throw storeError("Command already reached a different terminal state.", "COMMAND_ACK_CONFLICT", 409);
            return clone(command);
        }
        if (!["delivered", "running", "cancel_requested"].includes(command.state)) throw storeError("Command has not been delivered or is no longer active.", "COMMAND_ACK_OUT_OF_ORDER", 409);
        if (next === "cancelled" && command.state !== "cancel_requested") {
            throw storeError("Portal cannot cancel a command unless Central requested cancellation.", "COMMAND_CANCEL_NOT_REQUESTED", 409);
        }

        const timestampUtc = new Date(now()).toISOString();
        const defaultProgress = next === "completed" ? 100 : command.progress || 0;
        command.progress = Math.round(numeric(input && input.progress, defaultProgress, 0, 100));
        command.message = clean(input && input.message, 1000);
        command.result = cleanPayload(input && input.result || {});
        command.lastAckAtUtc = timestampUtc;

        if (command.state === "cancel_requested" && next === "running") {
            if (!command.startedAtUtc) command.startedAtUtc = timestampUtc;
            persist();
            return clone(command);
        }

        command.state = next;
        if (next === "running" && !command.startedAtUtc) command.startedAtUtc = timestampUtc;
        if (["completed", "failed", "cancelled"].includes(next)) command.finishedAtUtc = timestampUtc;
        persist();
        return clone(command);
    }
    function cancel(commandId, actor) {
        expire();
        const command = state.commands[String(commandId || "")];
        if (!command) throw storeError("Command not found.", "COMMAND_NOT_FOUND", 404);
        if (command.state === "cancel_requested") return clone(command);
        if (command.state === "queued") {
            command.state = "cancelled";
            command.cancelledAtUtc = new Date(now()).toISOString();
            command.cancelledBy = clean(actor && (actor.identityKey || actor.username), 180) || "system";
            command.finishedAtUtc = command.cancelledAtUtc;
            persist();
            return clone(command);
        }
        if (["delivered", "running"].includes(command.state)) {
            command.state = "cancel_requested";
            command.cancelRequestedAtUtc = new Date(now()).toISOString();
            command.cancelRequestedBy = clean(actor && (actor.identityKey || actor.username), 180) || "system";
            command.cancelNoticeAtUtc = null;
            command.cancelNoticeAttempts = 0;
            persist();
            return clone(command);
        }
        throw storeError("A terminal command cannot be cancelled.", "COMMAND_CANCEL_INVALID", 409);
    }
    function retry(commandId, actor, input = {}) {
        expire();
        const source = state.commands[String(commandId || "")];
        if (!source) throw storeError("Command not found.", "COMMAND_NOT_FOUND", 404);
        if (!["failed", "expired", "cancelled"].includes(source.state)) throw storeError("Only failed, expired or cancelled commands can be retried.", "COMMAND_RETRY_INVALID", 409);
        return enqueue({
            portalId: source.portalId,
            type: source.type,
            payload: source.payload,
            approvalId: clean(input.approvalId, 80),
            ttlMinutes: numeric(input.ttlMinutes, 60, 5, 1440)
        }, actor);
    }
    function list(filter = {}) {
        expire();
        const allowedPortals = portalSet(filter);
        return Object.values(state.commands)
            .filter(item => matches(item, filter, allowedPortals))
            .sort((a, b) => b.createdAtUtc.localeCompare(a.createdAtUtc))
            .slice(0, Math.round(numeric(filter.limit, 200, 1, 1000)))
            .map(clone);
    }
    function summary(filter = {}) {
        expire();
        const allowedPortals = portalSet(filter);
        const counts = Object.fromEntries(STATES.map(stateName => [stateName, 0]));
        let total = 0;
        for (const command of Object.values(state.commands)) {
            if (!matches(command, filter, allowedPortals)) continue;
            counts[command.state] = (counts[command.state] || 0) + 1;
            total += 1;
        }
        return { counts, active: counts.queued + counts.delivered + counts.running + counts.cancel_requested, total };
    }
    function get(commandId) {
        expire();
        const value = state.commands[String(commandId || "")];
        return value ? clone(value) : null;
    }

    return { enqueue, deliver, acknowledge, cancel, retry, list, get, summary, expire, filePath, TYPES, STATES };
}

module.exports = { create, TYPES, STATES, cleanPayload, matches };
