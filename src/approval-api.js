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

function canRead(actor) {
    return Boolean(identityActive(actor) && (actor.builtIn === true || ["Admin", "SecAdmin", "Auditor"].includes(actor.role)));
}

function canSubmit(actor) {
    return Boolean(identityActive(actor) && (actor.builtIn === true || ["Admin", "SecAdmin", "OperatorL1", "SupportL2", "EngineerL3"].includes(actor.role)));
}

function canDecide(actor) {
    return Boolean(identityActive(actor) && (actor.builtIn === true || actor.role === "SecAdmin"));
}

function create(options) {
    const store = options.store;
    const readIdentity = options.readIdentity;

    return async function handle(req, res, url) {
        if (!url.pathname.startsWith("/api/approvals")) return false;
        const actor = await readIdentity(req);
        if (!actor) {
            json(res, 401, { ok: false, error: "Authentication required." });
            return true;
        }

        if (req.method === "GET" && url.pathname === "/api/approvals") {
            if (!canRead(actor)) {
                json(res, 403, { ok: false, error: "Permission denied." });
                return true;
            }
            json(res, 200, {
                ok: true,
                deprecated: true,
                replacement: "/api/approval-center",
                requests: store.list({
                    state: url.searchParams.get("state") || undefined,
                    type: url.searchParams.get("type") || undefined
                })
            });
            return true;
        }

        json(res, 410, {
            ok: false,
            code: "APPROVAL_API_RETIRED",
            error: "This approval endpoint is retired. Use /api/approval-center."
        });
        return true;
    };
}

module.exports = { create, canRead, canSubmit, canDecide };
