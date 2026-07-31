"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const STATUSES = Object.freeze(["new", "accepted", "in_progress", "waiting_for_user", "waiting_for_external", "resolved", "closed", "cancelled"]);
const PRIORITIES = Object.freeze(["low", "normal", "high", "critical"]);
const SYNC_STATES = Object.freeze(["local", "pending", "synchronized", "conflict", "failed"]);
const EVENTS = Object.freeze(["ticket.created", "ticket.updated", "ticket.status_changed", "ticket.assigned", "ticket.comment_added", "ticket.sla_breached", "ticket.closed", "ticket.sync_failed"]);
const POLICY_MODES = Object.freeze(["none", "critical", "open", "selected", "all"]);

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function atomicWrite(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const temporary = filePath + ".tmp-" + process.pid + "-" + crypto.randomBytes(5).toString("hex");
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, filePath);
}
function storeError(message, code, statusCode = 400) {
    return Object.assign(new Error(message), { code, statusCode });
}
function finiteNumber(value, fallback, minimum, maximum) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.max(minimum, Math.min(maximum, number));
}
function text(value, max, required = false) {
    const result = String(value == null ? "" : value).trim().replace(/[\u0000-\u001f\u007f]/g, " ");
    if (required && !result) throw storeError("Required ticket field is missing.", "TICKET_FIELD_REQUIRED");
    if (result.length > max) throw storeError("Ticket field is too long.", "TICKET_FIELD_TOO_LONG");
    return result;
}
function identifier(value, field) {
    const result = String(value || "").trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9._:-]{1,127}$/.test(result)) throw storeError(field + " is invalid.", "TICKET_IDENTIFIER_INVALID");
    return result;
}
function iso(value, fallback) {
    const date = value ? new Date(value) : new Date(fallback);
    if (Number.isNaN(date.getTime())) throw storeError("Ticket timestamp is invalid.", "TICKET_TIMESTAMP_INVALID");
    return date.toISOString();
}
function optionalPerson(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    return { id: text(value.id, 180), displayName: text(value.displayName, 180), email: text(value.email, 254) };
}
function safeObject(value) { return value && typeof value === "object" && !Array.isArray(value) ? clone(value) : {}; }
function defaultPolicy() {
    return {
        mode: "none",
        includeStatuses: [],
        includePriorities: [],
        includeDescription: false,
        includeRequester: false,
        allowCentralChanges: false
    };
}
function validateSelection(values, allowed, field) {
    if (!Array.isArray(values)) return [];
    const normalized = [...new Set(values.map(value => String(value)))];
    const invalid = normalized.filter(value => !allowed.includes(value));
    if (invalid.length) throw storeError(field + " contains unsupported values.", "TICKET_POLICY_INVALID");
    return normalized;
}
function policyAllows(policy, input) {
    const status = String(input && input.status || "new");
    const priority = String(input && input.priority || "normal");
    if (policy.mode === "none") return false;
    if (policy.mode === "critical") return priority === "critical";
    if (policy.mode === "open") return !["closed", "cancelled"].includes(status);
    if (policy.mode === "selected") return policy.includeStatuses.includes(status) && policy.includePriorities.includes(priority);
    return true;
}
function applyPolicy(policy, input) {
    const value = Object.assign({}, input);
    if (!policy.includeDescription) value.description = "";
    if (!policy.includeRequester) value.requester = null;
    return value;
}

