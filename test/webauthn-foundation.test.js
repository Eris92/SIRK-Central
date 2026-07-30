"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const challengeStoreFactory = require("../src/webauthn-challenge-store");
const recoveryStoreFactory = require("../src/recovery-code-store");

const actor = { identityKey: "breakglass:admin", username: "admin" };

test("WebAuthn challenges are persistent, single-use and owner-bound", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sirk-webauthn-challenge-"));
    let now = Date.parse("2026-07-30T17:30:00Z");
    const first = challengeStoreFactory.create({ dataDir: dir, now: () => now, ttlMs: 60_000 });
    const issued = first.issue("registration", actor, { displayName: "YubiKey 5" });

    const storedText = fs.readFileSync(first.filePath, "utf8");
    assert.equal(storedText.includes(issued.challenge), false);

    const reopened = challengeStoreFactory.create({ dataDir: dir, now: () => now, ttlMs: 60_000 });
    assert.deepEqual(reopened.consume(issued.id, issued.challenge, "registration", actor), { displayName: "YubiKey 5" });
    assert.throws(() => reopened.consume(issued.id, issued.challenge, "registration", actor), /not found or expired/);

    const other = first.issue("authentication", actor, {});
    assert.throws(() => first.consume(other.id, other.challenge, "authentication", { identityKey: "breakglass:other" }), /owner mismatch/);
});

test("WebAuthn challenges expire and reject repeated invalid attempts", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sirk-webauthn-expiry-"));
    let now = Date.parse("2026-07-30T17:30:00Z");
    const store = challengeStoreFactory.create({ dataDir: dir, now: () => now, ttlMs: 30_000 });
    const expired = store.issue("authentication", actor, {});
    now += 31_000;
    assert.throws(() => store.consume(expired.id, expired.challenge, "authentication", actor), /not found or expired/);

    const limited = store.issue("authentication", actor, {});
    for (let index = 0; index < 5; index += 1) {
        assert.throws(() => store.consume(limited.id, "wrong-" + index, "authentication", actor), /verification failed/);
    }
    assert.throws(() => store.consume(limited.id, "wrong-final", "authentication", actor), /attempt limit exceeded/);
    assert.throws(() => store.consume(limited.id, limited.challenge, "authentication", actor), /not found or expired/);
});

test("Recovery codes are hashed, persistent and single-use", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sirk-recovery-"));
    const store = recoveryStoreFactory.create({ dataDir: dir });
    const codes = store.generate(actor, 8);
    assert.equal(codes.length, 8);
    assert.equal(store.status(actor).remaining, 8);

    const rawFile = fs.readFileSync(store.filePath, "utf8");
    for (const code of codes) assert.equal(rawFile.includes(code), false);

    const reopened = recoveryStoreFactory.create({ dataDir: dir });
    assert.equal(reopened.verify(actor, codes[0]).remaining, 7);
    assert.throws(() => reopened.verify(actor, codes[0]), /invalid/);
    assert.equal(reopened.status(actor).remaining, 7);
});

test("Recovery codes temporarily block repeated invalid verification", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sirk-recovery-lockout-"));
    let now = Date.parse("2026-07-30T17:30:00Z");
    const store = recoveryStoreFactory.create({ dataDir: dir, now: () => now });
    const codes = store.generate(actor, 5);
    for (let index = 0; index < 5; index += 1) assert.throws(() => store.verify(actor, "BAD-CODE-000" + index), /invalid/);
    assert.throws(() => store.verify(actor, codes[0]), /temporarily blocked/);
    now += 16 * 60_000;
    assert.equal(store.verify(actor, codes[0]).remaining, 4);
});
