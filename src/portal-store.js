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

    function list() {
        return read().portals.map((item) => ({
            id: item.id,
            name: item.name,
            createdAtUtc: item.createdAtUtc
        }));
    }

    function createPortal(input) {
        const id = safePortalId(input.id);
        const name = String(input.name || "").trim();
        if (name.length < 2 || name.length > 100) throw new Error("Portal name must contain 2-100 characters.");
        const registry = read();
        if (registry.portals.some((item) => item.id === id)) throw new Error("Portal ID already exists.");
        const token = randomToken(32);
        registry.portals.push({
            id,
            name,
            tokenHash: hashSecret(token),
            createdAtUtc: new Date().toISOString()
        });
        write(registry);
        return { id, name, token };
    }

    function authenticate(id, token) {
        let portalId;
        try { portalId = safePortalId(id); } catch (_) { return null; }
        const portal = read().portals.find((item) => item.id === portalId);
        return portal && verifySecret(token, portal.tokenHash)
            ? { id: portal.id, name: portal.name }
            : null;
    }

    return { list, createPortal, authenticate };
}

module.exports = { create, safePortalId };

