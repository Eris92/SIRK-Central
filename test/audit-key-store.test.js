"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const keyStore = require("../src/audit-key-store");

function dir() { return fs.mkdtempSync(path.join(os.tmpdir(), "sirk-audit-key-")); }

test("configured environment key is used without persisting another copy", () => {
    const dataDir = dir();
    const result = keyStore.resolve({ dataDir, env: { SIRK_AUDIT_INTEGRITY_KEY: "E".repeat(64) } });
    assert.equal(result.source, "environment");
    assert.equal(result.secret, "E".repeat(64));
    assert.equal(result.filePath, null);
    assert.equal(fs.existsSync(path.join(dataDir, "audit-integrity.key")), false);
});

test("legacy deployment pins updater token to a protected file", () => {
    const dataDir = dir();
    const first = keyStore.resolve({ dataDir, env: { SIRK_UPDATER_TOKEN: "U".repeat(64) } });
    assert.equal(first.source, "pinned-updater-token");
    assert.equal(fs.statSync(first.filePath).mode & 0o777, 0o600);

    const second = keyStore.resolve({ dataDir, env: { SIRK_UPDATER_TOKEN: "N".repeat(64), SIRK_AUDIT_INTEGRITY_KEY: "A".repeat(64) } });
    assert.equal(second.source, "file");
    assert.equal(second.secret, "U".repeat(64));
});

test("deployment without configured secrets generates stable random file key", () => {
    const dataDir = dir();
    const first = keyStore.resolve({ dataDir, env: {} });
    const second = keyStore.resolve({ dataDir, env: {} });
    assert.equal(first.source, "generated-file");
    assert.equal(second.source, "file");
    assert.equal(second.secret, first.secret);
    assert.ok(first.secret.length >= 64);
});

test("invalid persisted or environment key fails closed", () => {
    const dataDir = dir();
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, "audit-integrity.key"), "short\n", { mode: 0o600 });
    assert.throws(() => keyStore.resolve({ dataDir, env: {} }), /43-512/);
    assert.throws(() => keyStore.resolve({ dataDir: dir(), env: { SIRK_AUDIT_INTEGRITY_KEY: "not valid with spaces" } }), /base64url/i);
});
