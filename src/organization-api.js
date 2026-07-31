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

function readBody(req, limit = 65536) {
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

function audit(securityCenter, event, actor, details) {
    if (securityCenter && typeof securityCenter.audit === "function") securityCenter.audit(event, actor, details || {});
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
                return json(res, 200, { ok: true, organizations: store.list() }), true;
            }
            if (req.method === "GET" && url.pathname === "/api/organizations/tree") {
                if (!canRead(actor)) return json(res, 403, { ok: false, error: "Permission denied." }), true;
                return json(res, 200, { ok: true, tree: store.tree() }), true;
            }
            if (!canManage(actor)) {
                json(res, 403, { ok: false, error: "Organization management requires Admin or Break-Glass." });
                return true;
            }
            if (req.method === "POST" && url.pathname === "/api/organizations/tenants") {
                const tenant = store.createTenant(await readBody(req), actor);
                audit(securityCenter, "organization.tenant.created", actor, { tenantId: tenant.id });
                return json(res, 201, { ok: true, tenant }), true;
            }
            if (req.method === "POST" && url.pathname === "/api/organizations/customers") {
                const customer = store.createCustomer(await readBody(req), actor);
                audit(securityCenter, "organization.customer.created", actor, { tenantId: customer.tenantId, customerId: customer.id });
                return json(res, 201, { ok: true, customer }), true;
            }
            if (req.method === "POST" && url.pathname === "/api/organizations/sites") {
                const site = store.createSite(await readBody(req), actor);
                audit(securityCenter, "organization.site.created", actor, { tenantId: site.tenantId, customerId: site.customerId, siteId: site.id });
                return json(res, 201, { ok: true, site }), true;
            }
            const match = url.pathname.match(/^\/api\/organizations\/(tenant|customer|site)\/([a-z0-9_-]+)$/);
            if (match && req.method === "PATCH") {
                const body = await readBody(req, 16384);
                const object = store.setStatus(match[1], match[2], body.status, actor);
                audit(securityCenter, "organization." + match[1] + ".status_changed", actor, { id: match[2], status: object.status });
                return json(res, 200, { ok: true, object }), true;
            }
            if (match && req.method === "DELETE") {
                const object = store.remove(match[1], match[2], actor);
                audit(securityCenter, "organization." + match[1] + ".deleted", actor, { id: match[2] });
                return json(res, 200, { ok: true, object }), true;
            }
            return json(res, 404, { ok: false, error: "Not found." }), true;
        } catch (error) {
            const status = Number.isInteger(error.statusCode) ? error.statusCode : 400;
            return json(res, status, { ok: false, error: status >= 500 ? "Organization operation failed." : error.message || "Organization operation failed." }), true;
        }
    };
}

module.exports = { create, canRead, canManage };
