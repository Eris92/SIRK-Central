"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const rateLimiter = require("../src/request-rate-limiter");

test("rate limiter rejects requests over the fixed-window limit", () => {
    let now = 1000;
    const limiter = rateLimiter.create({ limit: 2, windowMs: 10000, now: () => now });
    assert.equal(limiter.consume("portal-a").allowed, true);
    assert.equal(limiter.consume("portal-a").allowed, true);
    const rejected = limiter.consume("portal-a");
    assert.equal(rejected.allowed, false);
    assert.equal(rejected.remaining, 0);
    assert.equal(rejected.retryAfterSeconds, 10);
    assert.equal(limiter.consume("portal-b").allowed, true);
    now += 10001;
    assert.equal(limiter.consume("portal-a").allowed, true);
});

test("rate limiter bounds memory and supports reset", () => {
    let now = 1000;
    const limiter = rateLimiter.create({ limit: 10, windowMs: 1000, maxEntries: 100, now: () => now });
    for (let index = 0; index < 150; index += 1) limiter.consume("key-" + index);
    assert.ok(limiter.size() <= 100);
    assert.equal(limiter.reset("key-149"), true);
    now += 1001;
    limiter.prune();
    assert.equal(limiter.size(), 0);
});
