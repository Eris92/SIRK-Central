"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");

const overlay = fs.readFileSync("docker-compose.appliance.yml", "utf8");
const installer = fs.readFileSync("deploy/appliance-install.sh", "utf8");
const updater = fs.readFileSync("deploy/appliance-web-update.sh", "utf8");
const baseCompose = fs.readFileSync("docker-compose.yml", "utf8");

function serviceBlock(source, service, nextService) {
    const start = source.indexOf("  " + service + ":");
    assert.notEqual(start, -1, "missing service " + service);
    const end = nextService ? source.indexOf("\n  " + nextService + ":", start + 1) : source.length;
    return source.slice(start, end < 0 ? source.length : end);
}

test("appliance overlay enables the internal updater without publishing a host port", () => {
    assert.match(overlay, /updater:\n\s+profiles: !reset \[\]/);
    assert.match(overlay, /restart: unless-stopped/);
    assert.match(overlay, /SIRK_UPDATER_SCRIPT: \/opt\/sirk-central\/deploy\/appliance-web-update\.sh/);

    const updaterBase = serviceBlock(baseCompose, "updater", "backup-manager");
    assert.doesNotMatch(updaterBase, /\n\s+ports:/);
    assert.match(updaterBase, /\/var\/run\/docker\.sock:\/var\/run\/docker\.sock/);
});

test("gateway waits for the internal worker and remains the only Central operations target", () => {
    assert.match(overlay, /updater-gateway:\n\s+depends_on:\n\s+updater:\n\s+condition: service_healthy/);
    assert.match(baseCompose, /SIRK_UPDATER_ORIGIN: http:\/\/updater-gateway:8092/);
    assert.match(baseCompose, /SIRK_UPDATER_ALLOWED_HOSTS: updater-gateway/);
});

test("one-line installer starts the full web-managed appliance", () => {
    assert.match(installer, /docker-compose\.appliance\.yml/);
    assert.match(installer, /SERVICES=\(central auth updater updater-gateway backup-manager caddy\)/);
    assert.match(installer, /Updates, backups, restore and administration are available in the web UI/);
    assert.doesNotMatch(installer, /maintenance-up\.sh/);
});

test("web update schedules a safe worker refresh after reporting completion", () => {
    assert.match(updater, /bash "\$\{INSTALL_DIR\}\/deploy\/web-update\.sh"/);
    assert.match(updater, /nohup \/usr\/bin\/env bash -c/);
    assert.match(updater, /sleep 3/);
    assert.match(updater, /--force-recreate updater updater-gateway/);
});
