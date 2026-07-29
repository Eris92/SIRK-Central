"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const installer = fs.readFileSync(
    path.join(__dirname, "..", "deploy", "install.sh"),
    "utf8"
);

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
