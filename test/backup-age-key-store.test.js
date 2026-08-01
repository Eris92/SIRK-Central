"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const storeFactory = require("../src/backup-age-key-store");

const RECIPIENT = "age1" + "q".repeat(58);

test("age recipient store persists only the public recipient", t => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sirk-age-store-"));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const store = storeFactory.create({ dataDir });

    assert.equal(store.read(), null);
    const saved = store.set(RECIPIENT, { username: "admin" });
    assert.equal(saved.recipient, RECIPIENT);
    assert.equal(saved.updatedBy, "admin");

    const content = fs.readFileSync(store.filePath, "utf8");
    assert.match(content, new RegExp(RECIPIENT));
    assert.doesNotMatch(content, /AGE-SECRET-KEY-/);
    assert.equal(fs.statSync(store.filePath).mode & 0o777, 0o600);
    assert.deepEqual(store.read(), saved);
});

test("age recipient store rejects malformed persisted state", t => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sirk-age-store-invalid-"));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const store = storeFactory.create({ dataDir });
    fs.writeFileSync(store.filePath, JSON.stringify({ version: 1, recipient: "not-an-age-recipient" }));
    assert.throws(() => store.read(), /recipient is invalid/i);
});
