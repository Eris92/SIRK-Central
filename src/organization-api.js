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

function readBody(req, limit = 65536) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on("data", chunk => {
            size += chunk.length;
            if (size > limit) {
                reject(Object.assign(new Error("Request body is too large."), { statusCode: 413 }));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on("end", () => {
            try {
                resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
            } catch (_) {
                reject(Object.assign(new Error("Invalid JSON body."), { statusCode: 400 }));
            }
        });
        req.on("error", reject);
    });
}

function canRead(identity) {
    return Boolean(identity && identity.ok && ["Admin", "SecAdmin", "Auditor"].includes(identity.role) || identity && identity.builtIn === true);
}

function canManage(identity) {
    return Boolean(identity && identity.ok && identity.role === "Admin" && identity.builtIn !== true || identity && identity.builtIn === true);
}

function audit(securityCenter, event, actor, details) {
    if (securityCenter && typeof securityCenter.audit === "function") {
        securityCenter.audit(event, actor, details || {});
    }
}

function create(options) {
    const store = options.store;
    const readIdentity = options.readIdentity;
    const securityCenter = options.securityCenter;

    if (!store || typeof readIdentity !== "function") throw new Error("Organization API dependencies are missing.");

    return async function handle(req, res, url) {
        if (!url.pathname.startsWith("/api/organizations")) return false;

        const actor = await readIdentity(req);
        if (!actor) {
            json(res, 401, { ok: false, error: "Authentication required." });
            return true;
        }

        try {
            if (req.method === "GET" && url.pathname === "/api/organizations") {
                if (!canRead(actor)) return json(res, 403, { ok: false, error: "Permission denied." }), true;
                json(res, 200, { ok: true, organizations: store.list() });
                return true;
            }

            if (req.method === "GET" && url.pathname === "/api/organizations/tree") {
                if (!canRead(actor)) return json(res, 403, { ok: false, error: "Permission denied." }), true;
                json(res, 200, { ok: true, tree: store.tree() });
                return true;
            }

            if (!canManage(actor)) {
                json(res, 403, { ok: false, error: "Organization management requires Admin or Break-Glass." });
                return true;
            }

            if (req.method === "POST" && url.pathname === "/api/organizations/tenants") {
                const tenant = store.createTenant(await readBody(req), actor);
                audit(securityCenter, "organization.tenant.created", actor, { tenantId: tenant.id });
                json(res, 201, { ok: true, tenant });
                return true;
            }

            if (req.method === "POST" && url.pathname === "/api/organizations/customers") {
                const customer = store.createCustomer(await readBody(req), actor);
                audit(securityCenter, "organization.customer.created", actor, { tenantId: customer.tenantId, customerId: customer.id });
                json(res, 201, { ok: true, customer });
                return true;
            }

            if (req.method === "POST" && url.pathname === "/api/organizations/sites") {
                const site = store.createSite(await readBody(req), actor);
                audit(securityCenter, "organization.site.created", actor, { tenantId: site.tenantId, customerId: site.customerId, siteId: site.id });
                json(res, 201, { ok: true, site });
                return true;
            }

            const match = url.pathname.match(/^\/api\/organizations\/(tenant|customer|site)\/([a-z0-9_-]+)$/);
            if (match && req.method === "PATCH") {
                const body = await readBody(req, 16384);
                const object = store.setStatus(match[1], match[2], body.status, actor);
                audit(securityCenter, "organization." + match[1] + ".status_changed", actor, { id: match[2], status: object.status });
                json(res, 200, { ok: true, object });
                return true;
            }

            if (match && req.method === "DELETE") {
                const object = store.remove(match[1], match[2], actor);
                audit(securityCenter, "organization." + match[1] + ".deleted", actor, { id: match[2] });
                json(res, 200, { ok: true, object });
                return true;
            }

            json(res, 404, { ok: false, error: "Not found." });
            return true;
        } catch (error) {
            json(res, error.statusCode || 400, { ok: false, error: error.message || "Organization operation failed." });
            return true;
        }
    };
}

module.exports = { create, canRead, canManage };
