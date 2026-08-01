"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const srcDir = path.join(root, "src");
const entry = path.join(srcDir, "server.js");
const forbiddenFiles = [
    "src/entry.js",
    "src/preload-api.js",
    "src/preload-hardening.js",
    "src/server-hardened.js",
    "src/server-production.js",
    "src/persistent-session-map.js",
    "src/portal-command-store-v2.js",
    "src/ticket-projection-store-v2.js",
    "src/approval-api.js",
    "src/audit-key-store.js",
    "src/system-health.js",
    "deploy/reset-admin-password.sh",
    "scripts/hash-password.js",
    "scripts/generate-access-key.js",
    "Dockerfile.portal-runtime",
    "docker-compose.portal-runtime.yml",
    "auth/hardened-server.js"
];
const forbiddenText = [
    "server-v15.js",
    "server-v1.js",
    "/api/approvals",
    "/api/settings/backup/run-v2",
    "SIRK_SESSION_HOURS",
    "portal-command-store-v2",
    "ticket-projection-store-v2",
    "auth/hardened-server.js"
];

function fail(message) {
    process.stderr.write("Runtime architecture validation failed: " + message + "\n");
    process.exitCode = 1;
}
function walk(directory, output = []) {
    if (!fs.existsSync(directory)) return output;
    for (const entryValue of fs.readdirSync(directory, { withFileTypes: true })) {
        const target = path.join(directory, entryValue.name);
        if (entryValue.isDirectory()) walk(target, output);
        else if (entryValue.isFile()) output.push(target);
    }
    return output;
}
function localDependency(fromFile, request) {
    if (!request.startsWith(".")) return null;
    const base = path.resolve(path.dirname(fromFile), request);
    for (const candidate of [base, base + ".js", path.join(base, "index.js")]) {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    }
    return null;
}
function graph(entryFile) {
    const visited = new Set();
    const pending = [entryFile];
    const pattern = /require\(\s*["']([^"']+)["']\s*\)/g;
    while (pending.length) {
        const file = path.resolve(pending.pop());
        if (visited.has(file)) continue;
        visited.add(file);
        const source = fs.readFileSync(file, "utf8");
        pattern.lastIndex = 0;
        let match;
        while ((match = pattern.exec(source)) !== null) {
            const dependency = localDependency(file, match[1]);
            if (dependency && dependency.startsWith(srcDir + path.sep)) pending.push(dependency);
        }
    }
    return visited;
}

if (!fs.existsSync(entry)) fail("canonical entry src/server.js is missing.");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
if (pkg.main !== "src/server.js") fail("package.json main must be src/server.js.");
if (String(pkg.scripts && pkg.scripts.start || "") !== "node src/server.js") fail("start script must use only src/server.js.");

const serverSource = fs.readFileSync(entry, "utf8");
if (/\boptions\.through\b|\bthrough\s*=/.test(serverSource)) {
    fail("src/server.js must always construct the complete runtime; staged module construction is forbidden.");
}
for (const file of walk(path.join(root, "test")).filter(value => value.endsWith(".js"))) {
    const source = fs.readFileSync(file, "utf8");
    if (/\bthrough\s*:/.test(source)) fail(path.relative(root, file) + " uses a staged runtime instead of the canonical runtime.");
}

for (const file of fs.readdirSync(srcDir)) {
    if (/^server-v\d+\.js$/.test(file)) fail("versioned server layer still exists: src/" + file);
}
for (const relative of forbiddenFiles) {
    if (fs.existsSync(path.join(root, relative))) fail("obsolete file still exists: " + relative);
}

const productionFiles = walk(srcDir).filter(file => file.endsWith(".js"));
const createServerOccurrences = productionFiles.reduce((count, file) => {
    const matches = fs.readFileSync(file, "utf8").match(/\bhttp\.createServer\s*\(/g);
    return count + (matches ? matches.length : 0);
}, 0);
if (createServerOccurrences !== 1) fail("Central must contain exactly one http.createServer(); found " + createServerOccurrences + ".");

for (const file of walk(path.join(srcDir, "modules")).filter(value => value.endsWith(".js"))) {
    const source = fs.readFileSync(file, "utf8");
    if (source.includes("require.main === module")) fail(path.relative(root, file) + " is an alternate entrypoint.");
    if (source.includes('listeners("request")') || /\binner(?:Handler)?\s*\(req,\s*res\)/.test(source)) {
        fail(path.relative(root, file) + " still uses recursive request-handler chaining.");
    }
}

const reachable = graph(entry);
for (const file of productionFiles) {
    if (!reachable.has(path.resolve(file))) fail("unreachable production source: " + path.relative(root, file));
}

for (const file of walk(root)) {
    const relative = path.relative(root, file);
    if (relative.startsWith("node_modules" + path.sep) || relative.startsWith(".git" + path.sep)) continue;
    if (!/\.(?:js|json|sh|ya?ml|md|html)$/.test(file)) continue;
    const source = fs.readFileSync(file, "utf8");
    for (const value of forbiddenText) {
        if (source.includes(value) && relative !== "scripts/validate-runtime-architecture.js") {
            fail(relative + " references retired contract: " + value);
        }
    }
}

if (!process.exitCode) {
    process.stdout.write("Runtime architecture validation passed: one server, flat modules, strict forward-only contracts and no unreachable source.\n");
}
