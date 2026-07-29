"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { hashSecret, verifySecret } = require("./security");

const VALID_ROLES = new Set(["Admin", "SecAdmin"]);

function normalizeUsername(value) {
    const username = String(value || "").trim().toLowerCase();
    if (!/^[a-z0-9._-]{3,64}$/.test(username)) {
        throw new Error("Username must use 3-64 letters, digits, dots, underscores or hyphens.");
    }
    return username;
}

function normalizeRole(value) {
    const role = String(value || "").trim();
    if (!VALID_ROLES.has(role)) throw new Error("Role must be Admin or SecAdmin.");
    return role;
}

function create(options) {
    const dataDir = path.resolve(options.dataDir);
    const storePath = path.join(dataDir, "users.json");
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });

    function read() {
        if (!fs.existsSync(storePath)) {
            return { schema: 1, localUsers: [], entraRoles: {}, breakGlassPasswordHash: "", accessKeyHash: "" };
        }
        const value = JSON.parse(fs.readFileSync(storePath, "utf8"));
        if (!value || value.schema !== 1 || !Array.isArray(value.localUsers) || typeof value.entraRoles !== "object") {
            throw new Error("User registry has an unsupported format.");
        }
        value.breakGlassPasswordHash ||= "";
        value.accessKeyHash ||= "";
        return value;
    }

    function write(value) {
        const temporary = storePath + ".tmp-" + process.pid + "-" + Date.now();
        fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
        fs.renameSync(temporary, storePath);
    }

    function authenticateLocal(username, password) {
        let normalized;
        try { normalized = normalizeUsername(username); } catch (_) { return null; }
        const user = read().localUsers.find((item) => item.username === normalized && item.enabled !== false);
        return user && verifySecret(String(password || ""), user.passwordHash)
            ? { username: user.username, displayName: user.displayName || user.username, role: user.role, builtIn: false }
            : null;
    }

    function listUsers() {
        const registry = read();
        return registry.localUsers.map(({ passwordHash, ...user }) => Object.assign({ source: "local" }, user))
            .concat(Object.entries(registry.entraRoles).map(([identityKey, item]) => ({
                identityKey,
                username: item.username || identityKey,
                displayName: item.displayName || item.username || identityKey,
                role: item.role,
                source: "entra",
                enabled: item.enabled !== false
            })));
    }

    function ensureRoleGrantAllowed(role, actor) {
        if (role === "SecAdmin" && !actor.canGrantSecAdmin) {
            throw new Error("Only SecAdmin or Break-Glass can grant SecAdmin.");
        }
    }

    function createLocalUser(input, actor) {
        const username = normalizeUsername(input.username);
        const password = String(input.password || "");
        if (password.length < 14) throw new Error("Password must contain at least 14 characters.");
        const role = normalizeRole(input.role);
        ensureRoleGrantAllowed(role, actor);
        const registry = read();
        if (registry.localUsers.some((item) => item.username === username)) throw new Error("Username already exists.");
        registry.localUsers.push({
            username,
            displayName: String(input.displayName || username).trim().slice(0, 100),
            passwordHash: hashSecret(password),
            role,
            enabled: true,
            createdAtUtc: new Date().toISOString()
        });
        write(registry);
        return { username, role };
    }

    function updateRole(identity, role, actor) {
        const normalizedRole = normalizeRole(role);
        ensureRoleGrantAllowed(normalizedRole, actor);
        const registry = read();
        if (identity.source === "local") {
            const username = normalizeUsername(identity.key);
            const user = registry.localUsers.find((item) => item.username === username);
            if (!user) throw new Error("Local user not found.");
            if (user.role === "SecAdmin" && !actor.canGrantSecAdmin) {
                throw new Error("Only SecAdmin or Break-Glass can change SecAdmin membership.");
            }
            user.role = normalizedRole;
        } else {
            const key = String(identity.key || "").toLowerCase();
            if (!/^[0-9a-f-]{36}:[0-9a-f-]{36}$/.test(key)) throw new Error("Invalid Entra identity key.");
            const current = registry.entraRoles[key];
            if (current && current.role === "SecAdmin" && !actor.canGrantSecAdmin) {
                throw new Error("Only SecAdmin or Break-Glass can change SecAdmin membership.");
            }
            registry.entraRoles[key] = Object.assign({}, current || {}, { role: normalizedRole, enabled: true });
        }
        write(registry);
    }

    function roleForEntra(identityKey, profile) {
        const registry = read();
        const key = String(identityKey || "").toLowerCase();
        const existing = registry.entraRoles[key];
        if (existing) return existing.role;
        registry.entraRoles[key] = {
            username: profile.username || "",
            displayName: profile.displayName || "",
            role: "Admin",
            enabled: true,
            createdAtUtc: new Date().toISOString()
        };
        write(registry);
        return "Admin";
    }

    function setBreakGlassPassword(password) {
        if (String(password || "").length < 14) throw new Error("Password must contain at least 14 characters.");
        const registry = read();
        registry.breakGlassPasswordHash = hashSecret(password);
        write(registry);
    }

    function setAccessKeyHash(hash) {
        const registry = read();
        registry.accessKeyHash = String(hash || "");
        write(registry);
    }

    function securityOverrides() {
        const registry = read();
        return {
            breakGlassPasswordHash: registry.breakGlassPasswordHash,
            accessKeyHash: registry.accessKeyHash
        };
    }

    return {
        authenticateLocal,
        listUsers,
        createLocalUser,
        updateRole,
        roleForEntra,
        setBreakGlassPassword,
        setAccessKeyHash,
        securityOverrides
    };
}

module.exports = { create, normalizeUsername, normalizeRole };
