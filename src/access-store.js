"use strict";

const fs = require("node:fs");
const path = require("node:path");

const CAPABILITIES = Object.freeze([
    "portal.view",
    "portal.connect",
    "device.desktop.connect",
    "device.terminal.execute",
    "device.files.read",
    "device.files.write",
    "device.registry.read",
    "device.registry.write",
    "device.software.manage",
    "device.services.manage"
]);
const STATES = new Set(["allow", "deny", "approval", "inherit"]);
const RANK = Object.freeze({ deny: 0, approval: 1, allow: 2 });

const ROLE_CAPABILITIES = Object.freeze({
    Auditor: { "portal.view": "allow" },
    OperatorL1: { "portal.view": "allow", "portal.connect": "allow", "device.desktop.connect": "allow" },
    SupportL2: { "portal.view": "allow", "portal.connect": "allow", "device.desktop.connect": "allow", "device.terminal.execute": "allow", "device.files.read": "allow", "device.services.manage": "approval" },
    EngineerL3: Object.fromEntries(CAPABILITIES.map((capability) => [capability, "allow"])),
    Admin: { "portal.view": "allow", "portal.connect": "allow" },
    SecAdmin: { "portal.view": "allow", "portal.connect": "approval" },
    BreakGlass: Object.fromEntries(CAPABILITIES.map((capability) => [capability, "allow"]))
});

function safeId(value, label) {
    const id = String(value || "").trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{2,62}$/.test(id)) throw new Error(label + " ID must use 3-63 lowercase letters, digits or hyphens.");
    return id;
}
function memberKey(identity) {
    if (!identity) return "";
    if (identity.source === "entra") return "entra:" + String(identity.identityKey || "").toLowerCase();
    return "local:" + String(identity.username || "").toLowerCase();
}
function normalizeMembers(values) {
    return [...new Set((Array.isArray(values) ? values : []).map((value) => String(value || "").trim().toLowerCase()).filter((value) => /^(?:local:[a-z0-9._-]{3,64}|entra:[0-9a-f-]{36}:[0-9a-f-]{36})$/.test(value)))];
}
function normalizePortalIds(values) {
    return [...new Set((Array.isArray(values) ? values : []).map((value) => safeId(value, "Portal")))];
}
function normalizePolicy(value, allowInherit) {
    const result = {};
    const source = value && typeof value === "object" ? value : {};
    for (const capability of CAPABILITIES) {
        const state = String(source[capability] || (allowInherit ? "inherit" : "deny")).toLowerCase();
        if (!STATES.has(state) || (!allowInherit && state === "inherit")) throw new Error("Invalid state for " + capability + ".");
        result[capability] = state;
    }
    return result;
}
function restrictive(states) {
    const explicit = states.filter((state) => state && state !== "inherit");
    if (!explicit.length) return "deny";
    return explicit.reduce((current, state) => RANK[state] < RANK[current] ? state : current, explicit[0]);
}

function create(options) {
    const dataDir = path.resolve(options.dataDir);
    const storePath = path.join(dataDir, "access-control.json");
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    function empty() { return { schema: 1, teams: [], portalPolicies: {} }; }
    function read() {
        if (!fs.existsSync(storePath)) return empty();
        const value = JSON.parse(fs.readFileSync(storePath, "utf8"));
        if (!value || value.schema !== 1 || !Array.isArray(value.teams) || typeof value.portalPolicies !== "object") throw new Error("Access registry has an unsupported format.");
        return value;
    }
    function write(value) {
        const temporary = storePath + ".tmp-" + process.pid + "-" + Date.now();
        fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
        fs.renameSync(temporary, storePath);
    }
    function listTeams() { return read().teams; }
    function saveTeam(input) {
        const registry = read();
        const id = safeId(input.id, "Team");
        const name = String(input.name || "").trim();
        if (name.length < 2 || name.length > 100) throw new Error("Team name must contain 2-100 characters.");
        const item = {
            id,
            name,
            description: String(input.description || "").trim().slice(0, 300),
            members: normalizeMembers(input.members),
            portalIds: normalizePortalIds(input.portalIds),
            profile: normalizePolicy(input.profile, true),
            updatedAtUtc: new Date().toISOString()
        };
        const index = registry.teams.findIndex((team) => team.id === id);
        if (index >= 0) registry.teams[index] = item; else registry.teams.push(Object.assign({ createdAtUtc: new Date().toISOString() }, item));
        write(registry);
        return item;
    }
    function deleteTeam(id) {
        const registry = read(), normalized = safeId(id, "Team");
        const before = registry.teams.length;
        registry.teams = registry.teams.filter((team) => team.id !== normalized);
        if (registry.teams.length === before) throw new Error("Team not found.");
        write(registry);
    }
    function portalPolicy(portalId) {
        const registry = read();
        return normalizePolicy(registry.portalPolicies[safeId(portalId, "Portal")] || {}, true);
    }
    function savePortalPolicy(portalId, policy) {
        const registry = read(), id = safeId(portalId, "Portal");
        registry.portalPolicies[id] = normalizePolicy(policy, true);
        write(registry);
        return registry.portalPolicies[id];
    }
    function teamsFor(identity) {
        if (identity && identity.builtIn) return [];
        const key = memberKey(identity);
        return read().teams.filter((team) => team.members.includes(key));
    }
    function portalIdsFor(identity) {
        if (identity && identity.builtIn) return null;
        return [...new Set(teamsFor(identity).flatMap((team) => team.portalIds))];
    }
    function effective(identity, portalId) {
        const role = identity && (identity.builtIn ? "BreakGlass" : identity.role);
        const rolePolicy = normalizePolicy(ROLE_CAPABILITIES[role] || {}, false);
        if (identity && identity.builtIn) return { allowed: true, teams: ["Break-Glass"], capabilities: rolePolicy };
        const matching = teamsFor(identity).filter((team) => team.portalIds.includes(portalId));
        if (!matching.length) return { allowed: false, teams: [], capabilities: normalizePolicy({}, false) };
        const local = portalPolicy(portalId), capabilities = {};
        for (const capability of CAPABILITIES) {
            const teamState = restrictive(matching.map((team) => team.profile[capability]));
            capabilities[capability] = restrictive([rolePolicy[capability], teamState, local[capability]]);
        }
        return { allowed: capabilities["portal.view"] !== "deny", teams: matching.map((team) => team.id), capabilities };
    }
    function simulate(identity, portals) {
        return portals.map((portal) => Object.assign({ id: portal.id, name: portal.name }, effective(identity, portal.id)));
    }
    return { listTeams, saveTeam, deleteTeam, portalPolicy, savePortalPolicy, portalIdsFor, effective, simulate, memberKey };
}

module.exports = { create, CAPABILITIES, ROLE_CAPABILITIES, memberKey, normalizePolicy, restrictive };
