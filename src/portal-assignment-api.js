"use strict";

function json(res, status, body) {
    const data = Buffer.from(JSON.stringify(body));
    res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": String(data.length),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff"
    });
    res.end(data);
}

function readBody(req, limit = 32768) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on("data", chunk => {
            size += chunk.length;
            if (size > limit) {
                const error = new Error("Request body is too large.");
                error.statusCode = 413;
                reject(error);
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on("end", () => {
            try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
            catch (_) {
                const error = new Error("Invalid JSON body.");
                error.statusCode = 400;
                reject(error);
            }
        });
        req.on("error", reject);
    });
}

function canRead(identity) {
    return Boolean(identity && identity.ok && ["Admin", "SecAdmin", "Auditor"].includes(identity.role) || identity && identity.builtIn === true);
}

function canManage(identity) {
    return Boolean(identity && identity.ok && identity.role === "Admin" || identity && identity.builtIn === true);
}

function create(options) {
    const store = options.store;
    const organizations = options.organizations;
    const readIdentity = options.readIdentity;
    const readPortals = options.readPortals;
    if (!store || !organizations || typeof readIdentity !== "function" || typeof readPortals !== "function") throw new Error("Portal assignment API dependencies are required.");

    return async function handle(req, res, url) {
        if (!url.pathname.startsWith("/api/portal-assignments")) return false;
        const identity = await readIdentity(req);
        if (!identity) {
            json(res, 401, { ok: false, error: "Authentication required." });
            return true;
        }

        if (req.method === "GET" && url.pathname === "/api/portal-assignments") {
            if (!canRead(identity)) return json(res, 403, { ok: false, error: "Permission denied." }), true;
            const portals = await readPortals(req);
            return json(res, 200, { ok: true, assignments: store.list(), portals }), true;
        }

        const match = url.pathname.match(/^\/api\/portal-assignments\/([a-z0-9][a-z0-9-]{1,127})$/);
        if (!match) return json(res, 404, { ok: false, error: "Not found." }), true;
        const portalId = match[1];

        if (req.method === "GET") {
            if (!canRead(identity)) return json(res, 403, { ok: false, error: "Permission denied." }), true;
            const assignment = store.get(portalId);
            return json(res, assignment ? 200 : 404, assignment ? { ok: true, assignment } : { ok: false, error: "Assignment not found." }), true;
        }

        if (!canManage(identity)) return json(res, 403, { ok: false, error: "Admin or Break-Glass required." }), true;
        if (req.method === "PUT") {
            const portals = await readPortals(req);
            const assignment = store.assign(portalId, await readBody(req), identity, organizations, { list: () => portals });
            return json(res, 200, { ok: true, assignment }), true;
        }
        if (req.method === "DELETE") {
            const removed = store.remove(portalId, identity);
            return json(res, removed ? 200 : 404, removed ? { ok: true, removed } : { ok: false, error: "Assignment not found." }), true;
        }

        return json(res, 405, { ok: false, error: "Method not allowed." }), true;
    };
}

module.exports = { create };
