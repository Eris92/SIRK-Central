"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");

function source(path) {
    return fs.readFileSync(path, "utf8");
}

test("Caddy hides the internal SSO logout route from the public Central origin", () => {
    const caddy = source("deploy/caddy/Caddyfile");
    const matcher = caddy.indexOf("@internalSsoLogout path /auth/sso/frontchannel-logout");
    const response = caddy.indexOf("respond @internalSsoLogout 404");
    const proxy = caddy.indexOf("reverse_proxy central:8080", matcher);

    assert.notEqual(matcher, -1);
    assert.notEqual(response, -1);
    assert.notEqual(proxy, -1);
    assert.ok(matcher < response && response < proxy, "The internal route must be rejected before reverse_proxy.");
});

test("Compose mounts a dedicated Caddy directory to survive Git file replacement", () => {
    const compose = source("docker-compose.yml");
    assert.match(compose, /\.\/deploy\/caddy:\/etc\/caddy:ro/);
    assert.doesNotMatch(compose, /\.\/deploy\/Caddyfile:\/etc\/caddy\/Caddyfile:ro/);
});

test("VPS acceptance validates and reloads the mounted Caddy configuration", () => {
    const acceptance = source("deploy/acceptance-test.sh");
    const validate = acceptance.indexOf("caddy validate --config /etc/caddy/Caddyfile");
    const reload = acceptance.indexOf("caddy reload --config /etc/caddy/Caddyfile");
    const externalCheck = acceptance.indexOf("Internal SSO logout route is externally reachable");

    assert.notEqual(validate, -1);
    assert.notEqual(reload, -1);
    assert.notEqual(externalCheck, -1);
    assert.ok(validate < reload && reload < externalCheck, "Caddy must be reloaded before live edge checks.");
});

test("Web updater recreates Caddy as part of the base deployment", () => {
    const updater = source("deploy/web-update.sh");
    assert.match(updater, /BASE_SERVICES=\([^\n]*caddy\)/);
    assert.match(updater, /compose up -d --force-recreate --remove-orphans "\$\{BASE_SERVICES\[@\]\}"/);
});
