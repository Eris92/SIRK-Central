"use strict";

const replayStoreFactory = require("./sso-replay-store");
const { verify: verifySsoTicket } = require("./sso-ticket");

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

function create(options) {
    const app = options.app;
    const config = options.config;
    if (!app || !app.sessions) throw new Error("SSO logout dependencies are unavailable.");
    const replay = options.replay || replayStoreFactory.create({
        dataDir: config.dataDir,
        maxEntries: Number(config.env.SIRK_SSO_REPLAY_MAX_ENTRIES || 10000)
    });

    async function handler(req, res, url) {
        if (req.method !== "POST" || url.pathname !== "/auth/sso/frontchannel-logout") return false;
        if (!config.authOrigin) return false;
        const contentType = String(req.headers["content-type"] || "").split(";", 1)[0].trim().toLowerCase();
        if (contentType !== "application/json") return json(res, 415, { ok: false, error: "JSON content type is required." }), true;
        const body = await readBody(req);
        const rawTicket = String(body.ticket || "");
        const ticket = verifySsoTicket(rawTicket, config.ssoSharedSecret, {
            issuer: config.authOrigin,
            audience: config.publicOrigin,
            type: "logout"
        });
        if (!replay.consume(ticket.jti, ticket.exp * 1000)) {
            throw Object.assign(new Error("SSO logout ticket was already used."), { statusCode: 409, code: "SSO_LOGOUT_REPLAY" });
        }
        const sid = String(ticket.sid);
        const providerIssuer = String(ticket.providerIssuer);
        const count = app.sessions.revokeWhere(record => record.source === "entra"
            && record.entraSessionId === sid
            && record.entraIssuer === providerIssuer);
        if (app.securityCenter && typeof app.securityCenter.audit === "function") {
            app.securityCenter.audit("authentication.entra.frontchannel_logout", {
                username: "entra-frontchannel",
                displayName: "Entra front-channel logout",
                source: "entra",
                role: "System",
                status: "active",
                builtIn: false
            }, { providerIssuer, revokedSessions: count });
        }
        json(res, 200, { ok: true, revokedSessions: count });
        return true;
    }

    return { handler, replay };
}

module.exports = { create, readBody };
