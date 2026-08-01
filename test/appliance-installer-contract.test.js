"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");

const installer = fs.readFileSync("deploy/appliance-install.sh", "utf8");
const bootstrap = fs.readFileSync("website/install", "utf8");
const configure = fs.readFileSync("scripts/configure-production.js", "utf8");

test("appliance installer asks only for the BreakGlass password", () => {
    assert.match(installer, /Break-Glass password:/);
    assert.match(installer, /Repeat password:/);
    assert.doesNotMatch(installer, /read[^\n]*(domain|email|username|timeout)/i);
    assert.match(installer, /SIRK_CENTRAL_DOMAIN:-central\.sirkportal\.com/);
    assert.match(installer, /SIRK_ADMIN_PASSWORD_FILE=\/run\/secrets\/breakglass-password/);
});

test("appliance installer works behind a curl pipe without reading secrets from stdin", () => {
    assert.match(installer, /<\/dev\/tty/);
    assert.match(installer, /mktemp \/root\/\.sirk-password/);
    assert.match(installer, /chmod 0600/);
    assert.match(installer, /unset PASSWORD/);
});

test("configuration accepts a protected password file and writes a one-time result", () => {
    assert.match(configure, /SIRK_ADMIN_PASSWORD_FILE/);
    assert.match(configure, /SIRK_INSTALL_RESULT_FILE/);
    assert.match(configure, /stat\.mode & 0o077/);
    assert.match(configure, /accessUrl/);
    assert.match(configure, /SIRK_AUDIT_INTEGRITY_KEY/);
});

test("public install endpoint downloads the universal dispatcher over strict HTTPS", () => {
    assert.match(bootstrap, /raw\.githubusercontent\.com\/Eris92\/SIRK-Central\/main\/deploy\/appliance-bootstrap\.sh/);
    assert.match(bootstrap, /--proto '=https'/);
    assert.match(bootstrap, /--tlsv1\.2/);
    assert.match(bootstrap, /exec bash/);
});
