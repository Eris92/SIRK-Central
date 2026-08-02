"use strict";

const crypto = require("node:crypto");
const enrollmentStoreFactory = require("../portal-enrollment-store");
const { bootstrapBundle } = require("./portal-bootstrap");
const { json, parseCookies, csrfAccepted, readBody } = require("../http/transport");
const { hasPermission, identityActive } = require("../rbac");

function sessionActor(app, req) {
    const token = String(parseCookies(req).sirk_central_session || "");
    return token && app.sessions ? app.sessions.get(token, true) : null;
}

function canManage(actor) {
    return Boolean(identityActive(actor) && hasPermission(actor, "portals.manage"));
}

function bearer(req) {
    const match = String(req.headers.authorization || "").match(/^Bearer ([A-Za-z0-9_-]{20,256})$/);
    return match ? match[1] : "";
}

function encryptBootstrap(publicKeyPem, bundle) {
    const plaintext = Buffer.from(JSON.stringify(bundle), "utf8");
    if (plaintext.length > 1024) throw new Error("Bootstrap payload is too large.");
    const key = crypto.createPublicKey(publicKeyPem);
    const encrypted = crypto.publicEncrypt({
        key,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: "sha256"
    }, plaintext);
    return encrypted.toString("base64");
}

function audit(app, action, actor, req, details = {}) {
    if (!app.auditStore || typeof app.auditStore.append !== "function") {
        if (app.securityCenter && typeof app.securityCenter.audit === "function") {
            app.securityCenter.audit(action, actor || null, details);
        }
        return;
    }
    app.auditStore.append({
        action,
        category: "portals",
        result: "success",
        actor: actor || null,
        request: {
            method: req.method,
            path: req.url,
            ip: String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim()
        },
        details
    });
}

function registerPortalEnrollment(app, config) {
    const store = enrollmentStoreFactory.create({ dataDir: config.dataDir });
    app.portalEnrollmentStore = store;

    const handler = async (req, res) => {
        const url = new URL(req.url, "http://central.local");
        const tokenRoute = req.method === "POST" && url.pathname === "/api/portal-enrollment/tokens";
        const createRoute = req.method === "POST" && url.pathname === "/api/portal-enrollment/requests";
        const listRoute = req.method === "GET" && url.pathname === "/api/portal-enrollment/requests";
        const pollMatch = req.method === "GET" ? url.pathname.match(/^\/api\/portal-enrollment\/requests\/([A-Za-z0-9_-]{16,128})$/) : null;
        const approveMatch = req.method === "POST" ? url.pathname.match(/^\/api\/portal-enrollment\/requests\/([A-Za-z0-9_-]{16,128})\/approve$/) : null;
        const rejectMatch = req.method === "POST" ? url.pathname.match(/^\/api\/portal-enrollment\/requests\/([A-Za-z0-9_-]{16,128})\/reject$/) : null;

        if (!tokenRoute && !createRoute && !listRoute && !pollMatch && !approveMatch && !rejectMatch) return false;

        try {
            if (createRoute) {
                const input = await readBody(req, 32768);
                const result = store.createRequest(input, bearer(req));
                audit(app, "portal.enrollment.requested", null, req, { portalId: input.portalId, requestId: result.requestId });
                return json(res, 202, { ok: true, enrollment: result });
            }

            if (pollMatch) {
                const result = store.poll(pollMatch[1], bearer(req));
                return json(res, 200, { ok: true, enrollment: result });
            }

            const actor = sessionActor(app, req);
            if (!canManage(actor)) {
                return json(res, actor ? 403 : 401, { ok: false, error: actor ? "Permission denied." : "Authentication required." });
            }

            if (tokenRoute || approveMatch || rejectMatch) {
                if (!csrfAccepted(req, config)) {
                    return json(res, 403, { ok: false, error: "CSRF validation failed." });
                }
            }

            if (tokenRoute) {
                const input = await readBody(req, 16384);
                const issued = store.issueToken(input);
                audit(app, "portal.enrollment_token.issued", actor, req, { tokenId: issued.id, expiresAtUtc: issued.expiresAtUtc });
                return json(res, 201, { ok: true, enrollmentToken: issued });
            }

            if (listRoute) {
                return json(res, 200, { ok: true, requests: store.listRequests() });
            }

            if (approveMatch) {
                await readBody(req, 16384);
                const request = store.getRequest(approveMatch[1]);
                if (!request) return json(res, 404, { ok: false, error: "Enrollment request was not found." });
                if (app.portalStore.get(request.portalId)) {
                    return json(res, 409, { ok: false, code: "PORTAL_ALREADY_EXISTS", error: "Portal ID already exists." });
                }

                const portal = app.portalStore.createPortal({ id: request.portalId, name: request.portalName });
                const bundle = bootstrapBundle(config, portal);
                const encryptedBootstrap = encryptBootstrap(request.publicKeyPem, bundle);
                const approved = store.approve(request.id, encryptedBootstrap);
                audit(app, "portal.enrollment.approved", actor, req, { portalId: portal.id, requestId: request.id });
                return json(res, 200, {
                    ok: true,
                    request: {
                        id: approved.id,
                        portalId: approved.portalId,
                        portalName: approved.portalName,
                        status: approved.status,
                        approvedAtUtc: approved.approvedAtUtc
                    }
                });
            }

            await readBody(req, 16384);
            const rejected = store.reject(rejectMatch[1]);
            audit(app, "portal.enrollment.rejected", actor, req, { portalId: rejected.portalId, requestId: rejected.id });
            return json(res, 200, { ok: true, request: { id: rejected.id, portalId: rejected.portalId, status: rejected.status } });
        } catch (error) {
            const status = Number.isInteger(error.statusCode) ? error.statusCode : 400;
            return json(res, status, {
                ok: false,
                code: error.code || "PORTAL_ENROLLMENT_REJECTED",
                error: error.message || "Portal enrollment failed."
            });
        }
    };

    app.router.prepend(handler);
    return app;
}

module.exports = { registerPortalEnrollment, encryptBootstrap, canManage, bearer };
