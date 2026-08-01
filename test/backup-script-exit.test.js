"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

test("backup cleanup trap preserves a successful exit status", () => {
    const source = fs.readFileSync(path.join(__dirname, "..", "deploy", "backup.sh"), "utf8");
    const match = source.match(/cleanup\(\)\s*\{([\s\S]*?)\n\}/);
    assert.ok(match, "cleanup function not found in deploy/backup.sh");

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sirk-backup-cleanup-"));
    const script = path.join(root, "cleanup-contract.sh");
    fs.writeFileSync(script, [
        "#!/usr/bin/env bash",
        "set -Eeuo pipefail",
        `TARGET=${JSON.stringify(path.join(root, "missing-target"))}`,
        `ARCHIVE=${JSON.stringify(path.join(root, "missing-archive.tar.gz"))}`,
        "cleanup() {",
        match[1],
        "}",
        "trap cleanup EXIT",
        "exit 0",
        ""
    ].join("\n"), { mode: 0o700 });

    const result = spawnSync("bash", [script], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout || "cleanup trap changed successful exit status");
});
