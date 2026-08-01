"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const testDir = path.join(root, "test");
const timeoutMs = Math.max(10000, Math.min(300000, Number(process.env.SIRK_TEST_FILE_TIMEOUT_MS || 120000)));
const files = fs.readdirSync(testDir)
    .filter(name => name.endsWith(".test.js"))
    .sort()
    .map(name => path.join("test", name));

if (!files.length) throw new Error("No Node test files were found.");

for (const file of files) {
    process.stdout.write("\n=== " + file + " ===\n");
    const result = spawnSync(process.execPath, ["--test", file], {
        cwd: root,
        env: process.env,
        stdio: "inherit",
        timeout: timeoutMs
    });
    if (result.error) {
        if (result.error.code === "ETIMEDOUT") {
            process.stderr.write(file + " exceeded " + timeoutMs + " ms.\n");
        } else {
            process.stderr.write(file + " failed to start: " + result.error.message + "\n");
        }
        process.exit(1);
    }
    if (result.status !== 0) {
        process.stderr.write(file + " failed with exit code " + String(result.status) + ".\n");
        process.exit(result.status || 1);
    }
}

process.stdout.write("\nAll " + files.length + " Node test files passed.\n");
