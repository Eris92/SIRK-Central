"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const FILE_NAME = "backup-age-recipient.json";
const RECIPIENT_PATTERN = /^age1[0-9a-z]{58}$/;

function validRecipient(value) {
    return RECIPIENT_PATTERN.test(String(value || ""));
}

function atomicJson(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const temporary = filePath + ".tmp-" + process.pid + "-" + crypto.randomBytes(6).toString("hex");
    let descriptor;
    try {
        descriptor = fs.openSync(temporary, "wx", 0o600);
        fs.writeFileSync(descriptor, JSON.stringify(value, null, 2) + "\n", "utf8");
        fs.fsyncSync(descriptor);
        fs.closeSync(descriptor);
        descriptor = undefined;
        fs.renameSync(temporary, filePath);
        fs.chmodSync(filePath, 0o600);
    } catch (error) {
        if (descriptor !== undefined) {
            try { fs.closeSync(descriptor); } catch (_) { /* cleanup only */ }
        }
        try { fs.rmSync(temporary, { force: true }); } catch (_) { /* cleanup only */ }
        throw error;
    }
}

function create(options = {}) {
    const dataDir = path.resolve(options.dataDir || path.join(process.cwd(), "data"));
    const filePath = path.join(dataDir, FILE_NAME);

    function read() {
        let value;
        try { value = JSON.parse(fs.readFileSync(filePath, "utf8")); }
        catch (error) {
            if (error.code === "ENOENT") return null;
            throw error;
        }
        if (!value || value.version !== 1 || !validRecipient(value.recipient)) {
            throw Object.assign(new Error("Stored age backup recipient is invalid."), { code: "BACKUP_AGE_RECIPIENT_INVALID" });
        }
        return {
            version: 1,
            recipient: value.recipient,
            updatedAtUtc: String(value.updatedAtUtc || ""),
            updatedBy: String(value.updatedBy || "")
        };
    }

    function set(recipient, actor) {
        if (!validRecipient(recipient)) throw new TypeError("Age backup recipient is invalid.");
        const record = {
            version: 1,
            recipient,
            updatedAtUtc: new Date().toISOString(),
            updatedBy: String(actor && (actor.username || actor.displayName) || "break-glass").slice(0, 200)
        };
        atomicJson(filePath, record);
        return record;
    }

    return { filePath, read, set };
}

module.exports = { create, validRecipient, FILE_NAME, RECIPIENT_PATTERN };
