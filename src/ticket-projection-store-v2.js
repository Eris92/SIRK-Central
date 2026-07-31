"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const STATUSES = Object.freeze(["new", "accepted", "in_progress", "waiting_for_user", "waiting_for_external", "resolved", "closed", "cancelled"]);
const PRIORITIES = Object.freeze(["low", "normal", "high", "critical"]);
const SYNC_STATES = Object.freeze(["local", "pending", "synchronized", "conflict", "failed"]);
const EVENTS = Object.freeze(["ticket.created", "ticket.updated", "ticket.status_changed", "ticket.assigned", "ticket.comment_added", "ticket.sla_breached", "ticket.closed", "ticket.sync_failed"]);
const POLICY_MODES = Object.freeze(["none", "critical", "open", "selected", "all"]);
const TERMINAL_STATUSES = new Set(["closed", "cancelled"]);

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function atomicWrite(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const temporary = filePath + ".tmp-" + process.pid + "-" + crypto.randomBytes(6).toString("hex");
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
    return {
        id: text(value.id, 180),
        displayName: text(value.displayName, 180),
        email: text(value.email, 254)
    };
}
function safeObject(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? clone(value) : {};
}
function stable(value) {
    if (value === null || value === undefined) return value;
    if (Array.isArray(value)) return value.map(stable);
    if (typeof value === "object") {
        return Object.fromEntries(Object.keys(value).sort().filter(key => !["__proto__", "prototype", "constructor"].includes(key)).map(key => [key, stable(value[key])]));
    }
    if (typeof value === "number" && !Number.isFinite(value)) return null;
    return value;
}
function digest(value) {
    return crypto.createHash("sha256").update(JSON.stringify(stable(value)), "utf8").digest("base64url");
}
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
function normalizePolicy(policy) {
    const mode = String(policy && policy.mode || "none");
    if (!POLICY_MODES.includes(mode)) throw storeError("Unsupported ticket publication policy.", "TICKET_POLICY_INVALID");
    const includeStatuses = validateSelection(policy && policy.includeStatuses, STATUSES, "includeStatuses");
    const includePriorities = validateSelection(policy && policy.includePriorities, PRIORITIES, "includePriorities");
    if (mode === "selected" && (!includeStatuses.length || !includePriorities.length)) {
        throw storeError("Selected policy requires at least one status and priority.", "TICKET_POLICY_INVALID");
    }
    return {
        mode,
        includeStatuses,
        includePriorities,
        includeDescription: policy && policy.includeDescription === true,
        includeRequester: policy && policy.includeRequester === true,
        allowCentralChanges: policy && policy.allowCentralChanges === true
    };
}
function policyAllows(policy, input) {
    const status = String(input && input.status || "new");
    const priority = String(input && input.priority || "normal");
    if (policy.mode === "none") return false;
    if (policy.mode === "critical") return priority === "critical";
    if (policy.mode === "open") return !TERMINAL_STATUSES.has(status);
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
    let state = { schema: 2, tickets: {}, portalCursors: {}, policies: {}, portalEvents: {} };

    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
        if (parsed && [1, 2].includes(parsed.schema) && parsed.tickets && typeof parsed.tickets === "object") {
            state = {
                schema: 2,
                tickets: parsed.tickets,
                portalCursors: parsed.portalCursors || {},
                policies: parsed.policies || {},
                portalEvents: parsed.portalEvents || {}
            };
            for (const ticket of Object.values(state.tickets)) {
                if (!ticket.sourceUpdatedAtUtc) ticket.sourceUpdatedAtUtc = ticket.updatedAtUtc;
                if (!ticket.sourceHash) ticket.sourceHash = digest(sourceProjection(ticket));
                if (!ticket.central || typeof ticket.central !== "object") ticket.central = {};
            }
            for (const [portalId, policy] of Object.entries(state.policies)) state.policies[portalId] = normalizePolicy(policy);
        }
    } catch (error) {
        if (error.code !== "ENOENT") throw error;
    }

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
    function sourceProjection(input) {
        return {
            ticketId: input.ticketId || input.id,
            tenantId: input.tenantId || "",
            customerId: input.customerId || "",
            siteId: input.siteId || "",
            externalSystem: input.externalSystem || "local",
            externalId: input.externalId || "",
            title: input.title || "",
            description: input.description || "",
            status: input.status || "new",
            priority: input.priority || "normal",
            category: input.category || "",
            source: input.source || "portal",
            requester: input.requester || null,
            assignee: input.assignee || null,
            deviceId: input.deviceId || "",
            createdAtUtc: input.createdAtUtc || "",
            updatedAtUtc: input.updatedAtUtc || "",
            sla: input.sla || {},
            sync: input.sync || {}
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
        const canonicalScope = scopeFor(context);
        if (canonicalScope) {
            for (const field of ["tenantId", "customerId", "siteId"]) {
                const supplied = text(input[field], 128);
                if (supplied && supplied !== canonicalScope[field]) throw storeError("Ticket scope does not match the Portal assignment.", "TICKET_SCOPE_MISMATCH", 409);
            }
        }
        const canonicalInput = {
            ticketId,
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
            updatedAtUtc: sourceUpdatedAtUtc,
            sla: safeObject(input.sla),
            sync: safeObject(input.sync)
        };
        const sourceHash = digest(canonicalInput);
        const previousTime = previous && Date.parse(previous.sourceUpdatedAtUtc || previous.updatedAtUtc);
        const currentTime = Date.parse(sourceUpdatedAtUtc);
        if (Number.isFinite(previousTime) && currentTime < previousTime) return { ticket: previous, changed: false, stale: true, duplicate: false };
        if (Number.isFinite(previousTime) && currentTime === previousTime) {
            if (previous.sourceHash === sourceHash) return { ticket: previous, changed: false, stale: false, duplicate: true };
            throw storeError("Ticket version has the same timestamp but different content.", "TICKET_VERSION_CONFLICT", 409);
        }
        const slaInput = canonicalInput.sla;
        const ticket = {
            ticketId,
            portalId: identifier(portalId, "Portal ID"),
            tenantId: canonicalInput.tenantId,
            customerId: canonicalInput.customerId,
            siteId: canonicalInput.siteId,
            externalSystem: canonicalInput.externalSystem,
            externalId: canonicalInput.externalId,
            title: canonicalInput.title,
            description: canonicalInput.description,
            status,
            priority,
            category: canonicalInput.category,
            source: canonicalInput.source,
            requester: canonicalInput.requester,
            assignee: canonicalInput.assignee,
            deviceId: canonicalInput.deviceId,
            createdAtUtc: canonicalInput.createdAtUtc,
            sourceUpdatedAtUtc,
            updatedAtUtc: sourceUpdatedAtUtc,
            sourceHash,
            sla: {
                responseDueAtUtc: slaInput.responseDueAtUtc ? iso(slaInput.responseDueAtUtc, timestamp) : null,
                resolutionDueAtUtc: slaInput.resolutionDueAtUtc ? iso(slaInput.resolutionDueAtUtc, timestamp) : null,
                breached: Boolean(slaInput.breached)
            },
            sync: {
                state: syncState,
                lastSyncAtUtc: canonicalInput.sync.lastSyncAtUtc ? iso(canonicalInput.sync.lastSyncAtUtc, timestamp) : null,
                lastError: text(canonicalInput.sync.lastError, 1000)
            },
            central: clone(previous && previous.central || {}),
            receivedAtUtc: new Date(timestamp).toISOString()
        };
        if (ticket.central.pendingPortalSync && ticket.central.requestedStatus === ticket.status) {
            ticket.central.pendingPortalSync = false;
            ticket.central.synchronizedAtUtc = ticket.receivedAtUtc;
        }
        return { ticket, changed: true, stale: false, duplicate: false };
    }
    function assertCapacity(ticketKey, stagedCount = 0) {
        if (!state.tickets[ticketKey] && Object.keys(state.tickets).length + stagedCount >= maxTickets) {
            throw storeError("Ticket projection capacity was reached.", "TICKET_CAPACITY_REACHED", 507);
        }
    }
    function upsert(portalId, input, context = {}) {
        const ticketKey = key(portalId, input && (input.ticketId || input.id));
        assertCapacity(ticketKey);
        const normalized = normalize(portalId, input, state.tickets[ticketKey], context);
        if (normalized.changed) {
            state.tickets[ticketKey] = normalized.ticket;
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
        const items = Array.isArray(input.tickets) ? input.tickets : [];
        if (items.length > 5000) throw storeError("Ticket snapshot is too large.", "TICKET_SNAPSHOT_TOO_LARGE", 413);
        const generatedAtUtc = iso(input.generatedAtUtc, now());
        const cursor = text(input.cursor, 256, true);
        const snapshotHash = digest({ generatedAtUtc, cursor, full: input.full === true, tickets: items });
        const previousCursor = state.portalCursors[portalId] || null;
        if (previousCursor && Date.parse(generatedAtUtc) < Date.parse(previousCursor.generatedAtUtc)) throw storeError("Ticket snapshot is older than the last accepted snapshot.", "TICKET_SNAPSHOT_STALE", 409);
        if (previousCursor && previousCursor.generatedAtUtc === generatedAtUtc && previousCursor.cursor === cursor) {
            if (previousCursor.hash === snapshotHash) return { accepted: 0, skipped: 0, stale: 0, duplicates: 1, duplicate: true, removed: 0, cursor };
            throw storeError("Snapshot cursor was reused with different content.", "TICKET_SNAPSHOT_REPLAY_CONFLICT", 409);
        }

        const policy = getPolicy(portalId);
        const staged = new Map();
        const seen = new Set();
        let accepted = 0;
        let skipped = 0;
        let stale = 0;
        let duplicates = 0;
        let newCount = 0;
        for (const rawItem of items) {
            const ticketKey = key(portalId, rawItem && (rawItem.ticketId || rawItem.id));
            if (!policyAllows(policy, rawItem)) {
                skipped += 1;
                seen.add(ticketKey);
                staged.set(ticketKey, null);
                continue;
            }
            const item = applyPolicy(policy, rawItem);
            const previous = staged.has(ticketKey) ? staged.get(ticketKey) : state.tickets[ticketKey];
            if (!previous && !state.tickets[ticketKey]) {
                newCount += 1;
                assertCapacity(ticketKey, newCount - 1);
            }
            const normalized = normalize(portalId, item, previous, context);
            staged.set(ticketKey, normalized.ticket);
            seen.add(ticketKey);
            if (normalized.stale) stale += 1;
            else if (normalized.duplicate) duplicates += 1;
            else accepted += 1;
        }

        let removed = 0;
        for (const [ticketKey, ticket] of staged) {
            if (ticket) state.tickets[ticketKey] = ticket;
            else if (state.tickets[ticketKey]) {
                delete state.tickets[ticketKey];
                removed += 1;
            }
        }
        if (input.full === true) {
            for (const [ticketKey, ticket] of Object.entries(state.tickets)) {
                if (ticket.portalId === portalId && !seen.has(ticketKey)) {
                    delete state.tickets[ticketKey];
                    removed += 1;
                }
            }
        }
        state.portalCursors[portalId] = {
            cursor,
            generatedAtUtc,
            hash: snapshotHash,
            receivedAtUtc: new Date(now()).toISOString(),
            count: items.length
        };
        persist();
        return { accepted, skipped, stale, duplicates, duplicate: false, removed, cursor };
    }
    function event(portalId, input, context = {}) {
        portalId = identifier(portalId, "Portal ID");
        if (!input || typeof input !== "object" || Array.isArray(input)) throw storeError("Ticket event is invalid.", "TICKET_EVENT_INVALID");
        const eventType = String(input.type || "");
        if (!EVENTS.includes(eventType)) throw storeError("Unsupported ticket event.", "TICKET_EVENT_TYPE_INVALID");
        const eventId = identifier(input.eventId, "Event ID");
        const occurredAtUtc = iso(input.occurredAtUtc, now());
        const eventHash = digest(input);
        const events = state.portalEvents[portalId] || {};
        if (events[eventId]) {
            if (events[eventId].hash !== eventHash) throw storeError("Event ID was reused with different content.", "TICKET_EVENT_REPLAY_CONFLICT", 409);
            const ticketId = input.ticket && (input.ticket.ticketId || input.ticket.id);
            return { type: eventType, eventId, occurredAtUtc, duplicate: true, accepted: false, stale: false, removed: false, ticket: ticketId ? get(portalId, ticketId) : null };
        }

        const policy = getPolicy(portalId);
        const rawTicket = input.ticket || input;
        const ticketKey = key(portalId, rawTicket.ticketId || rawTicket.id);
        let ticket = null;
        let accepted = false;
        let stale = false;
        let duplicate = false;
        let removed = false;
        if (policyAllows(policy, rawTicket)) {
            assertCapacity(ticketKey);
            const normalized = normalize(portalId, applyPolicy(policy, rawTicket), state.tickets[ticketKey], context);
            ticket = normalized.ticket;
            stale = normalized.stale;
            duplicate = normalized.duplicate;
            if (normalized.changed) state.tickets[ticketKey] = normalized.ticket;
            accepted = normalized.changed;
        } else if (state.tickets[ticketKey]) {
            delete state.tickets[ticketKey];
            removed = true;
            accepted = true;
        }

        events[eventId] = { hash: eventHash, occurredAtUtc, receivedAtUtc: new Date(now()).toISOString() };
        const ordered = Object.entries(events).sort((left, right) => left[1].receivedAtUtc.localeCompare(right[1].receivedAtUtc));
        for (const [oldId] of ordered.slice(0, Math.max(0, ordered.length - maxEventIdsPerPortal))) delete events[oldId];
        state.portalEvents[portalId] = events;
        persist();
        return { type: eventType, eventId, occurredAtUtc, duplicate, accepted, stale, removed, ticket: ticket ? clone(ticket) : null };
    }
    function matches(item, filter, allowedPortals) {
        const search = String(filter.search || "").trim().toLowerCase();
        return (!allowedPortals || allowedPortals.has(item.portalId))
            && (!filter.portalId || item.portalId === filter.portalId)
            && (!filter.status || item.status === filter.status)
            && (!filter.priority || item.priority === filter.priority)
            && (!filter.tenantId || item.tenantId === filter.tenantId)
            && (!filter.customerId || item.customerId === filter.customerId)
            && (!filter.siteId || item.siteId === filter.siteId)
            && (!filter.slaBreached || item.sla.breached)
            && (!search || [item.ticketId, item.title, item.externalId, item.requester && item.requester.displayName].join(" ").toLowerCase().includes(search));
    }
    function list(filter = {}) {
        const allowedPortals = Array.isArray(filter.portalIds) ? new Set(filter.portalIds) : null;
        const limit = Math.round(finiteNumber(filter.limit, 200, 1, 1000));
        return Object.values(state.tickets)
            .filter(item => matches(item, filter, allowedPortals))
            .sort((left, right) => right.updatedAtUtc.localeCompare(left.updatedAtUtc))
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
            item.central.requestedStatus = item.status;
            changed = true;
        }
        if (changes.assignee != null) {
            item.assignee = optionalPerson(changes.assignee);
            item.central.requestedAssignee = clone(item.assignee);
            changed = true;
        }
        if (changes.centralOwner != null) {
            item.central.centralOwner = text(changes.centralOwner, 180);
            changed = true;
        }
        if (changes.note != null) {
            item.central.lastNote = text(changes.note, 2000);
            changed = true;
        }
        if (!changed) throw storeError("No supported ticket changes were supplied.", "TICKET_CHANGE_EMPTY");
        item.central.lastChangedBy = String(actor && (actor.identityKey || actor.username) || "system").slice(0, 180);
        item.central.lastChangedAtUtc = new Date(now()).toISOString();
        item.central.pendingPortalSync = true;
        item.updatedAtUtc = item.central.lastChangedAtUtc;
        persist();
        return clone(item);
    }
    function summary(filter = {}) {
        const allowedPortals = Array.isArray(filter.portalIds) ? new Set(filter.portalIds) : null;
        const counts = Object.fromEntries(STATUSES.map(value => [value, 0]));
        let total = 0;
        let critical = 0;
        let slaBreached = 0;
        let syncFailed = 0;
        for (const ticket of Object.values(state.tickets)) {
            if (!matches(ticket, filter, allowedPortals)) continue;
            total += 1;
            counts[ticket.status] = (counts[ticket.status] || 0) + 1;
            if (ticket.priority === "critical" && !TERMINAL_STATUSES.has(ticket.status)) critical += 1;
            if (ticket.sla.breached && !TERMINAL_STATUSES.has(ticket.status)) slaBreached += 1;
            if (["failed", "conflict"].includes(ticket.sync.state)) syncFailed += 1;
        }
        return { total, counts, critical, slaBreached, syncFailed };
    }
    function setPolicy(portalId, policy) {
        portalId = identifier(portalId, "Portal ID");
        const normalized = normalizePolicy(policy);
        state.policies[portalId] = normalized;
        let purgedProjections = 0;
        let redactedProjections = 0;
        for (const [ticketKey, ticket] of Object.entries(state.tickets)) {
            if (ticket.portalId !== portalId) continue;
            if (!policyAllows(normalized, ticket)) {
                delete state.tickets[ticketKey];
                purgedProjections += 1;
                continue;
            }
            if (!normalized.includeDescription && ticket.description) {
                ticket.description = "";
                redactedProjections += 1;
            }
            if (!normalized.includeRequester && ticket.requester) {
                ticket.requester = null;
                redactedProjections += 1;
            }
        }
        if (normalized.mode === "none") {
            delete state.portalCursors[portalId];
            delete state.portalEvents[portalId];
        }
        persist();
        return Object.assign(clone(normalized), { purgedProjections, redactedProjections });
    }
    function removePortal(portalId) {
        portalId = identifier(portalId, "Portal ID");
        let removed = 0;
        for (const [ticketKey, ticket] of Object.entries(state.tickets)) {
            if (ticket.portalId === portalId) {
                delete state.tickets[ticketKey];
                removed += 1;
            }
        }
        delete state.portalCursors[portalId];
        delete state.portalEvents[portalId];
        delete state.policies[portalId];
        persist();
        return removed;
    }

    return {
        upsert,
        snapshot,
        event,
        list,
        get,
        updateCentral,
        summary,
        getPolicy,
        setPolicy,
        removePortal,
        filePath,
        STATUSES,
        PRIORITIES,
        SYNC_STATES,
        EVENTS,
        POLICY_MODES
    };
}

module.exports = {
    create,
    STATUSES,
    PRIORITIES,
    SYNC_STATES,
    EVENTS,
    POLICY_MODES,
    defaultPolicy,
    normalizePolicy,
    policyAllows,
    digest
};
