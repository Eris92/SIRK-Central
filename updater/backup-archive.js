"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function backupNameAllowed(name) {
    return /^sirk-central-\d{8}T\d{6}(?:Z|[+-]\d{4})\.tar\.gz$/.test(String(name || ""));
}

function checksumPath(archivePath) {
    return archivePath + ".sha256";
}

function sha256File(filePath) {
    const hash = crypto.createHash("sha256");
    const descriptor = fs.openSync(filePath, "r");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    try {
        for (;;) {
            const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
            if (!bytesRead) break;
            hash.update(buffer.subarray(0, bytesRead));
        }
    } finally {
        fs.closeSync(descriptor);
    }
    return hash.digest("hex");
}

function atomicText(filePath, value) {
    const temporary = filePath + ".tmp-" + process.pid + "-" + crypto.randomBytes(6).toString("hex");
    const descriptor = fs.openSync(temporary, "wx", 0o600);
    try {
        fs.writeFileSync(descriptor, String(value), "utf8");
        fs.fsyncSync(descriptor);
    } finally {
        fs.closeSync(descriptor);
    }
    fs.renameSync(temporary, filePath);
}

function writeChecksum(archivePath) {
    const digest = sha256File(archivePath);
    atomicText(checksumPath(archivePath), digest + "  " + path.basename(archivePath) + "\n");
    return digest;
}

function readExpectedChecksum(archivePath) {
    try {
        const match = fs.readFileSync(checksumPath(archivePath), "utf8").trim().match(/^([a-f0-9]{64})(?:\s|$)/i);
        return match ? match[1].toLowerCase() : "";
    } catch (error) {
        if (error.code === "ENOENT") return "";
        throw error;
    }
}

function verifyChecksum(archivePath, options = {}) {
    const expected = readExpectedChecksum(archivePath);
    if (!expected) {
        if (options.requireChecksum) throw new Error("Backup checksum is missing.");
        return { present: false, verified: false, digest: "" };
    }
    const actual = sha256File(archivePath);
    const left = Buffer.from(expected, "hex");
    const right = Buffer.from(actual, "hex");
    if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) {
        throw new Error("Backup checksum verification failed.");
    }
    return { present: true, verified: true, digest: actual };
}

function runTar(args, options = {}) {
    const result = spawnSync(options.tarCommand || "tar", args, {
        encoding: "utf8",
        maxBuffer: options.maxListBytes || 16 * 1024 * 1024
    });
    if (result.status !== 0) {
        throw new Error("Backup archive is damaged or unreadable: " + String(result.stderr || result.error || result.status));
    }
    return String(result.stdout || "");
}

function validateEntryName(name) {
    const raw = String(name || "");
    if (!raw || raw.includes("\0") || raw.includes("\\")) throw new Error("Backup archive contains an unsafe path.");
    const withoutPrefix = raw.replace(/^\.\//, "");
    const normalized = path.posix.normalize(withoutPrefix);
    if (path.posix.isAbsolute(raw) || normalized === ".." || normalized.startsWith("../")) {
        throw new Error("Backup archive contains an unsafe path.");
    }
}

function validateArchive(archivePath, options = {}) {
    const stat = fs.statSync(archivePath);
    if (!stat.isFile() || stat.size < 1) throw new Error("Backup archive is empty or invalid.");
    const maxArchiveBytes = Math.max(1024 * 1024, Number(options.maxArchiveBytes || 50 * 1024 * 1024 * 1024));
    if (stat.size > maxArchiveBytes) throw new Error("Backup archive exceeds the configured size limit.");

    const checksum = verifyChecksum(archivePath, { requireChecksum: options.requireChecksum === true });
    const names = runTar(["-tzf", archivePath], options).split(/\r?\n/).filter(Boolean);
    const maxEntries = Math.max(100, Math.min(1000000, Number(options.maxEntries || 100000)));
    if (names.length > maxEntries) throw new Error("Backup archive contains too many entries.");
    for (const name of names) validateEntryName(name);

    const verbose = runTar(["-tvzf", archivePath], options).split(/\r?\n/).filter(Boolean);
    for (const line of verbose) {
        const type = line[0];
        if (type !== "-" && type !== "d") {
            throw new Error("Backup archive contains links, devices or other unsupported entry types.");
        }
    }
    return { size: stat.size, entries: names.length, checksum };
}

module.exports = {
    backupNameAllowed,
    checksumPath,
    sha256File,
    writeChecksum,
    readExpectedChecksum,
    verifyChecksum,
    validateArchive,
    validateEntryName
};
