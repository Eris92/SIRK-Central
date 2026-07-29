"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { hashSecret, verifySecret, hashAccessKey, verifyAccessKey } = require("../src/security");

test("scrypt hashes verify without storing the secret", () => {
    const hash = hashSecret("a-strong-test-secret");
    assert.equal(verifySecret("a-strong-test-secret", hash), true);
    assert.equal(verifySecret("wrong-test-secret", hash), false);
    assert.equal(hash.includes("a-strong-test-secret"), false);
});

test("URL access keys use constant-length SHA-256 verification", () => {
    const key = "0123456789abcdefghijklmnopqrstuvwxyz-ACCESS";
    const hash = hashAccessKey(key);
    assert.equal(verifyAccessKey(key, hash), true);
    assert.equal(verifyAccessKey(key + "x", hash), false);
    assert.equal(hash.includes(key), false);
});
