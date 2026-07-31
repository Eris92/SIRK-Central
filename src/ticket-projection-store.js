"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const STATUSES = Object.freeze(["new", "accepted", "in_progress", "waiting_for_user", "waiting_for_external", "resolved", "closed", "cancelled"]);
const PRIORITIES = Object.freeze(["low", "normal", "high", "critical"]);
const SYNC_STATES = Object.freeze(["local", "pending", "synchronized", "conflict", "failed"]);
const EVENTS = Object.freeze(["ticket.created", "ticket.updated", "ticket.status_changed", "ticket.assigned", "ticket.comment_added", "ticket.sla_breached", "ticket.closed", "ticket.sync_failed"]);

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function atomicWrite(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const temporary = filePath + ".tmp-" + process.pid + "-" + crypto.randomBytes(5).toString("hex");
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, filePath);
}
function text(value, max, required = false) {
    const result = String(value == null ? "" : value).trim().replace(/[\u0000-\u001f\u007f]/g, " ");
    if (required && !result) throw new Error("Required ticket field is missing.");
    if (result.length > max) throw new Error("Ticket field is too long.");
    return result;
}
function identifier(value, field) {
    const result = String(value || "").trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9._:-]{1,127}$/.test(result)) throw new Error(field + " is invalid.");
    return result;
}
function iso(value, fallback) {
    const date = value ? new Date(value) : new Date(fallback);
    if (Number.isNaN(date.getTime())) throw new Error("Ticket timestamp is invalid.");
    return date.toISOString();
}
function optionalPerson(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    return { id: text(value.id, 180), displayName: text(value.displayName, 180), email: text(value.email, 254) };
}
function safeObject(value) { return value && typeof value === "object" && !Array.isArray(value) ? clone(value) : {}; }

