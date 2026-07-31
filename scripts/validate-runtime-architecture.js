"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const srcDir = path.join(root, "src");
const targetEntry = path.join(srcDir, "server.js");
const transitionalEntry = path.join(srcDir, "server-v15.js");
const selfPath = path.resolve(__filename);

// Ratchet: this number may only go down. Each migration step must remove at
// least one server-vN layer before lowering the budget in the same commit.
const VERSIONED_LAYER_BUDGET = 15;

const forbiddenPaths = [
    "src/entry.js",
    "src/preload-api.js",
    "src/preload-hardening.js",
    "src/server-hardened.js",
    "src/server-production.js",
    "src/persistent-session-map.js",
    "test/persistent-session-map.test.js",
    "deploy/reset-admin-password.sh",
    "scripts/hash-password.js",
    "scripts/generate-access-key.js"
];
const forbiddenPackageScripts = ["start:legacy", "hash-password", "generate-access-key"];

function fail(message) {
    process.stderr.write("Runtime architecture validation failed: " + message + "\n");
    process.exitCode = 1;
}

function resolveLocalRequire(fromFile, request) {
    if (!request.startsWith(".")) return null;
    const base = path.resolve(path.dirname(fromFile), request);
    const candidates = [base, base + ".js", path.join(base, "index.js")];
    return candidates.find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile()) || null;
}

function collectRuntimeGraph(entryFile) {
    const visited = new Set();
    const pending = [entryFile];
    const requirePattern = /require\(\s*["']([^"']+)["']\s*\)/g;

    while (pending.length) {
        const file = path.resolve(pending.pop());
        if (visited.has(file)) continue;
        visited.add(file);
        const source = fs.readFileSync(file, "utf8");
        requirePattern.lastIndex = 0;
        let match;
        while ((match = requirePattern.exec(source)) !== null) {
            const dependency = resolveLocalRequire(file, match[1]);
            if (dependency && !visited.has(dependency)) pending.push(dependency);
        }
    }
    return visited;
}

function walk(directory, output = []) {
    if (!fs.existsSync(directory)) return output;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) walk(target, output);
        else if (entry.isFile()) output.push(target);
    }
    return output;
}

for (const relativePath of forbiddenPaths) {
    if (fs.existsSync(path.join(root, relativePath))) fail("forbidden obsolete file still exists: " + relativePath);
}

const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
for (const scriptName of forbiddenPackageScripts) {
    if (packageJson.scripts && packageJson.scripts[scriptName]) fail("package.json exposes obsolete script: " + scriptName);
}

const versionedLayers = fs.readdirSync(srcDir)
    .filter(name => /^server-v\d+\.js$/.test(name))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));

if (versionedLayers.length > VERSIONED_LAYER_BUDGET) {
    fail("versioned runtime layer count increased to " + versionedLayers.length + "; migration budget is " + VERSIONED_LAYER_BUDGET + ".");
}

let canonicalEntry;
if (versionedLayers.length === 0) {
    canonicalEntry = targetEntry;
    if (!fs.existsSync(targetEntry)) fail("migration is complete but target runtime src/server.js is missing.");
    if (packageJson.main !== "src/server.js") fail("package.json main must be src/server.js after flattening.");
    if (!String(packageJson.scripts && packageJson.scripts.start || "").includes("src/server.js")) fail("start script must use src/server.js after flattening.");
} else {
    canonicalEntry = transitionalEntry;
    if (!fs.existsSync(transitionalEntry)) fail("transitional runtime src/server-v15.js is missing before flattening is complete.");
    if (packageJson.main !== "src/server-v15.js") fail("package.json main must remain on the current transitional entry until src/server.js is complete.");
    if (!String(packageJson.scripts && packageJson.scripts.start || "").includes("src/server-v15.js")) fail("start script must remain on the current transitional entry until src/server.js is complete.");
}

const runtimeGraph = fs.existsSync(canonicalEntry) ? collectRuntimeGraph(canonicalEntry) : new Set();
for (const fileName of versionedLayers) {
    const absolute = path.join(srcDir, fileName);
    if (!runtimeGraph.has(absolute)) fail("unreachable versioned runtime debt must be deleted: src/" + fileName);
}

for (const fileName of fs.readdirSync(srcDir)) {
    if (!/^server(?:-.*)?\.js$/.test(fileName)) continue;
    const absolute = path.join(srcDir, fileName);
    if (!runtimeGraph.has(absolute) && absolute !== targetEntry) {
        fail("unreachable alternate server implementation: src/" + fileName);
    }
}

const scanRoots = ["src", "auth", "updater", "deploy", "scripts", "test"];
for (const relativeRoot of scanRoots) {
    for (const file of walk(path.join(root, relativeRoot))) {
        if (path.resolve(file) === selfPath) continue;
        if (!/\.(?:js|json|sh|ya?ml)$/.test(file)) continue;
        const source = fs.readFileSync(file, "utf8");
        for (const forbiddenPath of forbiddenPaths) {
            if (source.includes(forbiddenPath)) fail(path.relative(root, file) + " still references " + forbiddenPath);
        }
    }
}

if (!process.exitCode) {
    if (versionedLayers.length === 0) {
        process.stdout.write("Runtime architecture validation passed: one flat canonical server and zero versioned runtime layers.\n");
    } else {
        process.stdout.write(
            "Runtime architecture validation passed with migration debt: " +
            versionedLayers.length +
            " versioned server layers remain; target is 0 and the ratchet budget may only decrease.\n"
        );
    }
}
