"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadConfig } = require("../auth/server");

function environment() {
    return {
        SIRK_AUTH_ORIGIN: "https://auth.sirkportal.com",
        SIRK_PUBLIC_ORIGIN: "https://central.sirkportal.com",
        SIRK_ENTRA_CLIENT_ID: "11111111-1111-1111-1111-111111111111",
        SIRK_ENTRA_CLIENT_SECRET: "secret-value",
        SIRK_SSO_SHARED_SECRET: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_",
        SIRK_ENTRA_ADMIN_IDENTITIES: "22222222-2222-2222-2222-222222222222:33333333-3333-3333-3333-333333333333"
    };
}

test("Auth Broker accepts an explicit tid:oid administrator allowlist", () => {
    const config = loadConfig(environment());
    assert.equal(config.tenant, "organizations");
    assert.equal(config.allowedIdentities.size, 1);
});

test("Auth Broker refuses to start without an administrator allowlist", () => {
    const env = environment();
    delete env.SIRK_ENTRA_ADMIN_IDENTITIES;
    assert.throws(() => loadConfig(env), /SIRK_ENTRA_ADMIN_IDENTITIES/);
});

test("Auth Broker rejects malformed administrator identities", () => {
    const env = environment();
    env.SIRK_ENTRA_ADMIN_IDENTITIES = "tenant:user";
    assert.throws(() => loadConfig(env), /tenant-id:object-id/);
});
