"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const catalog = require("../src/modules/portal-release-catalog");

const valid = {
    schemaVersion: 1,
    applicationId: "sirk-portal",
    version: "2.0.0-dev.32",
    channel: "dev",
    packageUrl: "https://github.com/Eris92/SIRK-Portal/releases/download/v2.0.0-dev.32/SIRK-Portal-2.0.0-dev.32-win-x64.zip",
    sha256: "A".repeat(64),
    architecture: "win-x64",
    commit: "0123456789abcdef"
};

test("Portal release metadata is normalized", () => {
    const value = catalog.validateMetadata(valid);
    assert.equal(value.applicationId, "sirk-portal");
    assert.equal(value.version, "2.0.0-dev.32");
    assert.equal(value.channel, "dev");
    assert.equal(value.sha256, "A".repeat(64));
    assert.equal(value.architecture, "win-x64");
});

test("Portal release metadata rejects untrusted package hosts and invalid hashes", () => {
    assert.throws(() => catalog.validateMetadata(Object.assign({}, valid, { packageUrl: "https://evil.example/SIRK-Portal-2.0.0-dev.32-win-x64.zip" })), /not trusted/);
    assert.throws(() => catalog.validateMetadata(Object.assign({}, valid, { sha256: "1234" })), /SHA-256/);
    assert.throws(() => catalog.validateMetadata(Object.assign({}, valid, { applicationId: "other" })), /schema/);
});

test("Portal release redirect allowlist is fixed to GitHub hosts", () => {
    assert.equal(catalog.TRUSTED_HOSTS.has("api.github.com"), true);
    assert.equal(catalog.TRUSTED_HOSTS.has("github.com"), true);
    assert.equal(catalog.TRUSTED_HOSTS.has("release-assets.githubusercontent.com"), true);
    assert.equal(catalog.TRUSTED_HOSTS.has("evil.example"), false);
});
