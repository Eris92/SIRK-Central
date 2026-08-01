"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadConfig } = require("../auth/server");

function environment() {
    return {
        SIRK_AUTH_ORIGIN: "https://auth.sirkportal.com",
        SIRK_PUBLIC_ORIGIN: "https://central.sirkportal.com",
        SIRK_SSO_SHARED_SECRET: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_",
        SIRK_DATA_DIR: "/tmp/sirk-central-test"
    };
}

test("Auth Broker loads stable transport configuration independently from Entra provider settings", () => {
    const config = loadConfig(environment());
    assert.equal(config.authOrigin, "https://auth.sirkportal.com");
    assert.equal(config.centralOrigin, "https://central.sirkportal.com");
    assert.equal(config.dataDir, "/tmp/sirk-central-test");
});

test("Auth Broker requires the shared SSO secret", () => {
    const env = environment();
    delete env.SIRK_SSO_SHARED_SECRET;
    assert.throws(() => loadConfig(env), /SIRK_SSO_SHARED_SECRET/);
});

test("Auth Broker requires HTTPS origins", () => {
    const env = environment();
    env.SIRK_AUTH_ORIGIN = "http://auth.local";
    assert.throws(() => loadConfig(env), /HTTPS origin/);
});
