"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { registerCanonicalLoginRoute } = require("../src/modules/canonical-login-route");

function createResponse() {
    return {
        statusCode: 0,
        headers: {},
        ended: false,
        writeHead(status, headers) {
            this.statusCode = status;
            this.headers = headers || {};
        },
        end() { this.ended = true; }
    };
}

function createApp(session) {
    let handler;
    return {
        app: {
            sessions: { get: () => session },
            router: { prepend(value) { handler = value; } }
        },
        dispatch(req, res) { return handler(req, res); }
    };
}

test("anonymous root redirects to /login", () => {
    const runtime = createApp(null);
    registerCanonicalLoginRoute(runtime.app);
    const res = createResponse();
    assert.equal(runtime.dispatch({ method: "GET", url: "/", headers: {} }, res), true);
    assert.equal(res.statusCode, 302);
    assert.equal(res.headers.Location, "/login");
});

test("anonymous /login is rewritten to the existing login application", () => {
    const runtime = createApp(null);
    registerCanonicalLoginRoute(runtime.app);
    const req = { method: "GET", url: "/login", headers: {} };
    assert.equal(runtime.dispatch(req, createResponse()), false);
    assert.equal(req.url, "/");
});

test("authenticated /login redirects to the workspace root", () => {
    const runtime = createApp({ id: "session" });
    registerCanonicalLoginRoute(runtime.app);
    const res = createResponse();
    const req = { method: "GET", url: "/login", headers: { cookie: "sirk_central_session=token" } };
    assert.equal(runtime.dispatch(req, res), true);
    assert.equal(res.statusCode, 302);
    assert.equal(res.headers.Location, "/");
});
