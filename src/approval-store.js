"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const TYPES = Object.freeze([
    "role.assignment",
    "tenant.activation",
    "portal.enrollment",
    "operation.high-risk",
    "credential.use"
]);
const STATES = Object.freeze(["pending", "approved", "rejected", "cancelled", "expired"]);

function atomicWrite(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const temporary = filePath + ".tmp-" + process.pid + "-" + crypto.randomBytes(5).toString("hex");
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, filePath);
}

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function actorKey(actor) { return String(actor && (actor.identityKey || actor.username) || "system").slice(0, 180); }
function normalizeText(value, field, max) {
    const text = String(value || "").trim().replace(/\s+/g, " ");
    if (!text || text.length > max) throw new Error(field + " is invalid.");
    return text;
}
function safeObject(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return clone(value);
}

function create(options) {
    options = options || {};
    const dataDir = path.resolve(options.dataDir || path.join(process.cwd(), "data"));
    const filePath = path.join(dataDir, "approvals.json");
    const now = typeof options.now === "function" ? options.now : Date.now;
    const id = typeof options.randomId === "function" ? options.randomId : () => "apr-" + crypto.randomBytes(12).toString("base64url").toLowerCase();
    let state = { version: 1, requests: {} };

    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
        if (parsed && parsed.version === 1 && parsed.requests) state = parsed;
    } catch (error) {
        if (error.code !== "ENOENT") throw error;
    }

    function persist() { atomicWrite(filePath, state); }
    function expire() {
        const timestamp = now();
        let changed = false;
        for (const request of Object.values(state.requests)) {
            if (request.state === "pending" && request.expiresAtUtc && Date.parse(request.expiresAtUtc) <= timestamp) {
                request.state = "expired";
                request.finishedAtUtc = new Date(timestamp).toISOString();
                changed = true;
            }
        }
        if (changed) persist();
    }

    function submit(input, actor) {
        const type = String(input && input.type || "");
        if (!TYPES.includes(type)) throw new Error("Unsupported approval type.");
        const createdAt = new Date(now()).toISOString();
        const ttlMinutes = Math.max(5, Math.min(1440, Number(input && input.ttlMinutes || 60)));
        const request = {
            id: id(),
            type,
            state: "pending",
            title: normalizeText(input && input.title, "Title", 160),
            reason: normalizeText(input && input.reason, "Reason", 1000),
            requestedBy: actorKey(actor),
            requestedAtUtc: createdAt,
            expiresAtUtc: new Date(now() + ttlMinutes * 60000).toISOString(),
            scope: safeObject(input && input.scope),
            payload: safeObject(input && input.payload),
            requiredApprovals: Math.max(1, Math.min(2, Number(input && input.requiredApprovals || 1))),
            decisions: [],
            execution: null
        };
        state.requests[request.id] = request;
        persist();
        return clone(request);
    }

    function decide(requestId, decision, actor, comment) {
        expire();
        if (!["approve", "reject"].includes(decision)) throw new Error("Unsupported approval decision.");
        const request = state.requests[String(requestId || "")];
        if (!request) throw new Error("Approval request not found.");
        if (request.state !== "pending") throw new Error("Approval request is no longer pending.");
        const reviewer = actorKey(actor);
        if (reviewer === request.requestedBy) throw new Error("Requester cannot approve their own request.");
        if (request.decisions.some(item => item.reviewer === reviewer)) throw new Error("Reviewer already decided this request.");
        request.decisions.push({ reviewer, decision, comment: String(comment || "").trim().slice(0, 1000), decidedAtUtc: new Date(now()).toISOString() });
        if (decision === "reject") request.state = "rejected";
        else if (request.decisions.filter(item => item.decision === "approve").length >= request.requiredApprovals) request.state = "approved";
        if (request.state !== "pending") request.finishedAtUtc = new Date(now()).toISOString();
        persist();
        return clone(request);
    }

    function cancel(requestId, actor) {
        expire();
        const request = state.requests[String(requestId || "")];
        if (!request) throw new Error("Approval request not found.");
        if (request.state !== "pending") throw new Error("Approval request is no longer pending.");
        if (actorKey(actor) !== request.requestedBy) throw new Error("Only the requester may cancel this request.");
        request.state = "cancelled";
        request.finishedAtUtc = new Date(now()).toISOString();
        persist();
        return clone(request);
    }

    function markExecution(requestId, execution) {
        const request = state.requests[String(requestId || "")];
        if (!request) throw new Error("Approval request not found.");
        if (request.state !== "approved") throw new Error("Only an approved request may be executed.");
        if (request.execution && request.execution.state === "completed") return clone(request.execution);
        request.execution = Object.assign({
            executed: true,
            state: "completed",
            executedAtUtc: new Date(now()).toISOString()
        }, safeObject(execution));
        persist();
        return clone(request.execution);
    }

    function list(filter) {
        expire();
        filter = filter || {};
        return Object.values(state.requests)
            .filter(item => !filter.state || item.state === filter.state)
            .filter(item => !filter.type || item.type === filter.type)
            .sort((a, b) => b.requestedAtUtc.localeCompare(a.requestedAtUtc))
            .map(clone);
    }

    function get(requestId) {
        expire();
        const request = state.requests[String(requestId || "")];
        return request ? clone(request) : null;
    }

    return { submit, decide, cancel, markExecution, list, get, expire, filePath, TYPES, STATES };
}

module.exports = { create, TYPES, STATES };
