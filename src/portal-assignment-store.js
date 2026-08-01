"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function atomicWrite(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const temporary = filePath + ".tmp-" + process.pid + "-" + crypto.randomBytes(5).toString("hex");
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, filePath);
}

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function actorKey(actor) { return String(actor && (actor.identityKey || actor.username) || "system").slice(0, 180); }

function create(options) {
    options = options || {};
    const dataDir = path.resolve(options.dataDir || path.join(process.cwd(), "data"));
    const filePath = path.join(dataDir, "portal-assignments.json");
    const now = typeof options.now === "function" ? options.now : Date.now;
    let state = { version: 1, assignments: {} };

    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
        if (!parsed || parsed.version !== 1 || !parsed.assignments || typeof parsed.assignments !== "object") throw new Error("Portal assignment store has an unsupported schema.");
        state = parsed;
    } catch (error) {
        if (error.code !== "ENOENT") throw error;
    }

    function persist() { atomicWrite(filePath, state); }

    function validateHierarchy(organizations, tenantId, customerId, siteId) {
        const snapshot = organizations.list();
        const tenant = snapshot.tenants.find(item => item.id === tenantId);
        if (!tenant) throw new Error("Tenant not found.");
        const customer = snapshot.customers.find(item => item.id === customerId && item.tenantId === tenantId);
        if (!customer) throw new Error("Customer does not belong to the selected tenant.");
        const site = snapshot.sites.find(item => item.id === siteId && item.customerId === customerId && item.tenantId === tenantId);
        if (!site) throw new Error("Site does not belong to the selected customer.");
        if (tenant.status !== "active" || customer.status !== "active" || site.status !== "active") {
            throw new Error("Tenant, Customer and Site must be active.");
        }
        return { tenant, customer, site };
    }

    function assign(portalId, input, actor, organizations, portals) {
        portalId = String(portalId || "").trim();
        if (!/^[a-z0-9][a-z0-9-]{1,127}$/.test(portalId)) throw new Error("Portal id is invalid.");
        if (portals && !portals.list().some(portal => portal.id === portalId)) throw new Error("Portal not found.");
        const tenantId = String(input && input.tenantId || "");
        const customerId = String(input && input.customerId || "");
        const siteId = String(input && input.siteId || "");
        validateHierarchy(organizations, tenantId, customerId, siteId);
        const timestamp = new Date(now()).toISOString();
        const previous = state.assignments[portalId];
        const assignment = {
            portalId,
            tenantId,
            customerId,
            siteId,
            createdAtUtc: previous ? previous.createdAtUtc : timestamp,
            createdBy: previous ? previous.createdBy : actorKey(actor),
            updatedAtUtc: timestamp,
            updatedBy: actorKey(actor)
        };
        state.assignments[portalId] = assignment;
        persist();
        return clone(assignment);
    }

    function remove(portalId, actor) {
        portalId = String(portalId || "");
        const current = state.assignments[portalId];
        if (!current) return false;
        delete state.assignments[portalId];
        persist();
        return { portalId, removedAtUtc: new Date(now()).toISOString(), removedBy: actorKey(actor) };
    }

    function get(portalId) {
        const value = state.assignments[String(portalId || "")];
        return value ? clone(value) : null;
    }

    function list() {
        return Object.values(state.assignments).sort((a, b) => a.portalId.localeCompare(b.portalId)).map(clone);
    }

    return { assign, remove, get, list, filePath };
}

module.exports = { create };
