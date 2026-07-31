"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function validSecret(value) {
    const secret = String(value || "").trim();
    if (secret.length < 43 || secret.length > 512 || !/^[A-Za-z0-9_-]+$/.test(secret)) {
        throw new Error("Audit integrity secret must contain 43-512 base64url characters.");
    }
    return secret;
}

function atomicWrite(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const temporary = filePath + ".tmp-" + process.pid + "-" + crypto.randomBytes(6).toString("hex");
    let descriptor;
    try {
        descriptor = fs.openSync(temporary, "wx", 0o600);
        fs.writeFileSync(descriptor, value + "\n", "utf8");
        fs.fsyncSync(descriptor);
        fs.closeSync(descriptor);
        descriptor = undefined;
        fs.renameSync(temporary, filePath);
        fs.chmodSync(filePath, 0o600);
    } catch (error) {
        if (descriptor !== undefined) {
            try { fs.closeSync(descriptor); } catch (_) { /* ignore cleanup failure */ }
        }
        try { fs.rmSync(temporary, { force: true }); } catch (_) { /* ignore cleanup failure */ }
        throw error;
    }
}

function resolve(options = {}) {
    const dataDir = path.resolve(options.dataDir || path.join(process.cwd(), "data"));
    const env = options.env || process.env;
    const filePath = path.join(dataDir, "audit-integrity.key");

    if (fs.existsSync(filePath)) {
        const value = validSecret(fs.readFileSync(filePath, "utf8"));
        const mode = fs.statSync(filePath).mode & 0o777;
        if (mode !== 0o600) fs.chmodSync(filePath, 0o600);
        return { secret: value, source: "file", filePath };
    }

    const configured = String(env.SIRK_AUDIT_INTEGRITY_KEY || "").trim();
    if (configured) return { secret: validSecret(configured), source: "environment", filePath: null };

    const updaterToken = String(env.SIRK_UPDATER_TOKEN || "").trim();
    const generated = updaterToken ? validSecret(updaterToken) : crypto.randomBytes(48).toString("base64url");
    atomicWrite(filePath, generated);
    return { secret: generated, source: updaterToken ? "pinned-updater-token" : "generated-file", filePath };
}

module.exports = { resolve, validSecret, atomicWrite };
