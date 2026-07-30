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
            try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
            catch (_) { reject(Object.assign(new Error("Invalid JSON body."), { statusCode: 400 })); }
        });
        req.on("error", reject);
    });
}

function canRead(actor) {
    return Boolean(actor && actor.ok && ["Admin", "SecAdmin", "Auditor"].includes(actor.role) || actor && actor.builtIn === true);
}

function canSubmit(actor) {
    return Boolean(actor && actor.ok && ["Admin", "SecAdmin", "OperatorL1", "SupportL2", "EngineerL3"].includes(actor.role) || actor && actor.builtIn === true);
}

function canDecide(actor) {
    return Boolean(actor && actor.ok && actor.role === "SecAdmin" && actor.builtIn !== true || actor && actor.builtIn === true);
}

function create(options) {
    const store = options.store;
    const readIdentity = options.readIdentity;
    const securityCenter = options.securityCenter;

    function audit(event, actor, details) {
        if (securityCenter && typeof securityCenter.audit === "function") securityCenter.audit(event, actor, details || {});
    }

    return async function handle(req, res, url) {
        if (!url.pathname.startsWith("/api/approvals")) return false;
        const actor = await readIdentity(req);
        if (!actor) {
            json(res, 401, { ok: false, error: "Authentication required." });
            return true;
        }

        try {
            if (req.method === "GET" && url.pathname === "/api/approvals") {
                if (!canRead(actor)) return json(res, 403, { ok: false, error: "Permission denied." }), true;
                json(res, 200, { ok: true, requests: store.list({ state: url.searchParams.get("state") || undefined, type: url.searchParams.get("type") || undefined }) });
                return true;
            }

            if (req.method === "POST" && url.pathname === "/api/approvals") {
                if (!canSubmit(actor)) return json(res, 403, { ok: false, error: "Permission denied." }), true;
                const request = store.submit(await readBody(req), actor);
                audit("approval.submitted", actor, { approvalId: request.id, type: request.type });
                json(res, 201, { ok: true, request });
                return true;
            }

            const match = url.pathname.match(/^\/api\/approvals\/(apr-[a-z0-9_-]+)\/(approve|reject|cancel)$/);
            if (match && req.method === "POST") {
                const action = match[2];
                const body = await readBody(req, 16384);
                let request;
                if (action === "cancel") {
                    request = store.cancel(match[1], actor);
                } else {
                    if (!canDecide(actor)) return json(res, 403, { ok: false, error: "Approval decision requires SecAdmin or Break-Glass." }), true;
                    request = store.decide(match[1], action, actor, body.comment);
                }
                audit("approval." + action, actor, { approvalId: request.id, type: request.type, state: request.state });
                json(res, 200, { ok: true, request });
                return true;
            }

            json(res, 404, { ok: false, error: "Not found." });
            return true;
        } catch (error) {
            json(res, error.statusCode || 400, { ok: false, error: error.message || "Approval operation failed." });
            return true;
        }
    };
}

module.exports = { create, canRead, canSubmit, canDecide };
