"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { validRecipient } = require("./backup-age-key-store");

const IDENTITY_PATTERN = /^AGE-SECRET-KEY-1[0-9A-Z]+$/m;

function commandError(message, result) {
    const detail = String(result && (result.stderr || result.error && result.error.message) || "").trim();
    return Object.assign(new Error(detail ? message + ": " + detail.slice(0, 500) : message), {
        code: "AGE_KEYGEN_FAILED",
        statusCode: 503
    });
}

function generateAgeIdentity(options = {}) {
    const command = options.command || "age-keygen";
    const run = options.spawnSync || spawnSync;
    const root = fs.mkdtempSync(path.join(options.tempRoot || os.tmpdir(), "sirk-age-key-"));
    const identityPath = path.join(root, "sirk-central-backup.agekey");
    fs.chmodSync(root, 0o700);

    try {
        const generated = run(command, ["-o", identityPath], {
            encoding: "utf8",
            timeout: 10000,
            maxBuffer: 1024 * 1024,
            stdio: ["ignore", "pipe", "pipe"]
        });
        if (!generated || generated.status !== 0) throw commandError("Unable to generate age identity", generated);

        const identity = fs.readFileSync(identityPath, "utf8");
        if (!identity || identity.length > 8192 || !IDENTITY_PATTERN.test(identity)) {
            throw Object.assign(new Error("Generated age identity has an invalid format."), {
                code: "AGE_IDENTITY_INVALID",
                statusCode: 503
            });
        }

        const derived = run(command, ["-y", identityPath], {
            encoding: "utf8",
            timeout: 10000,
            maxBuffer: 1024 * 1024,
            stdio: ["ignore", "pipe", "pipe"]
        });
        if (!derived || derived.status !== 0) throw commandError("Unable to derive age recipient", derived);
        const recipient = String(derived.stdout || "").trim();
        if (!validRecipient(recipient)) {
            throw Object.assign(new Error("Generated age recipient has an invalid format."), {
                code: "AGE_RECIPIENT_INVALID",
                statusCode: 503
            });
        }

        return {
            recipient,
            identity: identity.endsWith("\n") ? identity : identity + "\n"
        };
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

module.exports = { generateAgeIdentity, IDENTITY_PATTERN };
