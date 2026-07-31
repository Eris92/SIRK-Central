"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { hashSecret, verifySecret } = require("./security");
const { ASSIGNABLE_ROLES, normalizeRole, canAssignRole } = require("./rbac");

const STANDARD_ROLES = new Set(["Auditor", "OperatorL1", "SupportL2", "EngineerL3"]);
const PRIVILEGED_ROLES = new Set(["Admin", "SecAdmin"]);

function normalizeUsername(value) {
    const username = String(value || "").trim().toLowerCase();
    if (!/^[a-z0-9._-]{3,64}$/.test(username)) throw new Error("Username must use 3-64 letters, digits, dots, underscores or hyphens.");
    return username;
}
function normalizeIdentityKey(value) {
    const key = String(value || "").trim().toLowerCase();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(key)) throw new Error("Invalid Entra identity key.");
    return key;
}
function normalizeClaimRoles(value) {
    const allowed = new Set(ASSIGNABLE_ROLES);
    return [...new Set((Array.isArray(value) ? value : []).map(item => String(item || "").trim()).filter(item => allowed.has(item)))];
}
function approvalAllowed(actor, targetRole, targetIdentityKey) {
    if (!actor || !PRIVILEGED_ROLES.has(targetRole)) return false;
    if (actor.builtIn === true && actor.source === "local" && actor.role === "BreakGlass") return true;
    if (actor.role !== "SecAdmin" || actor.status && actor.status !== "active") return false;
    if (targetRole !== "SecAdmin") return false;
    return !actor.identityKey || actor.identityKey.toLowerCase() !== targetIdentityKey.toLowerCase();
}

