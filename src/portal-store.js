"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { hashSecret, verifySecret, randomToken } = require("./security");

function safePortalId(value) {
    const id = String(value || "").trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{2,62}$/.test(id)) {
        throw new Error("Portal ID must use 3-63 lowercase letters, digits or hyphens.");
    }
    return id;
}

function create(options) {
    const dataDir = path.resolve(options.dataDir);
    const storePath = path.join(dataDir, "portals.json");
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });

    function read() {
        if (!fs.existsSync(storePath)) return { schema: 1, portals: [] };
        const parsed = JSON.parse(fs.readFileSync(storePath, "utf8"));
        if (!parsed || parsed.schema !== 1 || !Array.isArray(parsed.portals)) {
            throw new Error("Portal registry has an unsupported format.");
        }
        return parsed;
    }

    function write(value) {
        const temporary = storePath + ".tmp-" + process.pid + "-" + Date.now();
        fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
        fs.renameSync(temporary, storePath);
    }

    function publicPortal(item) {
        return item ? {
            id: item.id,
            name: item.name,
            createdAtUtc: item.createdAtUtc,
            tokenRotatedAtUtc: item.tokenRotatedAtUtc || null
        } : null;
    }

    function list() {
        return read().portals.map(publicPortal);
    }

    function get(id) {
        let portalId;
        try { portalId = safePortalId(id); } catch (_) { return null; }
        return publicPortal(read().portals.find(item => item.id === portalId));
    }

    function createPortal(input) {
        const id = safePortalId(input.id);
        const name = String(input.name || "").trim();
        if (name.length < 2 || name.length > 100) throw new Error("Portal name must contain 2-100 characters.");
        const registry = read();
        if (registry.portals.some((item) => item.id === id)) throw new Error("Portal ID already exists.");
        const token = randomToken(32);
        const createdAtUtc = new Date().toISOString();
        registry.portals.push({
            id,
            name,
            tokenHash: hashSecret(token),
            createdAtUtc,
            tokenRotatedAtUtc: createdAtUtc
        });
        write(registry);
        return { id, name, token, createdAtUtc };
    }

    function authenticate(id, token) {
        let portalId;
        try { portalId = safePortalId(id); } catch (_) { return null; }
        const portal = read().portals.find((item) => item.id === portalId);
        return portal && verifySecret(token, portal.tokenHash)
            ? publicPortal(portal)
            : null;
    }

    function rotateToken(id) {
        const portalId = safePortalId(id);
        const registry = read();
        const portal = registry.portals.find(item => item.id === portalId);
        if (!portal) throw new Error("Portal was not found.");
        const token = randomToken(32);
        portal.tokenHash = hashSecret(token);
        portal.tokenRotatedAtUtc = new Date().toISOString();
        write(registry);
        return Object.assign(publicPortal(portal), { token });
    }

    function remove(id) {
        const portalId = safePortalId(id);
        const registry = read();
        const index = registry.portals.findIndex(item => item.id === portalId);
        if (index < 0) return null;
        const removed = registry.portals.splice(index, 1)[0];
        write(registry);
        return publicPortal(removed);
    }

    return { list, get, createPortal, authenticate, rotateToken, remove };
}

module.exports = { create, safePortalId };
