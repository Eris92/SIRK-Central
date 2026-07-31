"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const canonicalEntry = path.join(root, "src", "server-v15.js");
const selfPath = path.resolve(__filename);
const forbiddenPaths = [
    "src/entry.js",
    "src/server.js",
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
    process.stderr.write("Legacy runtime validation failed: " + message + "\n");
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

if (!fs.existsSync(canonicalEntry)) fail("canonical runtime src/server-v15.js is missing.");

for (const relativePath of forbiddenPaths) {
    if (fs.existsSync(path.join(root, relativePath))) fail("forbidden legacy file still exists: " + relativePath);
}

const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
if (packageJson.main !== "src/server-v15.js") fail("package.json main is not src/server-v15.js.");
if (!String(packageJson.scripts && packageJson.scripts.start || "").includes("src/server-v15.js")) fail("start script does not use src/server-v15.js.");
for (const scriptName of forbiddenPackageScripts) {
    if (packageJson.scripts && packageJson.scripts[scriptName]) fail("package.json still exposes obsolete script: " + scriptName);
}

const runtimeGraph = fs.existsSync(canonicalEntry) ? collectRuntimeGraph(canonicalEntry) : new Set();
for (let version = 1; version <= 14; version += 1) {
    const layer = path.join(root, "src", "server-v" + version + ".js");
    if (!runtimeGraph.has(layer)) fail("active runtime layer is not reachable from v15: src/server-v" + version + ".js");
}

for (const fileName of fs.readdirSync(path.join(root, "src"))) {
    if (!/^server(?:-.*)?\.js$/.test(fileName)) continue;
    const absolute = path.join(root, "src", fileName);
    if (!runtimeGraph.has(absolute)) fail("unreachable alternate server implementation: src/" + fileName);
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
    process.stdout.write("Legacy runtime validation passed: one canonical runtime and no obsolete secret helpers.\n");
}
