"use strict";

const replayStoreFactory = require("./sso-replay-store");
const { verify: verifySsoTicket } = require("./sso-ticket");
const { permissionsFor } = require("./rbac");

function sessionCookie(token, hours) {
    return "sirk_central_session=" + token + "; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=" + (hours * 3600);
}

function redirect(res, location, headers = {}) {
    res.writeHead(302, Object.assign({
        Location: location,
        "Cache-Control": "no-store",
        "Content-Length": "0",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
        "Referrer-Policy": "no-referrer"
    }, headers));
    res.end();
}

function requestIp(req, config) {
    if (config.trustProxy) {
        const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
        if (forwarded) return forwarded.slice(0, 128);
    }
    return String(req.socket && req.socket.remoteAddress || "unknown").slice(0, 128);
}

function create(options) {
    const app = options.app;
    const config = options.config;
    if (!app || !app.sessions || !app.userStore) throw new Error("SSO callback dependencies are unavailable.");
    const replay = options.replay || replayStoreFactory.create({
        dataDir: config.dataDir,
        maxEntries: Number(config.env.SIRK_SSO_REPLAY_MAX_ENTRIES || 10000)
    });

    function handler(req, res, url) {
        if (req.method !== "GET" || url.pathname !== "/auth/sso/callback") return false;
        if (!config.authOrigin) return false;
        const rawTicket = String(url.searchParams.get("ticket") || "");
        if (!rawTicket || rawTicket.length > 32768) {
            throw Object.assign(new Error("Invalid SSO ticket."), { statusCode: 401, code: "SSO_TICKET_INVALID" });
        }
        const ticket = verifySsoTicket(rawTicket, config.ssoSharedSecret, {
            issuer: config.authOrigin,
            audience: config.publicOrigin,
            type: "login"
        });
        if (!replay.consume(ticket.jti, ticket.exp * 1000)) {
            throw Object.assign(new Error("SSO ticket was already used."), { statusCode: 401, code: "SSO_TICKET_REPLAY" });
        }
        const identityKey = (String(ticket.tid) + ":" + String(ticket.oid)).toLowerCase();
        const state = app.userStore.resolveEntra(identityKey, {
            username: ticket.username,
            displayName: ticket.name
        }, ticket.roles);
        const identity = {
            username: ticket.username || ticket.name,
            displayName: ticket.name,
            identityKey,
            tenantId: String(ticket.tid),
            objectId: String(ticket.oid),
            entraSessionId: String(ticket.sid || "").slice(0, 512),
            entraIssuer: String(ticket.providerIssuer || "").slice(0, 512),
            source: "entra",
            role: state.role,
            status: state.status,
            requestedRole: state.requestedRole,
            claimedRoles: state.claimedRoles,
            roleSource: state.roleSource,
            builtIn: false,
            permissions: permissionsFor(state.role, false)
        };
        const issued = app.sessions.issue(identity, {
            ip: requestIp(req, config),
            userAgent: String(req.headers["user-agent"] || "")
        });
        if (app.securityCenter && typeof app.securityCenter.audit === "function") {
            app.securityCenter.audit("authentication.entra.success", identity, {
                ip: requestIp(req, config),
                claimedRoles: state.claimedRoles,
                status: state.status,
                frontChannelLogoutBound: Boolean(identity.entraSessionId && identity.entraIssuer)
            });
        }
        redirect(res, "/", { "Set-Cookie": sessionCookie(issued.token, config.sessionAbsoluteHours) });
        return true;
    }

    return { handler, replay };
}

module.exports = { create, sessionCookie, requestIp };
