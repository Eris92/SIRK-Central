"use strict";

const crypto = require("node:crypto");
const http = require("node:http");

const FLOW_COOKIE = "__Host-sirk_auth_flow";

function parseCookies(req) {
    const result = {};
    for (const part of String(req.headers.cookie || "").split(";")) {
        const index = part.indexOf("=");
        if (index > 0) result[part.slice(0, index).trim()] = part.slice(index + 1).trim();
    }
    return result;
}

function flowCookie(state) {
    return FLOW_COOKIE + "=" + state + "; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600";
}

function clearFlowCookie() {
    return FLOW_COOKIE + "=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0";
}

function safeEqual(left, right) {
    const a = Buffer.from(String(left || ""));
    const b = Buffer.from(String(right || ""));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function validState(value) {
    return /^[A-Za-z0-9_-]{32,128}$/.test(String(value || ""));
}

function flowMatches(req, state) {
    const cookie = parseCookies(req)[FLOW_COOKIE] || "";
    return validState(state) && validState(cookie) && safeEqual(cookie, state);
}

function appendSetCookie(existing, value) {
    if (!existing) return value;
    if (Array.isArray(existing)) return existing.concat(value);
    return [existing, value];
}

function patchResponse(res, mode) {
    const originalWriteHead = res.writeHead.bind(res);
    res.writeHead = function patchedWriteHead(statusCode, reasonOrHeaders, maybeHeaders) {
        let headers;
        if (reasonOrHeaders && typeof reasonOrHeaders === "object") headers = Object.assign({}, reasonOrHeaders);
        else if (maybeHeaders && typeof maybeHeaders === "object") headers = Object.assign({}, maybeHeaders);
        else headers = {};

        if (mode === "login") {
            const location = String(headers.Location || headers.location || res.getHeader("Location") || "");
            try {
                const state = new URL(location).searchParams.get("state") || "";
                if (validState(state)) {
                    const existing = headers["Set-Cookie"] || headers["set-cookie"] || res.getHeader("Set-Cookie");
                    delete headers["set-cookie"];
                    headers["Set-Cookie"] = appendSetCookie(existing, flowCookie(state));
                }
            } catch (_) { /* inner server will return its own error */ }
        } else if (mode === "callback") {
            const existing = headers["Set-Cookie"] || headers["set-cookie"] || res.getHeader("Set-Cookie");
            delete headers["set-cookie"];
            headers["Set-Cookie"] = appendSetCookie(existing, clearFlowCookie());
        }

        if (reasonOrHeaders && typeof reasonOrHeaders === "string") return originalWriteHead(statusCode, reasonOrHeaders, headers);
        return originalWriteHead(statusCode, headers);
    };
}

function rejectFlow(res) {
    const data = Buffer.from("authentication request failed\n", "utf8");
    res.writeHead(400, {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Length": String(data.length),
        "Cache-Control": "no-store",
        Pragma: "no-cache",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
        "Referrer-Policy": "no-referrer",
        "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
        "Set-Cookie": clearFlowCookie()
    });
    res.end(data);
}

function createHardenedAuthServer(config, createInner) {
    const factory = createInner || require("./server").createApp;
    const inner = factory(config);
    const innerHandler = inner.listeners("request")[0];
    if (typeof innerHandler !== "function") throw new Error("SIRK Auth request handler is unavailable.");

    const server = http.createServer((req, res) => {
        const url = new URL(req.url, "http://auth.local");
        if (req.method === "GET" && url.pathname === "/login") {
            patchResponse(res, "login");
            return innerHandler(req, res);
        }
        if (req.method === "GET" && url.pathname === "/auth/entra/callback") {
            const state = String(url.searchParams.get("state") || "");
            if (!flowMatches(req, state)) return rejectFlow(res);
            patchResponse(res, "callback");
            return innerHandler(req, res);
        }
        return innerHandler(req, res);
    });
    server.requestTimeout = inner.requestTimeout;
    server.headersTimeout = inner.headersTimeout;
    server.keepAliveTimeout = inner.keepAliveTimeout;
    return server;
}

if (require.main === module) {
    const { loadConfig } = require("./server");
    const config = loadConfig(process.env);
    createHardenedAuthServer(config).listen(config.port, config.bindHost, () => {
        process.stdout.write("SIRK Auth Broker hardened runtime listening on " + config.bindHost + ":" + config.port + "\n");
    });
}

module.exports = {
    FLOW_COOKIE,
    parseCookies,
    flowCookie,
    clearFlowCookie,
    flowMatches,
    createHardenedAuthServer
};
