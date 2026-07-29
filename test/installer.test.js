"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const installer = fs.readFileSync(path.join(root, "deploy", "install.sh"), "utf8");
const dockerfile = fs.readFileSync(path.join(root, "Dockerfile"), "utf8");

test("clean installer delegates secret generation to the interactive configurator", () => {
    assert.match(installer, /node scripts\/configure-production\.js/);
    assert.match(installer, /--user 0:0/);
    assert.match(installer, /--volume "\$\{INSTALL_DIR\}:\/config"/);
    assert.doesNotMatch(installer, /ADMIN_PASSWORD_HASH=/);
    assert.doesNotMatch(installer, /printf '%s' "\$ADMIN_PASSWORD" \| docker run/);
});

test("clean installer verifies that .env was created before starting Compose", () => {
    assert.match(installer, /test -s \.env \|\| die "configuration file was not created"/);
    assert.match(installer, /docker compose config >\/dev\/null/);
});

test("source checkout uses normal permissions while .env is explicitly protected", () => {
    assert.match(installer, /^umask 022$/m);
    assert.match(installer, /chmod 0600 \.env/);
});

test("container image normalizes ownership and read permissions before USER node", () => {
    assert.match(dockerfile, /chown -R node:node \/app \/var\/lib\/sirk-central/);
    assert.match(dockerfile, /chmod -R u=rwX,g=rX,o=rX \/app/);
    assert.match(dockerfile, /USER node/);
});