function create(options = {}) {
    const dataDir = path.resolve(options.dataDir || path.join(process.cwd(), "data"));
    const filePath = path.join(dataDir, "ticket-projections.json");
    const now = typeof options.now === "function" ? options.now : Date.now;
    const maxTickets = Math.max(100, Math.min(100000, Number(options.maxTickets || 25000)));
    let state = { schema: 1, tickets: {}, portalCursors: {}, policies: {} };
    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
        if (parsed && parsed.schema === 1 && parsed.tickets) state = Object.assign(state, parsed);
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    function persist() { atomicWrite(filePath, state); }
    function key(portalId, ticketId) { return identifier(portalId, "Portal ID") + "::" + identifier(ticketId, "Ticket ID"); }
    function normalize(portalId, input, previous) {
        const timestamp = now();
        const status = String(input.status || previous && previous.status || "new");
        const priority = String(input.priority || previous && previous.priority || "normal");
        const syncState = String(input.sync && input.sync.state || previous && previous.sync && previous.sync.state || "local");
        if (!STATUSES.includes(status)) throw new Error("Unsupported ticket status.");
        if (!PRIORITIES.includes(priority)) throw new Error("Unsupported ticket priority.");
        if (!SYNC_STATES.includes(syncState)) throw new Error("Unsupported ticket sync state.");
        const ticketId = identifier(input.ticketId || input.id, "Ticket ID");
        const updatedAtUtc = iso(input.updatedAtUtc, timestamp);
        if (previous && Date.parse(updatedAtUtc) < Date.parse(previous.updatedAtUtc)) return previous;
        const slaInput = safeObject(input.sla);
        return {
            ticketId,
            portalId: identifier(portalId, "Portal ID"),
            tenantId: text(input.tenantId, 128), customerId: text(input.customerId, 128), siteId: text(input.siteId, 128),
            externalSystem: text(input.externalSystem || "local", 64), externalId: text(input.externalId, 128),
            title: text(input.title, 240, true),
            description: text(input.description, 12000),
            status, priority,
            category: text(input.category, 120), source: text(input.source || "portal", 64),
            requester: optionalPerson(input.requester), assignee: optionalPerson(input.assignee),
            deviceId: text(input.deviceId, 180),
            createdAtUtc: iso(input.createdAtUtc, previous ? previous.createdAtUtc : timestamp),
            updatedAtUtc,
            sla: {
                responseDueAtUtc: slaInput.responseDueAtUtc ? iso(slaInput.responseDueAtUtc, timestamp) : null,
                resolutionDueAtUtc: slaInput.resolutionDueAtUtc ? iso(slaInput.resolutionDueAtUtc, timestamp) : null,
                breached: Boolean(slaInput.breached)
            },
            sync: {
                state: syncState,
                lastSyncAtUtc: input.sync && input.sync.lastSyncAtUtc ? iso(input.sync.lastSyncAtUtc, timestamp) : null,
                lastError: text(input.sync && input.sync.lastError, 1000)
            },
            central: Object.assign({}, previous && previous.central || {}, safeObject(input.central)),
            receivedAtUtc: new Date(timestamp).toISOString()
        };
    }
    function trim() {
        const items = Object.entries(state.tickets);
        if (items.length <= maxTickets) return;
        items.sort((a, b) => Date.parse(a[1].updatedAtUtc) - Date.parse(b[1].updatedAtUtc));
        for (const [ticketKey] of items.slice(0, items.length - maxTickets)) delete state.tickets[ticketKey];
    }
    function upsert(portalId, input) {
        const ticketKey = key(portalId, input.ticketId || input.id);
        const previous = state.tickets[ticketKey];
        const ticket = normalize(portalId, input, previous);
        state.tickets[ticketKey] = ticket;
        trim(); persist(); return clone(ticket);
    }
    function snapshot(portalId, input) {
        const tickets = Array.isArray(input && input.tickets) ? input.tickets : [];
        if (tickets.length > 5000) throw new Error("Ticket snapshot is too large.");
        const seen = new Set();
        for (const item of tickets) { const stored = upsert(portalId, item); seen.add(key(portalId, stored.ticketId)); }
        if (input && input.full === true) {
            for (const [ticketKey, ticket] of Object.entries(state.tickets)) {
                if (ticket.portalId === portalId && !seen.has(ticketKey) && !["closed", "cancelled"].includes(ticket.status)) {
                    ticket.status = "closed"; ticket.updatedAtUtc = new Date(now()).toISOString(); ticket.receivedAtUtc = ticket.updatedAtUtc;
                }
            }
        }
        state.portalCursors[portalId] = { cursor: text(input && input.cursor, 256), receivedAtUtc: new Date(now()).toISOString(), count: tickets.length };
        persist();
        return { accepted: tickets.length, cursor: state.portalCursors[portalId].cursor };
    }
    function event(portalId, input) {
        const eventType = String(input && input.type || "");
        if (!EVENTS.includes(eventType)) throw new Error("Unsupported ticket event.");
        const ticket = upsert(portalId, input.ticket || input);
        return { type: eventType, ticket };
    }
    function list(filter = {}) {
        const search = String(filter.search || "").trim().toLowerCase();
        const limit = Math.max(1, Math.min(1000, Number(filter.limit || 200)));
        return Object.values(state.tickets)
            .filter(item => !filter.portalId || item.portalId === filter.portalId)
            .filter(item => !filter.status || item.status === filter.status)
            .filter(item => !filter.priority || item.priority === filter.priority)
            .filter(item => !filter.tenantId || item.tenantId === filter.tenantId)
            .filter(item => !filter.siteId || item.siteId === filter.siteId)
            .filter(item => !filter.slaBreached || item.sla.breached)
            .filter(item => !search || [item.ticketId, item.title, item.externalId, item.requester && item.requester.displayName].join(" ").toLowerCase().includes(search))
            .sort((a, b) => b.updatedAtUtc.localeCompare(a.updatedAtUtc)).slice(0, limit).map(clone);
    }
    function get(portalId, ticketId) { const item = state.tickets[key(portalId, ticketId)]; return item ? clone(item) : null; }
    function updateCentral(portalId, ticketId, changes, actor) {
        const ticketKey = key(portalId, ticketId); const item = state.tickets[ticketKey];
        if (!item) throw new Error("Ticket not found.");
        const allowed = {};
        if (changes.status != null) { if (!STATUSES.includes(String(changes.status))) throw new Error("Unsupported ticket status."); allowed.status = String(changes.status); }
        if (changes.assignee != null) allowed.assignee = optionalPerson(changes.assignee);
        if (changes.centralOwner != null) item.central.centralOwner = text(changes.centralOwner, 180);
        if (changes.note != null) item.central.lastNote = text(changes.note, 2000);
        Object.assign(item, allowed);
        item.central.lastChangedBy = String(actor && (actor.identityKey || actor.username) || "system").slice(0, 180);
        item.central.lastChangedAtUtc = new Date(now()).toISOString();
        item.updatedAtUtc = item.central.lastChangedAtUtc;
        persist(); return clone(item);
    }
    function summary() {
        const counts = Object.fromEntries(STATUSES.map(value => [value, 0]));
        let critical = 0, slaBreached = 0, syncFailed = 0;
        for (const ticket of Object.values(state.tickets)) {
            counts[ticket.status] = (counts[ticket.status] || 0) + 1;
            if (ticket.priority === "critical" && !["closed", "cancelled"].includes(ticket.status)) critical++;
            if (ticket.sla.breached && !["closed", "cancelled"].includes(ticket.status)) slaBreached++;
            if (ticket.sync.state === "failed" || ticket.sync.state === "conflict") syncFailed++;
        }
        return { total: Object.keys(state.tickets).length, counts, critical, slaBreached, syncFailed };
    }
    function getPolicy(portalId) {
        return clone(state.policies[portalId] || { mode: "open", includeStatuses: STATUSES.filter(v => !["closed", "cancelled"].includes(v)), includePriorities: PRIORITIES, includeDescription: true, includeRequester: true, allowCentralChanges: true });
    }
    function setPolicy(portalId, policy) {
        const mode = String(policy && policy.mode || "open");
        if (!['none','critical','open','selected','all'].includes(mode)) throw new Error("Unsupported ticket publication policy.");
        state.policies[portalId] = {
            mode,
            includeStatuses: (Array.isArray(policy.includeStatuses) ? policy.includeStatuses : []).filter(v => STATUSES.includes(v)),
            includePriorities: (Array.isArray(policy.includePriorities) ? policy.includePriorities : []).filter(v => PRIORITIES.includes(v)),
            includeDescription: policy.includeDescription !== false,
            includeRequester: policy.includeRequester !== false,
            allowCentralChanges: policy.allowCentralChanges === true
        };
        persist(); return getPolicy(portalId);
    }
    return { upsert, snapshot, event, list, get, updateCentral, summary, getPolicy, setPolicy, filePath, STATUSES, PRIORITIES, SYNC_STATES, EVENTS };
}

module.exports = { create, STATUSES, PRIORITIES, SYNC_STATES, EVENTS };
