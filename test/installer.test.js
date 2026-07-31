"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const read = relative => fs.readFileSync(path.join(root, relative), "utf8");
const installer = read("deploy/install.sh");
const dockerfile = read("Dockerfile");
const resetBreakGlass = read("deploy/reset-breakglass-password.sh");
const rotateAccessKey = read("deploy/rotate-access-key.sh");

test("clean installer uses only the canonical v15 stack", () => {
    assert.match(installer, /docker-compose\.yml/);
    assert.match(installer, /docker-compose\.portal-runtime\.yml/);
    assert.match(installer, /SERVICES=\(central auth updater-gateway backup-manager caddy\)/);
    assert.match(installer, /ps -q updater/);
    assert.match(installer, /node scripts\/configure-production\.js/);
    assert.match(installer, /--user 0:0/);
    assert.match(installer, /--volume "\$\{INSTALL_DIR\}:\/config"/);
    assert.doesNotMatch(installer, /ADMIN_PASSWORD_HASH=/);
});

test("clean installer validates and protects generated configuration", () => {
    assert.match(installer, /\[\[ -s \.env \]\] \|\| die "configuration file was not created"/);
    assert.match(installer, /chmod 0600 \.env/);
    assert.match(installer, /"\$\{COMPOSE\[@\]\}" config >\/dev\/null/);
    assert.match(installer, /^umask 022$/m);
});

test("container image exposes only the canonical runtime", () => {
    assert.match(dockerfile, /CMD \["node", "src\/server-v15\.js"\]/);
    assert.match(dockerfile, /chown -R node:node \/app \/var\/lib\/sirk-central/);
    assert.match(dockerfile, /chmod -R u=rwX,g=rX,o=rX \/app/);
    assert.match(dockerfile, /USER node/);
    assert.doesNotMatch(dockerfile, /src\/entry\.js|src\/server\.js/);
});

test("BreakGlass password reset is offline transactional and revokes sessions", () => {
    assert.match(resetBreakGlass, /set -Eeuo pipefail/);
    assert.match(resetBreakGlass, /docker-compose\.portal-runtime\.yml/);
    assert.match(resetBreakGlass, /apply-emergency-security-reset\.js/);
    assert.match(resetBreakGlass, /SIRK_EMERGENCY_PASSWORD_HASH/);
    assert.match(resetBreakGlass, /stop -t 30 central/);
    assert.match(resetBreakGlass, /State\.Health/);
    assert.match(resetBreakGlass, /ps -q updater/);
    assert.doesNotMatch(resetBreakGlass, /configure-production\.js/);
});

test("access key rotation is offline transactional and shows the key once", () => {
    assert.match(rotateAccessKey, /set -Eeuo pipefail/);
    assert.match(rotateAccessKey, /docker-compose\.portal-runtime\.yml/);
    assert.match(rotateAccessKey, /randomToken, hashAccessKey/);
    assert.match(rotateAccessKey, /apply-emergency-security-reset\.js/);
    assert.match(rotateAccessKey, /SIRK_EMERGENCY_ACCESS_KEY_HASH/);
    assert.match(rotateAccessKey, /stop -t 30 central/);
    assert.match(rotateAccessKey, /State\.Health/);
    assert.match(rotateAccessKey, /ps -q updater/);
    assert.match(rotateAccessKey, /shown once/);
    assert.doesNotMatch(rotateAccessKey, /configure-production\.js/);
});
