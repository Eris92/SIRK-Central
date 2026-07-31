"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function atomicWrite(filePath, content) {
    const directory = path.dirname(filePath);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = filePath + ".tmp-" + process.pid + "-" + crypto.randomBytes(6).toString("hex");
    let descriptor;
    try {
        descriptor = fs.openSync(temporary, "wx", 0o600);
        fs.writeFileSync(descriptor, content, "utf8");
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

function ensureSecret(filePath, key, options = {}) {
    const name = String(key || "");
    if (!/^[A-Z][A-Z0-9_]{2,100}$/.test(name)) throw new Error("Environment key is invalid.");
    const bytes = Math.max(32, Math.min(128, Number(options.bytes || 48)));
    const minimum = Math.max(43, Math.min(512, Number(options.minimum || 43)));
    const content = fs.readFileSync(filePath, "utf8");
    const lines = content.split(/\r?\n/);
    const matches = [];
    const expression = new RegExp("^\\s*" + name + "\\s*=\\s*(.*?)\\s*$");
    for (let index = 0; index < lines.length; index += 1) {
        const match = lines[index].match(expression);
        if (match) matches.push({ index, value: match[1].replace(/^['\"]|['\"]$/g, "") });
    }
    if (matches.length > 1) throw new Error(name + " is defined more than once.");
    if (matches.length === 1 && matches[0].value) {
        if (matches[0].value.length < minimum || !/^[A-Za-z0-9_-]+$/.test(matches[0].value)) {
            throw new Error(name + " exists but is invalid; refusing automatic rotation.");
        }
        return { changed: false, key: name };
    }

    const value = crypto.randomBytes(bytes).toString("base64url");
    if (matches.length === 1) lines[matches[0].index] = name + "=" + value;
    else {
        while (lines.length && lines[lines.length - 1] === "") lines.pop();
        lines.push(name + "=" + value, "");
    }
    atomicWrite(filePath, lines.join("\n"));
    return { changed: true, key: name };
}

function main() {
    const [filePath, key, bytes] = process.argv.slice(2);
    if (!filePath || !key) throw new Error("Usage: node ensure-env-secret.js <env-file> <KEY> [bytes]");
    const result = ensureSecret(path.resolve(filePath), key, { bytes: bytes || 48 });
    process.stdout.write(JSON.stringify(result) + "\n");
}

if (require.main === module) {
    try { main(); }
    catch (error) {
        process.stderr.write("ERROR: " + String(error.message || error) + "\n");
        process.exit(1);
    }
}

module.exports = { ensureSecret, atomicWrite };
