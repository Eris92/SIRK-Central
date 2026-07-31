"use strict";

const { identityActive } = require("./rbac");

function json(res, status, body) {
    const data = Buffer.from(JSON.stringify(body));
    res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": String(data.length),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
        "Referrer-Policy": "no-referrer"
    });
    res.end(data);
}

function readBody(req, limit = 32768) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        let settled = false;
        req.on("data", chunk => {
            if (settled) return;
            size += chunk.length;
            if (size > limit) {
                settled = true;
                reject(Object.assign(new Error("Request body is too large."), { statusCode: 413 }));
                req.resume();
            } else chunks.push(chunk);
        });
        req.on("end", () => {
            if (settled) return;
            try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
            catch (_) { reject(Object.assign(new Error("Invalid JSON body."), { statusCode: 400 })); }
        });
        req.on("error", error => { if (!settled) reject(error); });
    });
}

function canRead(identity) {
    return Boolean(identityActive(identity) && (identity.builtIn === true || ["Admin", "SecAdmin", "Auditor"].includes(identity.role)));
}

function canManage(identity) {
    return Boolean(identityActive(identity) && (identity.builtIn === true || identity.role === "Admin"));
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

        try {
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
        } catch (error) {
            const status = Number.isInteger(error.statusCode) ? error.statusCode : 400;
            return json(res, status, { ok: false, error: status >= 500 ? "Portal assignment operation failed." : error.message || "Portal assignment operation failed." }), true;
        }
    };
}

module.exports = { create, canRead, canManage };