function create(options) {
    const dataDir = path.resolve(options.dataDir);
    const storePath = path.join(dataDir, "users.json");
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });

    function emptyRegistry() { return { schema: 2, localUsers: [], entraRoles: {}, breakGlassPasswordHash: "", accessKeyHash: "" }; }
    function read() {
        if (!fs.existsSync(storePath)) return emptyRegistry();
        const value = JSON.parse(fs.readFileSync(storePath, "utf8"));
        if (!value || ![1, 2].includes(value.schema) || !Array.isArray(value.localUsers) || typeof value.entraRoles !== "object") throw new Error("User registry has an unsupported format.");
        value.schema = 2; value.breakGlassPasswordHash ||= ""; value.accessKeyHash ||= "";
        for (const [key, raw] of Object.entries(value.entraRoles)) {
            if (!raw || typeof raw !== "object" || Array.isArray(raw)) value.entraRoles[key] = { role: typeof raw === "string" ? raw : null };
            const item = value.entraRoles[key];
            item.claimedRoles = normalizeClaimRoles(item.claimedRoles);
            item.requestedRole ||= null;
            item.approvedRole ||= null;
            item.roleSource ||= item.role ? "manual" : "entra";
            item.status ||= item.role ? "active" : "pending";
        }
        return value;
    }
    function write(value) {
        value.schema = 2;
        const temporary = storePath + ".tmp-" + process.pid + "-" + crypto.randomBytes(6).toString("hex");
        let descriptor;
        try {
            descriptor = fs.openSync(temporary, "wx", 0o600);
            fs.writeFileSync(descriptor, JSON.stringify(value, null, 2) + "\n", "utf8");
            fs.fsyncSync(descriptor);
            fs.closeSync(descriptor);
            descriptor = undefined;
            fs.renameSync(temporary, storePath);
        } catch (error) {
            if (descriptor !== undefined) {
                try { fs.closeSync(descriptor); } catch (_) { /* ignore cleanup failure */ }
            }
            try { fs.rmSync(temporary, { force: true }); } catch (_) { /* ignore cleanup failure */ }
            throw error;
        }
    }
    function publicEntra(identityKey, item) {
        return {
            identityKey,
            username:item.username || identityKey,
            displayName:item.displayName || item.username || identityKey,
            role:item.role || null,
            requestedRole:item.requestedRole || null,
            claimedRoles:normalizeClaimRoles(item.claimedRoles),
            roleSource:item.roleSource || null,
            source:"entra",
            status:item.status || (item.role ? "active" : "pending"),
            enabled:item.enabled !== false,
            createdAtUtc:item.createdAtUtc,
            roleAssignedAtUtc:item.roleAssignedAtUtc,
            approvedAtUtc:item.approvedAtUtc,
            approvedBy:item.approvedBy || null
        };
    }

    function authenticateLocal(username, password) {
        let normalized; try { normalized = normalizeUsername(username); } catch (_) { return null; }
        const user = read().localUsers.find(item => item.username === normalized && item.enabled !== false);
        return user && verifySecret(String(password || ""), user.passwordHash)
            ? { username:user.username, displayName:user.displayName || user.username, role:normalizeRole(user.role), builtIn:false, source:"local", status:"active" }
            : null;
    }
    function listUsers(actor) {
        const registry = read();
        return registry.localUsers.map(({ passwordHash, ...user }) => Object.assign({ source:"local", status:"active", canApprove:false }, user))
            .concat(Object.entries(registry.entraRoles).map(([identityKey,item]) => {
                const result = publicEntra(identityKey,item);
                result.canApprove = Boolean(result.requestedRole && approvalAllowed(actor,result.requestedRole,identityKey));
                return result;
            }));
    }
    function createLocalUser(input, actor) {
        const username = normalizeUsername(input.username); const password = String(input.password || "");
        if (password.length < 14) throw new Error("Password must contain at least 14 characters.");
        const role = normalizeRole(input.role);
        if (!canAssignRole(actor, role, "")) throw new Error("You are not allowed to assign this role.");
        const registry = read(); if (registry.localUsers.some(item => item.username === username)) throw new Error("Username already exists.");
        registry.localUsers.push({ username, displayName:String(input.displayName || username).trim().slice(0,100), passwordHash:hashSecret(password), role, enabled:true, createdAtUtc:new Date().toISOString() });
        write(registry); return { username, role, source:"local" };
    }
    function updateRole(identity, role, actor) {
        const normalizedRole = normalizeRole(role); const registry = read();
        if (identity.source === "local") {
            const username = normalizeUsername(identity.key); const user = registry.localUsers.find(item => item.username === username);
            if (!user) throw new Error("Local user not found.");
            if (!canAssignRole(actor, normalizedRole, user.role)) throw new Error("You are not allowed to change this role.");
            user.role = normalizedRole;
        } else {
            const key = normalizeIdentityKey(identity.key); const current = registry.entraRoles[key];
            if (!current) throw new Error("Entra identity must sign in once before a role can be assigned.");
            if (PRIVILEGED_ROLES.has(normalizedRole)) {
                if (current.requestedRole === normalizedRole) {
                    if (!approvalAllowed(actor, normalizedRole, key)) throw new Error("You are not allowed to approve this privileged role.");
                    current.role = normalizedRole; current.approvedRole = normalizedRole; current.requestedRole = null; current.status = "active"; current.roleSource = "entra-approved";
                    current.approvedAtUtc = new Date().toISOString(); current.approvedBy = actor.builtIn ? "BreakGlass" : actor.identityKey || actor.username;
                } else {
                    if (!actor.builtIn) throw new Error("A privileged Entra role can only be assigned without a pending request by Break-Glass.");
                    current.role = normalizedRole; current.roleSource = "manual"; current.status = "active"; current.requestedRole = null; current.approvedRole = null;
                }
            } else {
                if (!canAssignRole(actor, normalizedRole, current.role)) throw new Error("You are not allowed to change this role.");
                current.role = normalizedRole; current.roleSource = "manual"; current.status = "active"; current.requestedRole = null; current.approvedRole = null;
            }
            current.enabled = true; current.roleAssignedAtUtc = new Date().toISOString();
        }
        write(registry); return { source:identity.source, key:identity.key, role:normalizedRole };
    }
    function resolveEntra(identityKey, profile, claimedRoles) {
        const registry = read(); const key = normalizeIdentityKey(identityKey); const roles = normalizeClaimRoles(claimedRoles); const now = new Date().toISOString();
        const item = registry.entraRoles[key] || { role:null, enabled:true, createdAtUtc:now, roleSource:"entra", status:"pending", requestedRole:null, approvedRole:null };
        if (item.enabled === false) throw new Error("This Entra account is disabled in SIRK Central.");
        item.username = profile.username || item.username || ""; item.displayName = profile.displayName || item.displayName || ""; item.claimedRoles = roles; item.lastSignInAtUtc = now;

        if (roles.length > 1) {
            item.role = null; item.requestedRole = null; item.approvedRole = null; item.roleSource = "entra"; item.status = "conflict";
        } else if (roles.length === 1 && STANDARD_ROLES.has(roles[0])) {
            item.role = roles[0]; item.requestedRole = null; item.approvedRole = null; item.roleSource = "entra"; item.status = "active"; item.roleAssignedAtUtc = now;
        } else if (roles.length === 1 && PRIVILEGED_ROLES.has(roles[0])) {
            const requested = roles[0];
            if (item.approvedRole === requested && item.role === requested) {
                item.requestedRole = null; item.roleSource = "entra-approved"; item.status = "active";
            } else {
                if (PRIVILEGED_ROLES.has(item.role)) item.role = null;
                item.requestedRole = requested; item.approvedRole = null; item.status = "pending";
                if (item.roleSource !== "manual" || PRIVILEGED_ROLES.has(item.role)) item.roleSource = "entra";
            }
        } else if (item.roleSource !== "manual") {
            item.role = null; item.requestedRole = null; item.approvedRole = null; item.roleSource = "entra"; item.status = "pending";
        }
        registry.entraRoles[key] = item; write(registry); return publicEntra(key,item);
    }
    function roleForEntra(identityKey, profile) { return resolveEntra(identityKey, profile || {}, []).role; }
    function approveEntraRole(identityKey, actor) {
        const registry = read(); const key = normalizeIdentityKey(identityKey); const item = registry.entraRoles[key];
        if (!item || !item.requestedRole) throw new Error("No privileged role is waiting for approval.");
        const role = normalizeRole(item.requestedRole);
        if (!approvalAllowed(actor, role, key)) throw new Error("You are not allowed to approve this privileged role.");
        item.role = role; item.approvedRole = role; item.requestedRole = null; item.status = "active"; item.roleSource = "entra-approved"; item.roleAssignedAtUtc = new Date().toISOString(); item.approvedAtUtc = item.roleAssignedAtUtc; item.approvedBy = actor.builtIn ? "BreakGlass" : actor.identityKey || actor.username;
        write(registry); return publicEntra(key,item);
    }
    function rejectEntraRole(identityKey, actor) {
        const registry = read(); const key = normalizeIdentityKey(identityKey); const item = registry.entraRoles[key];
        if (!item || !item.requestedRole) throw new Error("No privileged role is waiting for approval.");
        if (!approvalAllowed(actor,item.requestedRole,key)) throw new Error("You are not allowed to reject this privileged role.");
        item.requestedRole = null; item.approvedRole = null; item.status = item.role ? "active" : "pending"; item.rejectedAtUtc = new Date().toISOString(); item.rejectedBy = actor.builtIn ? "BreakGlass" : actor.identityKey || actor.username;
        write(registry); return publicEntra(key,item);
    }
    function setBreakGlassPassword(password) { if (String(password || "").length < 14) throw new Error("Password must contain at least 14 characters."); const registry=read(); registry.breakGlassPasswordHash=hashSecret(password); write(registry); }
    function setAccessKeyHash(hash) { const registry=read(); registry.accessKeyHash=String(hash || ""); write(registry); }
    function securityOverrides() { const registry=read(); return { breakGlassPasswordHash:registry.breakGlassPasswordHash, accessKeyHash:registry.accessKeyHash }; }

    return { authenticateLocal, listUsers, createLocalUser, updateRole, roleForEntra, resolveEntra, approveEntraRole, rejectEntraRole, setBreakGlassPassword, setAccessKeyHash, securityOverrides };
}
module.exports = { create, normalizeUsername, normalizeIdentityKey, normalizeClaimRoles, approvalAllowed };
