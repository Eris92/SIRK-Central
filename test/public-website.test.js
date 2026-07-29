"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const websitePath = path.join(__dirname, "..", "website", "index.html");
const html = fs.readFileSync(websitePath, "utf8");

test("public page presents the complete SIRK product family", () => {
    assert.match(html, /SIRK Central/);
    assert.match(html, /SIRK Portal/);
    assert.match(html, /SIRK Agent/);
    assert.match(html, /data-lang="pl"/);
    assert.match(html, /data-lang="en"/);
});

test("public page contains no customer-specific labels", () => {
    assert.doesNotMatch(html, /investa|pruszcz|kris-sirk-portal/i);
});

test("public page exposes no tenant-specific sirkportal.com hostnames", () => {
    const allowedHosts = new Set([
        "sirkportal.com",
        "auth.sirkportal.com",
        "central.sirkportal.com"
    ]);
    const discoveredHosts = [...html.matchAll(/\b(?:[a-z0-9-]+\.)*sirkportal\.com\b/gi)]
        .map((match) => match[0].toLowerCase());

    for (const hostname of discoveredHosts) {
        assert.equal(allowedHosts.has(hostname), true, "unexpected public hostname: " + hostname);
    }
});
