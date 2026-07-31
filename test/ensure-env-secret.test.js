"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const helper = require("../scripts/ensure-env-secret");

function file(content) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sirk-env-secret-"));
    const target = path.join(directory, ".env");
    fs.writeFileSync(target, content, { mode: 0o600 });
    return target;
}

test("missing secret is generated once without printing its value", () => {
    const target = file("NODE_ENV=production\n");
    const first = helper.ensureSecret(target, "SIRK_AUDIT_INTEGRITY_KEY", { bytes: 48 });
    assert.deepEqual(first, { changed: true, key: "SIRK_AUDIT_INTEGRITY_KEY" });
    const content = fs.readFileSync(target, "utf8");
    const value = content.match(/^SIRK_AUDIT_INTEGRITY_KEY=([A-Za-z0-9_-]+)$/m)[1];
    assert.ok(value.length >= 64);
    const second = helper.ensureSecret(target, "SIRK_AUDIT_INTEGRITY_KEY", { bytes: 48 });
    assert.deepEqual(second, { changed: false, key: "SIRK_AUDIT_INTEGRITY_KEY" });
    assert.equal(fs.readFileSync(target, "utf8"), content);
    assert.equal(fs.statSync(target).mode & 0o777, 0o600);
});

test("empty existing value is populated while valid value is preserved", () => {
    const target = file("SIRK_AUDIT_INTEGRITY_KEY=\n");
    assert.equal(helper.ensureSecret(target, "SIRK_AUDIT_INTEGRITY_KEY").changed, true);
    const value = fs.readFileSync(target, "utf8").match(/^SIRK_AUDIT_INTEGRITY_KEY=([A-Za-z0-9_-]+)$/m)[1];
    assert.ok(value.length >= 43);
});

test("duplicates or invalid existing secrets fail closed", () => {
    assert.throws(() => helper.ensureSecret(file("SIRK_AUDIT_INTEGRITY_KEY=a\nSIRK_AUDIT_INTEGRITY_KEY=b\n"), "SIRK_AUDIT_INTEGRITY_KEY"), /more than once/i);
    assert.throws(() => helper.ensureSecret(file("SIRK_AUDIT_INTEGRITY_KEY=too-short\n"), "SIRK_AUDIT_INTEGRITY_KEY"), /invalid/i);
    assert.throws(() => helper.ensureSecret(file("NODE_ENV=production\n"), "bad-key"), /key is invalid/i);
});
