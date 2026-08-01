"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const script = path.resolve(__dirname, "..", "scripts", "read-env-value.py");

function run(contents, key = "SIRK_BACKUP_AGE_RECIPIENT") {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sirk-dotenv-"));
    const envFile = path.join(root, ".env");
    fs.writeFileSync(envFile, contents, "utf8");
    const result = spawnSync("python3", [script, envFile, key], { encoding: "utf8" });
    fs.rmSync(root, { recursive: true, force: true });
    return result;
}

test("dotenv reader returns unquoted and quoted values", () => {
    for (const source of [
        "SIRK_BACKUP_AGE_RECIPIENT=age1example\n",
        "SIRK_BACKUP_AGE_RECIPIENT='age1example'\n",
        'SIRK_BACKUP_AGE_RECIPIENT="age1example"\n'
    ]) {
        const result = run(source);
        assert.equal(result.status, 0);
        assert.equal(result.stdout.trim(), "age1example");
    }
});

test("dotenv reader returns an empty value when the key is absent", () => {
    const result = run("NODE_ENV=production\n");
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "\n");
});

test("dotenv reader rejects duplicate definitions", () => {
    const result = run([
        "SIRK_BACKUP_AGE_RECIPIENT=age1first",
        "SIRK_BACKUP_AGE_RECIPIENT=age1second",
        ""
    ].join("\n"));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /defined more than once/i);
});

test("dotenv reader never evaluates shell syntax", () => {
    const marker = path.join(os.tmpdir(), "sirk-dotenv-command-marker");
    fs.rmSync(marker, { force: true });
    const value = `$(touch ${marker})`;
    const result = run(`SIRK_BACKUP_AGE_RECIPIENT=${value}\n`);
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), value);
    assert.equal(fs.existsSync(marker), false);
});
