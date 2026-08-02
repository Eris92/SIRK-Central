"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const storeFactory = require("../src/backup-age-key-store");

const RECIPIENT = "age1" + "q".repeat(58);
const IDENTITY = "# created: test\n# public key: " + RECIPIENT + "\nAGE-SECRET-KEY-1" + "Q".repeat(58) + "\n";
const OLD_PASSWORD = "Correct-Horse-Battery-01";
const NEW_PASSWORD = "Correct-Horse-Battery-02";

test("age key store persists encrypted identity and unlocks it with BreakGlass password", t => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sirk-age-store-"));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const store = storeFactory.create({ dataDir });

    assert.equal(store.read(), null);
    const saved = store.setIdentity(IDENTITY, RECIPIENT, OLD_PASSWORD, { username: "admin" });
    assert.equal(saved.recipient, RECIPIENT);
    assert.equal(saved.updatedBy, "admin");
    assert.equal(saved.keyPersisted, true);

    const content = fs.readFileSync(store.filePath, "utf8");
    assert.match(content, new RegExp(RECIPIENT));
    assert.match(content, /aes-256-gcm/);
    assert.match(content, /scrypt/);
    assert.doesNotMatch(content, /AGE-SECRET-KEY-/);
    assert.equal(fs.statSync(store.filePath).mode & 0o777, 0o600);
    assert.equal(store.unlock(OLD_PASSWORD).identity, IDENTITY);
    assert.throws(() => store.unlock("Wrong-Password-000"), /cannot unlock/i);
});

test("BreakGlass password rewrap invalidates the old password without rotating age identity", t => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sirk-age-rewrap-"));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const store = storeFactory.create({ dataDir });
    store.setIdentity(IDENTITY, RECIPIENT, OLD_PASSWORD, { username: "admin" });

    const transaction = store.stageRewrap(OLD_PASSWORD, NEW_PASSWORD, { username: "admin" });
    assert.equal(transaction.configured, true);
    transaction.commit();

    assert.throws(() => store.unlock(OLD_PASSWORD), /cannot unlock/i);
    const unlocked = store.unlock(NEW_PASSWORD);
    assert.equal(unlocked.identity, IDENTITY);
    assert.equal(unlocked.recipient, RECIPIENT);
});

test("encrypted key export never contains plaintext identity", t => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sirk-age-export-"));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const store = storeFactory.create({ dataDir });
    store.setIdentity(IDENTITY, RECIPIENT, OLD_PASSWORD, { username: "admin" });
    const exported = store.exportEncrypted().toString("utf8");
    assert.match(exported, /sirk-central-encrypted-age-key/);
    assert.match(exported, /ciphertext/);
    assert.doesNotMatch(exported, /AGE-SECRET-KEY-/);
});

test("age key store rejects malformed persisted state", t => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sirk-age-store-invalid-"));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const store = storeFactory.create({ dataDir });
    fs.writeFileSync(store.filePath, JSON.stringify({ version: 2, recipient: "not-an-age-recipient" }));
    assert.throws(() => store.read(), /invalid/i);
});
