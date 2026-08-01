"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");

const bootstrap = fs.readFileSync("deploy/appliance-bootstrap.sh", "utf8");
const publicInstall = fs.readFileSync("website/install", "utf8");

test("universal bootstrap installs on a clean host", () => {
    assert.match(bootstrap, /if \[\[ ! -e "\$INSTALL_DIR" \]\]/);
    assert.match(bootstrap, /fetch_and_exec appliance-install\.sh/);
    assert.match(bootstrap, /No existing installation detected/);
});

test("universal bootstrap migrates legacy and updates appliance installations", () => {
    assert.match(bootstrap, /APPLIANCE_READY=0/);
    assert.match(bootstrap, /docker-compose\.appliance\.yml/);
    assert.match(bootstrap, /appliance-restore-server\.js/);
    assert.match(bootstrap, /fetch_and_exec appliance-migrate\.sh/);
    assert.match(bootstrap, /Legacy SIRK Central detected/);
    assert.match(bootstrap, /Existing appliance requires an update/);
});

test("universal bootstrap is idempotent when current", () => {
    assert.match(bootstrap, /LOCAL_COMMIT.*TARGET_COMMIT/s);
    assert.match(bootstrap, /SIRK Central appliance is already current/);
    assert.match(bootstrap, /git ls-remote --exit-code/);
});

test("bootstrap validates identity and permits only HTTPS sources", () => {
    assert.match(bootstrap, /unexpected Git origin/);
    assert.match(bootstrap, /SIRK_REPO_URL must use HTTPS/);
    assert.match(bootstrap, /SIRK_RAW_BASE must use HTTPS/);
    assert.match(bootstrap, /--proto '=https' --tlsv1\.2/);
    assert.match(publicInstall, /deploy\/appliance-bootstrap\.sh/);
    assert.match(publicInstall, /--proto '=https' --tlsv1\.2/);
});

test("downloaded child scripts are removed after success or failure", () => {
    assert.match(bootstrap, /bash "\$temporary" \|\| status=\$\?/);
    assert.match(bootstrap, /rm -f -- "\$temporary"/);
    assert.match(bootstrap, /return "\$status"/);
});
