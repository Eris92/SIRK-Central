"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function atomicWrite(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const temporaryPath = filePath + ".tmp-" + process.pid + "-" + crypto.randomBytes(6).toString("hex");
    fs.writeFileSync(temporaryPath, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    fs.renameSync(temporaryPath, filePath);
}

function normalizeName(value, field) {
    const name = String(value || "").trim().replace(/\s+/g, " ");
    if (name.length < 2 || name.length > 120) throw new Error(field + " must contain 2-120 characters.");
    return name;
}

function normalizeCode(value, field) {
    const code = String(value || "").trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(code)) throw new Error(field + " must be a lowercase slug.");
    return code;
}

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function create(options) {
    options = options || {};
    const dataDir = path.resolve(options.dataDir || path.join(process.cwd(), "data"));
    const filePath = path.join(dataDir, "organizations.json");
    const now = typeof options.now === "function" ? options.now : Date.now;
    const randomId = typeof options.randomId === "function"
        ? options.randomId
        : prefix => prefix + "-" + crypto.randomBytes(9).toString("base64url").toLowerCase();
    let state = { version: 1, tenants: {}, customers: {}, sites: {} };

    function load() {
        try {
            const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
            if (!parsed || parsed.version !== 1 || typeof parsed.tenants !== "object" || Array.isArray(parsed.tenants) || typeof parsed.customers !== "object" || Array.isArray(parsed.customers) || typeof parsed.sites !== "object" || Array.isArray(parsed.sites)) throw new Error("Organization store has an unsupported schema.");
            state = parsed;
        } catch (error) {
            if (error.code !== "ENOENT") throw error;
        }
    }

    function persist() {
        atomicWrite(filePath, state);
    }

    function ensureUnique(collection, code, exceptId) {
        const duplicate = Object.values(collection).find(item => item.code === code && item.id !== exceptId && !item.deletedAtUtc);
        if (duplicate) throw new Error("Code is already in use.");
    }

    function actorValue(actor) {
        return String(actor && (actor.identityKey || actor.username) || "system").slice(0, 180);
    }

    function createTenant(input, actor) {
        const code = normalizeCode(input && input.code, "Tenant code");
        ensureUnique(state.tenants, code);
        const timestamp = new Date(now()).toISOString();
        const tenant = {
            id: randomId("ten"),
            code,
            name: normalizeName(input && input.name, "Tenant name"),
            status: "active",
            createdAtUtc: timestamp,
            createdBy: actorValue(actor),
            updatedAtUtc: timestamp,
            updatedBy: actorValue(actor)
        };
        state.tenants[tenant.id] = tenant;
        persist();
        return clone(tenant);
    }

    function createCustomer(input, actor) {
        const tenant = state.tenants[String(input && input.tenantId || "")];
        if (!tenant || tenant.deletedAtUtc) throw new Error("Tenant not found.");
        const code = normalizeCode(input && input.code, "Customer code");
        const duplicate = Object.values(state.customers).find(item => item.tenantId === tenant.id && item.code === code && !item.deletedAtUtc);
        if (duplicate) throw new Error("Customer code is already in use in this tenant.");
        const timestamp = new Date(now()).toISOString();
        const customer = {
            id: randomId("cus"),
            tenantId: tenant.id,
            code,
            name: normalizeName(input && input.name, "Customer name"),
            status: "active",
            createdAtUtc: timestamp,
            createdBy: actorValue(actor),
            updatedAtUtc: timestamp,
            updatedBy: actorValue(actor)
        };
        state.customers[customer.id] = customer;
        persist();
        return clone(customer);
    }

    function createSite(input, actor) {
        const customer = state.customers[String(input && input.customerId || "")];
        if (!customer || customer.deletedAtUtc) throw new Error("Customer not found.");
        const code = normalizeCode(input && input.code, "Site code");
        const duplicate = Object.values(state.sites).find(item => item.customerId === customer.id && item.code === code && !item.deletedAtUtc);
        if (duplicate) throw new Error("Site code is already in use for this customer.");
        const timestamp = new Date(now()).toISOString();
        const site = {
            id: randomId("site"),
            tenantId: customer.tenantId,
            customerId: customer.id,
            code,
            name: normalizeName(input && input.name, "Site name"),
            status: "active",
            createdAtUtc: timestamp,
            createdBy: actorValue(actor),
            updatedAtUtc: timestamp,
            updatedBy: actorValue(actor)
        };
        state.sites[site.id] = site;
        persist();
        return clone(site);
    }

    function setStatus(kind, id, status, actor) {
        if (!['active', 'disabled'].includes(status)) throw new Error("Unsupported status.");
        const collection = kind === "tenant" ? state.tenants : kind === "customer" ? state.customers : kind === "site" ? state.sites : null;
        if (!collection || !collection[id] || collection[id].deletedAtUtc) throw new Error("Organization object not found.");
        collection[id].status = status;
        collection[id].updatedAtUtc = new Date(now()).toISOString();
        collection[id].updatedBy = actorValue(actor);
        persist();
        return clone(collection[id]);
    }

    function remove(kind, id, actor) {
        const collection = kind === "tenant" ? state.tenants : kind === "customer" ? state.customers : kind === "site" ? state.sites : null;
        if (!collection || !collection[id] || collection[id].deletedAtUtc) throw new Error("Organization object not found.");
        if (kind === "tenant" && Object.values(state.customers).some(item => item.tenantId === id && !item.deletedAtUtc)) throw new Error("Tenant still contains customers.");
        if (kind === "customer" && Object.values(state.sites).some(item => item.customerId === id && !item.deletedAtUtc)) throw new Error("Customer still contains sites.");
        collection[id].status = "deleted";
        collection[id].deletedAtUtc = new Date(now()).toISOString();
        collection[id].deletedBy = actorValue(actor);
        persist();
        return clone(collection[id]);
    }

    function list() {
        return {
            tenants: Object.values(state.tenants).filter(item => !item.deletedAtUtc).map(clone),
            customers: Object.values(state.customers).filter(item => !item.deletedAtUtc).map(clone),
            sites: Object.values(state.sites).filter(item => !item.deletedAtUtc).map(clone)
        };
    }

    function tree() {
        const active = list();
        return active.tenants.map(tenant => Object.assign({}, tenant, {
            customers: active.customers.filter(customer => customer.tenantId === tenant.id).map(customer => Object.assign({}, customer, {
                sites: active.sites.filter(site => site.customerId === customer.id)
            }))
        }));
    }

    load();
    return { createTenant, createCustomer, createSite, setStatus, remove, list, tree, filePath };
}

module.exports = { create, normalizeCode, normalizeName };
