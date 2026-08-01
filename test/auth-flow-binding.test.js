"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const flow = require("../auth/server");

function request(cookie) {
    return { headers: { cookie: cookie || "" } };
}

test("OAuth callback state must match the HttpOnly browser flow cookie", () => {
    const state = "abcdefghijklmnopqrstuvwxyzABCDEFGH12345678";
    assert.equal(flow.flowMatches(request(flow.FLOW_COOKIE + "=" + state), state), true);
    assert.equal(flow.flowMatches(request(flow.FLOW_COOKIE + "=" + state), state + "x"), false);
    assert.equal(flow.flowMatches(request(""), state), false);
});

test("flow cookie uses host-only secure browser protections", () => {
    const cookie = flow.flowCookie("abcdefghijklmnopqrstuvwxyzABCDEFGH12345678");
    assert.match(cookie, /^__Host-sirk_auth_flow=/);
    assert.match(cookie, /Path=\//);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /Secure/);
    assert.match(cookie, /SameSite=Lax/);
    assert.doesNotMatch(cookie, /Domain=/);
});

test("flow cookie is explicitly cleared after callback", () => {
    assert.match(flow.clearFlowCookie(), /Max-Age=0/);
});
