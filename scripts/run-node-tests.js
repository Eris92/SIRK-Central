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
    const result = spawnSync(process.execPath, ["--test", file], {
        cwd: root,
        env: process.env,
        encoding: "utf8",
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024
    });

    if (result.error) {
        process.stderr.write("\nFAIL " + file + "\n");
        if (result.error.code === "ETIMEDOUT") {
            process.stderr.write(file + " exceeded " + timeoutMs + " ms.\n");
        } else {
            process.stderr.write(file + " failed to start: " + result.error.message + "\n");
        }
        if (result.stdout) process.stderr.write(result.stdout);
        if (result.stderr) process.stderr.write(result.stderr);
        process.exit(1);
    }

    if (result.status !== 0) {
        process.stderr.write("\nFAIL " + file + " (exit " + String(result.status) + ")\n");
        if (result.stdout) process.stderr.write(result.stdout);
        if (result.stderr) process.stderr.write(result.stderr);
        process.exit(result.status || 1);
    }

    process.stdout.write("PASS " + file + "\n");
}

process.stdout.write("All " + files.length + " Node test files passed.\n");
