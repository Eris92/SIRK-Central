"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { hashSecret, verifySecret } = require("./security");
const { normalizeRole, canAssignRole } = require("./rbac");

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

function create(options) {
    const dataDir = path.resolve(options.dataDir);
    const storePath = path.join(dataDir, "users.json");
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });

    function emptyRegistry() { return { schema: 2, localUsers: [], entraRoles: {}, breakGlassPasswordHash: "", accessKeyHash: "" }; }
    function read() {
        if (!fs.existsSync(storePath)) return emptyRegistry();
        const value = JSON.parse(fs.readFileSync(storePath, "utf8"));
        if (!value || ![1, 2].includes(value.schema) || !Array.isArray(value.localUsers) || typeof value.entraRoles !== "object") throw new Error("User registry has an unsupported format.");
        value.schema = 2; value.breakGlassPasswordHash ||= ""; value.accessKeyHash ||= ""; return value;
    }
    function write(value) {
        value.schema = 2;
        const temporary = storePath + ".tmp-" + process.pid + "-" + Date.now();
        fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
        fs.renameSync(temporary, storePath);
    }

    function authenticateLocal(username, password) {
        let normalized; try { normalized = normalizeUsername(username); } catch (_) { return null; }
        const user = read().localUsers.find(item => item.username === normalized && item.enabled !== false);
        return user && verifySecret(String(password || ""), user.passwordHash)
            ? { username: user.username, displayName: user.displayName || user.username, role: normalizeRole(user.role), builtIn: false, source: "local" }
            : null;
    }

    function listUsers() {
        const registry = read();
        return registry.localUsers.map(({ passwordHash, ...user }) => Object.assign({ source: "local", status: "active" }, user))
            .concat(Object.entries(registry.entraRoles).map(([identityKey, item]) => ({
                identityKey,
                username: item.username || identityKey,
                displayName: item.displayName || item.username || identityKey,
                role: item.role || null,
                source: "entra",
                status: item.role ? "active" : "pending",
                enabled: item.enabled !== false,
                createdAtUtc: item.createdAtUtc
            })));
    }

    function createLocalUser(input, actor) {
        const username = normalizeUsername(input.username);
        const password = String(input.password || "");
        if (password.length < 14) throw new Error("Password must contain at least 14 characters.");
        const role = normalizeRole(input.role);
        if (!canAssignRole(actor, role, "")) throw new Error("You are not allowed to assign this role.");
        const registry = read();
        if (registry.localUsers.some(item => item.username === username)) throw new Error("Username already exists.");
        registry.localUsers.push({ username, displayName: String(input.displayName || username).trim().slice(0, 100), passwordHash: hashSecret(password), role, enabled: true, createdAtUtc: new Date().toISOString() });
        write(registry);
        return { username, role, source: "local" };
    }

    function updateRole(identity, role, actor) {
        const normalizedRole = normalizeRole(role);
        const registry = read();
        if (identity.source === "local") {
            const username = normalizeUsername(identity.key);
            const user = registry.localUsers.find(item => item.username === username);
            if (!user) throw new Error("Local user not found.");
            if (!canAssignRole(actor, normalizedRole, user.role)) throw new Error("You are not allowed to change this role.");
            user.role = normalizedRole;
        } else {
            const key = normalizeIdentityKey(identity.key);
            const current = registry.entraRoles[key];
            if (!current) throw new Error("Entra identity must sign in once before a role can be assigned.");
            if (!canAssignRole(actor, normalizedRole, current.role)) throw new Error("You are not allowed to change this role.");
            current.role = normalizedRole;
            current.enabled = true;
            current.roleAssignedAtUtc = new Date().toISOString();
        }
        write(registry);
        return { source: identity.source, key: identity.key, role: normalizedRole };
    }

    function roleForEntra(identityKey, profile) {
        const registry = read();
        const key = normalizeIdentityKey(identityKey);
        const existing = registry.entraRoles[key];
        if (existing) {
            if (existing.enabled === false) throw new Error("This Entra account is disabled in SIRK Central.");
            return existing.role ? normalizeRole(existing.role) : null;
        }
        registry.entraRoles[key] = {
            username: profile.username || "",
            displayName: profile.displayName || "",
            role: null,
            enabled: true,
            createdAtUtc: new Date().toISOString()
        };
        write(registry);
        return null;
    }

    function setBreakGlassPassword(password) {
        if (String(password || "").length < 14) throw new Error("Password must contain at least 14 characters.");
        const registry = read(); registry.breakGlassPasswordHash = hashSecret(password); write(registry);
    }
    function setAccessKeyHash(hash) { const registry = read(); registry.accessKeyHash = String(hash || ""); write(registry); }
    function securityOverrides() { const registry = read(); return { breakGlassPasswordHash: registry.breakGlassPasswordHash, accessKeyHash: registry.accessKeyHash }; }

    return { authenticateLocal, listUsers, createLocalUser, updateRole, roleForEntra, setBreakGlassPassword, setAccessKeyHash, securityOverrides };
}

module.exports = { create, normalizeUsername, normalizeIdentityKey };
