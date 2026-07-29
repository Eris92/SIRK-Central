"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { sign, verify } = require("../src/sso-ticket");

const secret = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_";

function payload() {
    const now = Math.floor(Date.now() / 1000);
    return {
        v: 1,
        iss: "https://auth.sirkportal.com",
        aud: "https://central.sirkportal.com",
        iat: now,
        exp: now + 60,
        jti: "ticket-1234567890abcdef",
        tid: "11111111-1111-1111-1111-111111111111",
        oid: "22222222-2222-2222-2222-222222222222",
        name: "Test User",
        username: "test@example.com"
    };
}

test("signed SSO ticket validates expected issuer and audience", () => {
    const token = sign(payload(), secret);
    const result = verify(token, secret, {
        issuer: "https://auth.sirkportal.com",
        audience: "https://central.sirkportal.com"
    });
    assert.equal(result.oid, "22222222-2222-2222-2222-222222222222");
});

test("tampered SSO ticket is rejected", () => {
    const token = sign(payload(), secret);
    assert.throws(() => verify(token.slice(0, -1) + "x", secret, {
        issuer: "https://auth.sirkportal.com",
        audience: "https://central.sirkportal.com"
    }), /signature/);
});

test("wrong SSO audience is rejected", () => {
    const token = sign(payload(), secret);
    assert.throws(() => verify(token, secret, {
        issuer: "https://auth.sirkportal.com",
        audience: "https://other.example.com"
    }), /audience/);
});