function create(options = {}) {
    const dataDir = path.resolve(options.dataDir || path.join(process.cwd(), "data"));
    const filePath = path.join(dataDir, "ticket-projections.json");
    const now = typeof options.now === "function" ? options.now : Date.now;
    const maxTickets = Math.round(finiteNumber(options.maxTickets, 25000, 100, 100000));
    const maxEventIdsPerPortal = Math.round(finiteNumber(options.maxEventIdsPerPortal, 2000, 100, 10000));
    let state = { schema: 1, tickets: {}, portalCursors: {}, policies: {}, portalEvents: {} };
    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
        if (parsed && parsed.schema === 1 && parsed.tickets) {
            state = Object.assign(state, parsed, {
                portalCursors: parsed.portalCursors || {},
                policies: parsed.policies || {},
                portalEvents: parsed.portalEvents || {}
            });
        }
    } catch (error) { if (error.code !== "ENOENT") throw error; }

    function persist() { atomicWrite(filePath, state); }
    function key(portalId, ticketId) { return identifier(portalId, "Portal ID") + "::" + identifier(ticketId, "Ticket ID"); }
    function scopeFor(context) {
        const assignment = context && context.assignment;
        if (!assignment) return null;
        return {
            tenantId: text(assignment.tenantId, 128, true),
            customerId: text(assignment.customerId, 128, true),
            siteId: text(assignment.siteId, 128, true)
        };
    }
    function normalize(portalId, input, previous, context = {}) {
        if (!input || typeof input !== "object" || Array.isArray(input)) throw storeError("Ticket payload is invalid.", "TICKET_PAYLOAD_INVALID");
        const timestamp = now();
        const status = String(input.status || previous && previous.status || "new");
        const priority = String(input.priority || previous && previous.priority || "normal");
        const syncState = String(input.sync && input.sync.state || previous && previous.sync && previous.sync.state || "local");
        if (!STATUSES.includes(status)) throw storeError("Unsupported ticket status.", "TICKET_STATUS_INVALID");
        if (!PRIORITIES.includes(priority)) throw storeError("Unsupported ticket priority.", "TICKET_PRIORITY_INVALID");
        if (!SYNC_STATES.includes(syncState)) throw storeError("Unsupported ticket sync state.", "TICKET_SYNC_STATE_INVALID");
        const ticketId = identifier(input.ticketId || input.id, "Ticket ID");
        const sourceUpdatedAtUtc = iso(input.updatedAtUtc, timestamp);
        const previousSourceUpdatedAtUtc = previous && (previous.sourceUpdatedAtUtc || previous.updatedAtUtc);
        if (previousSourceUpdatedAtUtc && Date.parse(sourceUpdatedAtUtc) < Date.parse(previousSourceUpdatedAtUtc)) {
            return { ticket: previous, changed: false, stale: true };
        }
        const canonicalScope = scopeFor(context);
        if (canonicalScope) {
            for (const field of ["tenantId", "customerId", "siteId"]) {
                const supplied = text(input[field], 128);
                if (supplied && supplied !== canonicalScope[field]) {
                    throw storeError("Ticket scope does not match the Portal assignment.", "TICKET_SCOPE_MISMATCH", 409);
                }
            }
        }
        const slaInput = safeObject(input.sla);
        const ticket = {
            ticketId,
            portalId: identifier(portalId, "Portal ID"),
            tenantId: canonicalScope ? canonicalScope.tenantId : text(input.tenantId, 128),
            customerId: canonicalScope ? canonicalScope.customerId : text(input.customerId, 128),
            siteId: canonicalScope ? canonicalScope.siteId : text(input.siteId, 128),
            externalSystem: text(input.externalSystem || "local", 64),
            externalId: text(input.externalId, 128),
            title: text(input.title, 240, true),
            description: text(input.description, 12000),
            status,
            priority,
            category: text(input.category, 120),
            source: text(input.source || "portal", 64),
            requester: optionalPerson(input.requester),
            assignee: optionalPerson(input.assignee),
            deviceId: text(input.deviceId, 180),
            createdAtUtc: iso(input.createdAtUtc, previous ? previous.createdAtUtc : timestamp),
            sourceUpdatedAtUtc,
            updatedAtUtc: sourceUpdatedAtUtc,
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
            central: clone(previous && previous.central || {}),
            receivedAtUtc: new Date(timestamp).toISOString()
        };
        return { ticket, changed: true, stale: false };
    }
    function trim() {
        const items = Object.entries(state.tickets);
        if (items.length <= maxTickets) return;
        items.sort((a, b) => Date.parse(a[1].updatedAtUtc) - Date.parse(b[1].updatedAtUtc));
        for (const [ticketKey] of items.slice(0, items.length - maxTickets)) delete state.tickets[ticketKey];
    }
    function upsert(portalId, input, context = {}) {
        const ticketKey = key(portalId, input && (input.ticketId || input.id));
        const normalized = normalize(portalId, input, state.tickets[ticketKey], context);
        if (normalized.changed) {
            state.tickets[ticketKey] = normalized.ticket;
            trim();
            persist();
        }
        return clone(normalized.ticket);
    }
    function getPolicy(portalId) {
        const id = identifier(portalId, "Portal ID");
        return clone(state.policies[id] || defaultPolicy());
    }
    function snapshot(portalId, input, context = {}) {
        portalId = identifier(portalId, "Portal ID");
        if (!input || typeof input !== "object" || Array.isArray(input)) throw storeError("Ticket snapshot is invalid.", "TICKET_SNAPSHOT_INVALID");
        const tickets = Array.isArray(input.tickets) ? input.tickets : [];
        if (tickets.length > 5000) throw storeError("Ticket snapshot is too large.", "TICKET_SNAPSHOT_TOO_LARGE", 413);
        const generatedAtUtc = iso(input.generatedAtUtc, now());
        const cursor = text(input.cursor, 256);
        const previousCursor = state.portalCursors[portalId] || null;
        if (previousCursor && previousCursor.generatedAtUtc && Date.parse(generatedAtUtc) < Date.parse(previousCursor.generatedAtUtc)) {
            throw storeError("Ticket snapshot is older than the last accepted snapshot.", "TICKET_SNAPSHOT_STALE", 409);
        }
        if (previousCursor && previousCursor.generatedAtUtc === generatedAtUtc && previousCursor.cursor === cursor) {
            return { accepted: 0, skipped: 0, stale: 0, duplicate: true, cursor };
        }

        const policy = getPolicy(portalId);
        const staged = new Map();
        const seen = new Set();
        let accepted = 0; let skipped = 0; let stale = 0;
        for (const rawItem of tickets) {
            if (!policyAllows(policy, rawItem)) { skipped += 1; continue; }
            const item = applyPolicy(policy, rawItem);
            const ticketKey = key(portalId, item.ticketId || item.id);
            const previous = staged.has(ticketKey) ? staged.get(ticketKey) : state.tickets[ticketKey];
            const normalized = normalize(portalId, item, previous, context);
            staged.set(ticketKey, normalized.ticket);
            seen.add(ticketKey);
            if (normalized.stale) stale += 1; else accepted += 1;
        }
        for (const [ticketKey, ticket] of staged) state.tickets[ticketKey] = ticket;

        if (input.full === true) {
            const snapshotTime = Date.parse(generatedAtUtc);
            for (const [ticketKey, ticket] of Object.entries(state.tickets)) {
                const sourceTime = Date.parse(ticket.sourceUpdatedAtUtc || ticket.updatedAtUtc);
                if (ticket.portalId === portalId && policyAllows(policy, ticket) && !seen.has(ticketKey) && !["closed", "cancelled"].includes(ticket.status) && sourceTime <= snapshotTime) {
                    ticket.status = "closed";
                    ticket.sourceUpdatedAtUtc = generatedAtUtc;
                    ticket.updatedAtUtc = generatedAtUtc;
                    ticket.receivedAtUtc = new Date(now()).toISOString();
                }
            }
        }
        state.portalCursors[portalId] = {
            cursor,
            generatedAtUtc,
            receivedAtUtc: new Date(now()).toISOString(),
            count: tickets.length
        };
        trim();
        persist();
        return { accepted, skipped, stale, duplicate: false, cursor };
    }
    function event(portalId, input, context = {}) {
        portalId = identifier(portalId, "Portal ID");
        const eventType = String(input && input.type || "");
        if (!EVENTS.includes(eventType)) throw storeError("Unsupported ticket event.", "TICKET_EVENT_TYPE_INVALID");
        const eventId = identifier(input && input.eventId, "Event ID");
        const occurredAtUtc = iso(input && input.occurredAtUtc, now());
        const events = state.portalEvents[portalId] || {};
        if (events[eventId]) {
            const ticketId = input && input.ticket && (input.ticket.ticketId || input.ticket.id);
            return { type: eventType, eventId, occurredAtUtc, duplicate: true, accepted: false, ticket: ticketId ? get(portalId, ticketId) : null };
        }
        const policy = getPolicy(portalId);
        const rawTicket = input.ticket || input;
        let ticket = null;
        let accepted = false;
        let stale = false;
        if (policyAllows(policy, rawTicket)) {
            const item = applyPolicy(policy, rawTicket);
            const ticketKey = key(portalId, item.ticketId || item.id);
            const normalized = normalize(portalId, item, state.tickets[ticketKey], context);
            ticket = normalized.ticket;
            stale = normalized.stale;
            if (normalized.changed) state.tickets[ticketKey] = normalized.ticket;
            accepted = !normalized.stale;
        }
        events[eventId] = { occurredAtUtc, receivedAtUtc: new Date(now()).toISOString() };
        const orderedIds = Object.keys(events).sort((left, right) => events[left].receivedAtUtc.localeCompare(events[right].receivedAtUtc));
        for (const oldId of orderedIds.slice(0, Math.max(0, orderedIds.length - maxEventIdsPerPortal))) delete events[oldId];
        state.portalEvents[portalId] = events;
        trim();
        persist();
        return { type: eventType, eventId, occurredAtUtc, duplicate: false, accepted, stale, ticket: ticket ? clone(ticket) : null };
    }
    function matches(item, filter, portalSet) {
        const search = String(filter.search || "").trim().toLowerCase();
        return (!portalSet || portalSet.has(item.portalId))
            && (!filter.portalId || item.portalId === filter.portalId)
            && (!filter.status || item.status === filter.status)
            && (!filter.priority || item.priority === filter.priority)
            && (!filter.tenantId || item.tenantId === filter.tenantId)
            && (!filter.siteId || item.siteId === filter.siteId)
            && (!filter.slaBreached || item.sla.breached)
            && (!search || [item.ticketId, item.title, item.externalId, item.requester && item.requester.displayName].join(" ").toLowerCase().includes(search));
    }
    function list(filter = {}) {
        const portalSet = Array.isArray(filter.portalIds) ? new Set(filter.portalIds) : null;
        const limit = Math.round(finiteNumber(filter.limit, 200, 1, 1000));
        return Object.values(state.tickets)
            .filter(item => matches(item, filter, portalSet))
            .sort((a, b) => b.updatedAtUtc.localeCompare(a.updatedAtUtc))
            .slice(0, limit)
            .map(clone);
    }
    function get(portalId, ticketId) {
        const item = state.tickets[key(portalId, ticketId)];
        return item ? clone(item) : null;
    }
    function updateCentral(portalId, ticketId, changes, actor) {
        const ticketKey = key(portalId, ticketId);
        const item = state.tickets[ticketKey];
        if (!item) throw storeError("Ticket not found.", "TICKET_NOT_FOUND", 404);
        if (!changes || typeof changes !== "object" || Array.isArray(changes)) throw storeError("Ticket change payload is invalid.", "TICKET_CHANGE_INVALID");
        let changed = false;
        if (changes.status != null) {
            if (!STATUSES.includes(String(changes.status))) throw storeError("Unsupported ticket status.", "TICKET_STATUS_INVALID");
            item.status = String(changes.status);
            changed = true;
        }
        if (changes.assignee != null) { item.assignee = optionalPerson(changes.assignee); changed = true; }
        if (changes.centralOwner != null) { item.central.centralOwner = text(changes.centralOwner, 180); changed = true; }
        if (changes.note != null) { item.central.lastNote = text(changes.note, 2000); changed = true; }
        if (!changed) throw storeError("No supported ticket changes were supplied.", "TICKET_CHANGE_EMPTY");
        item.central.lastChangedBy = String(actor && (actor.identityKey || actor.username) || "system").slice(0, 180);
        item.central.lastChangedAtUtc = new Date(now()).toISOString();
        item.central.pendingPortalSync = true;
        item.updatedAtUtc = item.central.lastChangedAtUtc;
        persist();
        return clone(item);
    }
    function summary(filter = {}) {
        const portalSet = Array.isArray(filter.portalIds) ? new Set(filter.portalIds) : null;
        const counts = Object.fromEntries(STATUSES.map(value => [value, 0]));
        let total = 0; let critical = 0; let slaBreached = 0; let syncFailed = 0;
        for (const ticket of Object.values(state.tickets)) {
            if (!matches(ticket, filter, portalSet)) continue;
            total += 1;
            counts[ticket.status] = (counts[ticket.status] || 0) + 1;
            if (ticket.priority === "critical" && !["closed", "cancelled"].includes(ticket.status)) critical += 1;
            if (ticket.sla.breached && !["closed", "cancelled"].includes(ticket.status)) slaBreached += 1;
            if (ticket.sync.state === "failed" || ticket.sync.state === "conflict") syncFailed += 1;
        }
        return { total, counts, critical, slaBreached, syncFailed };
    }
    function setPolicy(portalId, policy) {
        portalId = identifier(portalId, "Portal ID");
        const mode = String(policy && policy.mode || "none");
        if (!POLICY_MODES.includes(mode)) throw storeError("Unsupported ticket publication policy.", "TICKET_POLICY_INVALID");
        const includeStatuses = validateSelection(policy && policy.includeStatuses, STATUSES, "includeStatuses");
        const includePriorities = validateSelection(policy && policy.includePriorities, PRIORITIES, "includePriorities");
        if (mode === "selected" && (!includeStatuses.length || !includePriorities.length)) {
            throw storeError("Selected policy requires at least one status and priority.", "TICKET_POLICY_INVALID");
        }
        state.policies[portalId] = {
            mode,
            includeStatuses,
            includePriorities,
            includeDescription: policy && policy.includeDescription === true,
            includeRequester: policy && policy.includeRequester === true,
            allowCentralChanges: policy && policy.allowCentralChanges === true
        };
        persist();
        return getPolicy(portalId);
    }
    return { upsert, snapshot, event, list, get, updateCentral, summary, getPolicy, setPolicy, filePath, STATUSES, PRIORITIES, SYNC_STATES, EVENTS, POLICY_MODES };
}

module.exports = { create, STATUSES, PRIORITIES, SYNC_STATES, EVENTS, POLICY_MODES, defaultPolicy, policyAllows };
