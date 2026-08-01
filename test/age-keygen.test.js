"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { generateAgeIdentity } = require("../src/age-keygen");

const RECIPIENT = "age1" + "q".repeat(58);
const IDENTITY = "# created: 2026-08-01T00:00:00Z\n# public key: " + RECIPIENT + "\nAGE-SECRET-KEY-1QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ\n";

test("age identity generator returns the private identity once and removes temporary files", t => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sirk-age-generator-test-"));
    t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
    const calls = [];
    const fakeSpawn = (_command, args) => {
        calls.push(args.slice());
        if (args[0] === "-o") {
            fs.writeFileSync(args[1], IDENTITY, { mode: 0o600 });
            return { status: 0, stdout: "", stderr: "" };
        }
        return { status: 0, stdout: RECIPIENT + "\n", stderr: "" };
    };

    const result = generateAgeIdentity({ command: "fake-age-keygen", spawnSync: fakeSpawn, tempRoot });
    assert.equal(result.recipient, RECIPIENT);
    assert.equal(result.identity, IDENTITY);
    assert.deepEqual(calls.map(call => call[0]), ["-o", "-y"]);
    assert.deepEqual(fs.readdirSync(tempRoot), []);
});

test("age identity generator removes temporary files after a command failure", t => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sirk-age-generator-failure-"));
    t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
    const fakeSpawn = () => ({ status: 1, stdout: "", stderr: "generation failed" });

    assert.throws(
        () => generateAgeIdentity({ command: "fake-age-keygen", spawnSync: fakeSpawn, tempRoot }),
        error => error && error.code === "AGE_KEYGEN_FAILED"
    );
    assert.deepEqual(fs.readdirSync(tempRoot), []);
});
