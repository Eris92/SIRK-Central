"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const upgradeGuardFactory = require("../src/portal-upgrade-guard");

function socket() {
    return {
        output: "",
        destroyed: false,
        write(value) { this.output += String(value); },
        destroy() { this.destroyed = true; }
    };
}

function request(overrides = {}) {
    return Object.assign({
        method: "GET",
        url: "/tunnel",
        headers: {
            upgrade: "websocket",
            connection: "Upgrade",
            "sec-websocket-version": "13",
            authorization: "credential"
        },
        socket: { remoteAddress: "127.0.0.1" }
    }, overrides);
}

function guard(env = {}) {
    return upgradeGuardFactory.create({
        app: {
            portalRegistry: {
                authenticate(id, token) {
                    return id === "portal-one" && token === "secret-token-value" ? { id } : null;
                }
            }
        },
        config: {
            publicOrigin: "https://central.example.test",
            trustProxy: false,
            env: Object.assign({
                SIRK_PORTAL_TUNNEL_AUTH_RATE_LIMIT: "5",
                SIRK_PORTAL_TUNNEL_RATE_LIMIT: "2"
            }, env)
        },
        portalCredential(req) {
            return req.headers.authorization === "credential" ? { id: "portal-one", token: "secret-token-value" } : null;
        },
        requestIp() { return "127.0.0.1"; }
    });
}

test("valid authenticated WebSocket upgrade is forwarded", () => {
    const item = guard();
    const target = socket();
    let forwarded = false;
    assert.equal(item.handle(request(), target, Buffer.alloc(0), () => { forwarded = true; }), true);
    assert.equal(forwarded, true);
    assert.equal(target.destroyed, false);
});

test("query strings invalid origins and malformed upgrades are rejected", () => {
    for (const req of [
        request({ url: "/tunnel?token=forbidden" }),
        request({ headers: Object.assign({}, request().headers, { origin: "https://evil.example" }) }),
        request({ headers: Object.assign({}, request().headers, { upgrade: "h2c" }) }),
        request({ method: "POST" })
    ]) {
        const target = socket();
        assert.equal(guard().handle(req, target, Buffer.alloc(0), () => {}), false);
        assert.equal(target.destroyed, true);
        assert.match(target.output, /^HTTP\/1\.1 (400|403|404)/);
    }
});

test("invalid credentials and oversized upgrade payload are rejected", () => {
    const invalid = socket();
    assert.equal(guard().handle(request({ headers: Object.assign({}, request().headers, { authorization: "wrong" }) }), invalid, Buffer.alloc(0), () => {}), false);
    assert.match(invalid.output, /^HTTP\/1\.1 401/);

    const oversized = socket();
    assert.equal(guard().handle(request(), oversized, Buffer.alloc(4097), () => {}), false);
    assert.match(oversized.output, /^HTTP\/1\.1 413/);
});

test("per-Portal connection attempts are bounded", () => {
    const item = guard({ SIRK_PORTAL_TUNNEL_RATE_LIMIT: "2" });
    for (let index = 0; index < 2; index += 1) {
        assert.equal(item.handle(request(), socket(), Buffer.alloc(0), () => {}), true);
    }
    const limited = socket();
    assert.equal(item.handle(request(), limited, Buffer.alloc(0), () => {}), false);
    assert.match(limited.output, /^HTTP\/1\.1 429/);
    assert.match(limited.output, /Retry-After:/);
});
