"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const archive = require("../updater/backup-archive");

function dir() { return fs.mkdtempSync(path.join(os.tmpdir(), "sirk-archive-")); }
function tar(args) {
    const result = spawnSync("tar", args, { encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr || "tar failed");
}

test("valid backup archive passes checksum and entry validation", () => {
    const root = dir();
    const source = path.join(root, "source");
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, "state.json"), "{}\n");
    const target = path.join(root, "sirk-central-20260731T120000Z.tar.gz");
    tar(["-czf", target, "-C", source, "."]);
    archive.writeChecksum(target);
    const result = archive.validateArchive(target, { requireChecksum: true });
    assert.equal(result.checksum.verified, true);
    assert.ok(result.entries >= 1);
});

test("checksum detects archive modification", () => {
    const root = dir();
    const source = path.join(root, "source");
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, "state.json"), "{}\n");
    const target = path.join(root, "sirk-central-20260731T120001Z.tar.gz");
    tar(["-czf", target, "-C", source, "."]);
    archive.writeChecksum(target);
    fs.appendFileSync(target, "tamper");
    assert.throws(() => archive.validateArchive(target, { requireChecksum: true }), /checksum/i);
});

test("archive validation rejects symbolic links", () => {
    const root = dir();
    const source = path.join(root, "source");
    fs.mkdirSync(source);
    fs.symlinkSync("/etc/passwd", path.join(source, "escape"));
    const target = path.join(root, "sirk-central-20260731T120002Z.tar.gz");
    tar(["-czf", target, "-C", source, "."]);
    archive.writeChecksum(target);
    assert.throws(() => archive.validateArchive(target, { requireChecksum: true }), /unsupported entry types/i);
});

test("entry name validation rejects traversal and Windows separators", () => {
    assert.throws(() => archive.validateEntryName("../secret"), /unsafe path/i);
    assert.throws(() => archive.validateEntryName("folder\\secret"), /unsafe path/i);
    assert.doesNotThrow(() => archive.validateEntryName("./folder/state.json"));
});
